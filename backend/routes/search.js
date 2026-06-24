/* ═══════════════════════════════════════════════════════
   INF-03 — Search Engine (Глобальный поиск)
   Подключается как /api/search (mount: shop-api.js → app.use('/api/search', ...))

   Покрывает спеку tz_modules/v2/inf_03_search_engine.md:
   - 5.1 Unified Search: GET / (глобальный по всем сущностям), GET /:index
     (поиск в одном индексе с фасетами/фильтрами/highlight/сортировкой/пагинацией),
     GET /autocomplete (typeahead от 2 символов, группировка с иконками),
     POST /multi (мультипоиск по нескольким индексам);
   - 3.2 Query Processor: подстановка синонимов перед запросом, fuzzy (pg_trgm
     similarity), highlight <em>, фасеты, сортировка, пагинация;
   - 5.2 Index Management: CRUD search_indexes + reindex (наживо пересчитывает
     documents_count/index_size_mb по реальным таблицам) + stats;
   - 5.3 Documents: add/upsert/delete — graceful (PG-индексы строятся из живых
     данных, отдельного document-store нет → 202 accepted + лог);
   - 5.4 Synonyms: CRUD групп синонимов + импорт/экспорт CSV;
   - 5.5 Analytics: top-queries, zero-results, ctr, summary + лог запросов и кликов.

   Движок: PostgreSQL FTS (ILIKE + pg_trgm similarity). Внешний Meilisearch/Elastic
   по спеке опционален — здесь работаем по живым данным CRM без внешнего сервиса.

   Права: search.read (085_search_permissions.sql). owner "*" покрывает всё.
   Мультитенантность: tenant_id там, где колонка есть (RLS + current_tenant_id()).
   Таблицы реестра/синонимов/аналитики: миграция 178_search_engine_v2.sql.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const one = (sql, p = []) => q(sql, p).then(r => r[0] || null);
const dbErr = (e) => (process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message);

// только цифры (для поиска по телефону без учёта +380 / пробелов / скобок)
function digits(s) { return String(s || '').replace(/\D+/g, ''); }
const norm = (s) => String(s || '').trim().toLowerCase().slice(0, 256);

// все индексируемые сущности + иконки/метки для автокомплита и фасетов
const ALL_TYPES = ['clients', 'services', 'masters', 'products', 'appointments', 'orders', 'gift_certificates', 'subscriptions'];
const ICONS = {
  clients: 'person', services: 'scissors', masters: 'badge', products: 'shopping_bag',
  appointments: 'event', orders: 'receipt', gift_certificates: 'card_giftcard', subscriptions: 'loyalty',
};
const FILTERABLE = {
  clients: ['source'], services: ['category', 'active'], masters: ['specialty', 'active'],
  products: ['active'], appointments: ['status', 'master_id', 'service_id'], orders: ['status', 'payment_method'],
  gift_certificates: ['status', 'type'], subscriptions: ['status'],
};

router.use(requirePerm('search.read'));

/* ── helpers ─────────────────────────────────────────────────────────────── */

// HTML-escape + подсветка совпадения <em>…</em> (для UI highlight, спека 8.2)
function highlight(text, raw) {
  const s = String(text == null ? '' : text);
  const esc = s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  if (!raw) return esc;
  try {
    const re = new RegExp('(' + raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
    return esc.replace(re, '<em>$1</em>');
  } catch { return esc; }
}

// Расширение запроса синонимами: возвращает список вариантов (включая исходный).
// both → все слова группы; one-way → только если запрос == первое слово группы.
let _synCache = { at: 0, rows: null };
async function synonymVariants(raw) {
  const base = norm(raw);
  if (base.length < 2) return [base].filter(Boolean);
  const now = Date.now();
  if (!_synCache.rows || now - _synCache.at > 60000) {
    try {
      _synCache = {
        at: now,
        rows: await q(`SELECT words, direction FROM search_synonyms WHERE is_active = TRUE`),
      };
    } catch { _synCache = { at: now, rows: [] }; }
  }
  const out = new Set([base]);
  for (const r of _synCache.rows || []) {
    const words = (r.words || []).map(w => String(w).toLowerCase());
    if (!words.length) continue;
    const hit = words.some(w => w === base || base.includes(w) || w.includes(base));
    if (!hit) continue;
    if (r.direction === 'one-way' && words[0] !== base) continue;
    for (const w of words) out.add(w);
  }
  return [...out].slice(0, 12);
}

// Построить OR-условие ILIKE по нескольким колонкам и нескольким вариантам запроса.
// Возвращает { clause, params } с плейсхолдерами начиная с $startIdx.
function buildLike(cols, variants, startIdx) {
  const params = [];
  const ors = [];
  let i = startIdx;
  for (const v of variants) {
    const p = `%${v}%`;
    params.push(p);
    const pIdx = i++;
    ors.push('(' + cols.map(c => `${c} ILIKE $${pIdx}`).join(' OR ') + ')');
  }
  return { clause: ors.length ? '(' + ors.join(' OR ') + ')' : 'TRUE', params, nextIdx: i };
}

// Один индекс → массив hits. Унифицированный shape: {type,id,title,subtitle,sim,data}.
// raw — исходный запрос, variants — расширенные синонимами, limit/offset, filters.
async function searchEntity(type, raw, variants, limit, offset = 0, filters = {}) {
  const like = `%${raw}%`;
  const prefix = `${raw}%`;
  const dig = digits(raw);
  const digLike = dig ? `%${dig}%` : null;

  if (type === 'clients') {
    const lk = buildLike(['name', 'email', "coalesce(notes,'')", "array_to_string(coalesce(tags,'{}'),' ')"], variants, 4);
    const rows = await q(`
      SELECT id, name, phone, email, total_spent, last_visit_at,
             GREATEST(similarity(coalesce(name,''), $1), 0) AS sim
      FROM clients
      WHERE tenant_id = current_tenant_id()
        AND ( ${lk.clause}
           OR ($3::text IS NOT NULL AND regexp_replace(coalesce(phone,''),'\\D','','g') ILIKE $3) )
      ORDER BY (name ILIKE $2) DESC, sim DESC, last_visit_at DESC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `, [raw, prefix, digLike, ...lk.params]);
    return rows.map(r => ({ type, id: r.id, title: r.name, subtitle: r.phone || r.email || '', sim: +r.sim || 0, data: r }));
  }

  if (type === 'services') {
    const lk = buildLike(['name', "coalesce(description,'')", "coalesce(category,'')"], variants, 3);
    const fcat = filters.category ? `AND coalesce(category,'') = $${3 + lk.params.length}` : '';
    const params = [raw, prefix, ...lk.params];
    if (filters.category) params.push(String(filters.category));
    const rows = await q(`
      SELECT id, name, category, price, duration_min, active,
             GREATEST(similarity(coalesce(name,''), $1), 0) AS sim
      FROM services
      WHERE ( ${lk.clause} ) ${fcat}
      ORDER BY (name ILIKE $2) DESC, sim DESC
      LIMIT ${limit} OFFSET ${offset}
    `, params);
    return rows.map(r => ({ type, id: r.id, title: r.name, subtitle: r.category || '', sim: +r.sim || 0, data: r }));
  }

  if (type === 'masters') {
    const lk = buildLike(['name', "coalesce(specialty,'')", "coalesce(bio,'')"], variants, 4);
    const rows = await q(`
      SELECT id, name, phone, specialty, active,
             GREATEST(similarity(coalesce(name,''), $1), 0) AS sim
      FROM masters
      WHERE ( ${lk.clause}
           OR ($3::text IS NOT NULL AND regexp_replace(coalesce(phone,''),'\\D','','g') ILIKE $3) )
      ORDER BY (name ILIKE $2) DESC, sim DESC, active DESC
      LIMIT ${limit} OFFSET ${offset}
    `, [raw, prefix, digLike, ...lk.params]);
    return rows.map(r => ({ type, id: r.id, title: r.name, subtitle: r.specialty || '', sim: +r.sim || 0, data: r }));
  }

  if (type === 'products') {
    const lk = buildLike(['name', "coalesce(description,'')", 'id'], variants, 3);
    const rows = await q(`
      SELECT id, name, active,
             GREATEST(similarity(coalesce(name,''), $1), 0) AS sim
      FROM products
      WHERE ( ${lk.clause} )
      ORDER BY (name ILIKE $2) DESC, sim DESC
      LIMIT ${limit} OFFSET ${offset}
    `, [raw, prefix, ...lk.params]);
    return rows.map(r => ({ type, id: r.id, title: r.name, subtitle: '', sim: +r.sim || 0, data: r }));
  }

  if (type === 'appointments') {
    const lk = buildLike(["coalesce(a.notes,'')", "coalesce(c.name,'')"], variants, 3);
    const status = filters.status ? `AND a.status = $${3 + lk.params.length}` : '';
    const params = [raw, digLike, ...lk.params];
    if (filters.status) params.push(String(filters.status));
    const rows = await q(`
      SELECT a.id, a.starts_at, a.status, a.price,
             c.name AS client_name, c.phone AS client_phone,
             m.name AS master_name, s.name AS service_name
      FROM appointments a
      LEFT JOIN clients c ON c.id = a.client_id
      LEFT JOIN masters m ON m.id = a.master_id
      LEFT JOIN services s ON s.id = a.service_id
      WHERE a.tenant_id = current_tenant_id()
        AND ( ${lk.clause}
           OR ($2::text IS NOT NULL AND regexp_replace(coalesce(c.phone,''),'\\D','','g') ILIKE $2) ) ${status}
      ORDER BY a.starts_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `, params);
    return rows.map(r => ({
      type, id: r.id, title: `Запис #${r.id}`,
      subtitle: [r.client_name, r.service_name].filter(Boolean).join(' · '), sim: 0, data: r,
    }));
  }

  if (type === 'orders') {
    const orderId = /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
    const lk = buildLike(["o.notes", "c.name"], variants, 3);
    const status = filters.status ? `AND o.status = $${3 + lk.params.length}` : '';
    const params = [orderId, digLike, ...lk.params];
    if (filters.status) params.push(String(filters.status));
    const rows = await q(`
      SELECT o.id, o.total, o.status, o.payment_method, o.created_at,
             c.name AS client_name, c.phone AS client_phone
      FROM orders o
      LEFT JOIN clients c ON c.id = o.client_id
      WHERE o.tenant_id = current_tenant_id()
        AND ( ($1::int IS NOT NULL AND o.id = $1)
           OR ${lk.clause}
           OR ($2::text IS NOT NULL AND regexp_replace(coalesce(c.phone,''),'\\D','','g') ILIKE $2) ) ${status}
      ORDER BY o.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `, params);
    return rows.map(r => ({ type, id: r.id, title: `Замовлення #${r.id}`, subtitle: r.client_name || '', sim: 0, data: r }));
  }

  if (type === 'gift_certificates') {
    const lk = buildLike(['code', 'buyer_name', 'recipient_name'], variants, 4);
    const rows = await q(`
      SELECT id, code, type, status, remaining_amount, buyer_name, buyer_phone,
             recipient_name, valid_until, created_at
      FROM gift_certificates
      WHERE ( ${lk.clause}
           OR ($3::text IS NOT NULL AND regexp_replace(coalesce(buyer_phone,''),'\\D','','g') ILIKE $3)
           OR ($3::text IS NOT NULL AND regexp_replace(coalesce(recipient_phone,''),'\\D','','g') ILIKE $3) )
      ORDER BY (code ILIKE $2) DESC, created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `, [raw, prefix, digLike, ...lk.params]);
    return rows.map(r => ({ type, id: r.id, title: `Сертифікат ${r.code}`, subtitle: r.buyer_name || '', sim: 0, data: r }));
  }

  if (type === 'subscriptions') {
    const lk = buildLike(['s.subscription_number', 'c.name'], variants, 3);
    const rows = await q(`
      SELECT s.id, s.subscription_number, s.status, s.visits_remaining,
             s.expires_at, c.name AS client_name, c.phone AS client_phone
      FROM subscriptions s
      LEFT JOIN clients c ON c.id = s.client_id
      WHERE ( ${lk.clause}
           OR ($2::text IS NOT NULL AND regexp_replace(coalesce(c.phone,''),'\\D','','g') ILIKE $2) )
      ORDER BY s.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `, [raw, digLike, ...lk.params]);
    return rows.map(r => ({ type, id: r.id, title: `Абонемент ${r.subscription_number}`, subtitle: r.client_name || '', sim: 0, data: r }));
  }

  return [];
}

// Лог поискового запроса в аналитику (fire-and-forget, не валит ответ).
function logQuery(req, { query, index_name = 'all', results_count = 0, response_time_ms = 0, filters = null }) {
  const raw = String(query || '');
  if (raw.trim().length < 2) return;
  q(`INSERT INTO search_analytics
       (user_id, query_text, query_normalized, index_name, results_count, response_time_ms, filters_used)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [req.user?.id || null, raw.slice(0, 256), norm(raw), index_name, results_count, Math.round(response_time_ms),
     filters ? JSON.stringify(filters) : null]
  ).catch(() => {});
}

/* ═══════════════ 5.1 UNIFIED SEARCH ═══════════════ */

/* GET /api/search?q=...&types=clients,services&limit=8&flat=0
   Глобальный поиск по всем (или указанным) индексам. Группы + опц. плоский список. */
router.get('/', async (req, res) => {
  const t0 = Date.now();
  try {
    const raw = String(req.query.q || '').trim();
    if (raw.length < 2) return res.json({ query: raw, groups: {}, results: [], total: 0, processing_time_ms: 0 });

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);
    const want = req.query.types
      ? String(req.query.types).split(',').map(s => s.trim()).filter(t => ALL_TYPES.includes(t))
      : ALL_TYPES;
    const variants = await synonymVariants(raw);

    const groups = {};
    await Promise.all(want.map(async (type) => {
      try { groups[type] = await searchEntity(type, raw, variants, limit); }
      catch (e) { groups[type] = []; if (process.env.NODE_ENV !== 'production') groups[type]._err = e.message; }
    }));

    let total = 0;
    const results = [];
    for (const [type, rows] of Object.entries(groups)) {
      total += rows.length;
      if (req.query.flat === '1') {
        for (const r of rows) results.push({ type, id: r.id, title: r.title, subtitle: r.subtitle, sim: r.sim, data: r.data });
      }
    }
    if (req.query.flat === '1') results.sort((a, b) => b.sim - a.sim);

    const ms = Date.now() - t0;
    logQuery(req, { query: raw, index_name: 'all', results_count: total, response_time_ms: ms });
    res.json({ query: raw, groups, results, total, processing_time_ms: ms });
  } catch (e) {
    console.error('[search] error:', e.message);
    res.status(500).json({ error: 'search_failed', detail: dbErr(e) });
  }
});

/* GET /api/search/autocomplete?q=..&indexes=clients,services&limit=5
   Typeahead: до `limit` подсказок на индекс, группировка, иконки типа. */
router.get('/autocomplete', async (req, res) => {
  const t0 = Date.now();
  try {
    const raw = String(req.query.q || '').trim();
    if (raw.length < 2) return res.json({ suggestions: [] });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 10);
    const want = req.query.indexes
      ? String(req.query.indexes).split(',').map(s => s.trim()).filter(t => ALL_TYPES.includes(t))
      : ['clients', 'services', 'products'];
    const variants = await synonymVariants(raw);

    const suggestions = [];
    await Promise.all(want.map(async (type) => {
      try {
        const rows = await searchEntity(type, raw, variants, limit);
        for (const r of rows) suggestions.push({
          text: r.title, index: type, entity_id: r.id, subtitle: r.subtitle || '', icon: ICONS[type] || 'search', score: r.sim,
        });
      } catch (_) { /* индекс мог отсутствовать */ }
    }));
    suggestions.sort((a, b) => (b.score || 0) - (a.score || 0));

    logQuery(req, { query: raw, index_name: 'autocomplete', results_count: suggestions.length, response_time_ms: Date.now() - t0 });
    res.json({ suggestions, processing_time_ms: Date.now() - t0 });
  } catch (e) {
    console.error('[search/autocomplete]', e.message);
    res.status(500).json({ error: 'autocomplete_failed', detail: dbErr(e) });
  }
});

/* POST /api/search/multi  { queries: [{ index, q, filters?, limit? }] } */
router.post('/multi', async (req, res) => {
  const t0 = Date.now();
  try {
    const queries = Array.isArray(req.body?.queries) ? req.body.queries.slice(0, 10) : [];
    const results = [];
    for (const item of queries) {
      const type = String(item.index || '').trim();
      if (!ALL_TYPES.includes(type)) { results.push({ index: type, hits: [], total: 0, error: 'unknown_index' }); continue; }
      const raw = String(item.q || '').trim();
      if (raw.length < 2) { results.push({ index: type, hits: [], total: 0 }); continue; }
      const limit = Math.min(Math.max(parseInt(item.limit, 10) || 10, 1), 50);
      const variants = await synonymVariants(raw);
      const hits = await searchEntity(type, raw, variants, limit, 0, item.filters || {});
      results.push({ index: type, hits, total: hits.length });
    }
    res.json({ results, processing_time_ms: Date.now() - t0 });
  } catch (e) {
    console.error('[search/multi]', e.message);
    res.status(500).json({ error: 'multi_failed', detail: dbErr(e) });
  }
});

// Подсчёт фасетов по filterable-полям совпавших записей (только реализуемые в SQL).
async function computeFacets(type, raw, variants) {
  const facets = {};
  try {
    const like = `%${raw}%`;
    if (type === 'services') {
      const lk = buildLike(['name', "coalesce(description,'')", "coalesce(category,'')"], variants, 1);
      const rows = await q(`SELECT coalesce(category,'(без категорії)') v, COUNT(*) c FROM services
        WHERE ( ${lk.clause} ) GROUP BY 1 ORDER BY c DESC LIMIT 20`, lk.params);
      facets.category = Object.fromEntries(rows.map(r => [r.v, Number(r.c)]));
    } else if (type === 'masters') {
      const lk = buildLike(['name', "coalesce(specialty,'')", "coalesce(bio,'')"], variants, 1);
      const rows = await q(`SELECT coalesce(specialty,'(без спеціалізації)') v, COUNT(*) c FROM masters
        WHERE ( ${lk.clause} ) GROUP BY 1 ORDER BY c DESC LIMIT 20`, lk.params);
      facets.specialty = Object.fromEntries(rows.map(r => [r.v, Number(r.c)]));
    } else if (type === 'appointments') {
      const rows = await q(`SELECT coalesce(status,'?') v, COUNT(*) c FROM appointments a
        WHERE a.tenant_id = current_tenant_id() AND coalesce(a.notes,'') ILIKE $1 GROUP BY 1 ORDER BY c DESC`, [like]);
      facets.status = Object.fromEntries(rows.map(r => [r.v, Number(r.c)]));
    } else if (type === 'orders') {
      const rows = await q(`SELECT coalesce(status,'?') v, COUNT(*) c FROM orders o
        WHERE o.tenant_id = current_tenant_id() AND coalesce(o.notes,'') ILIKE $1 GROUP BY 1 ORDER BY c DESC`, [like]);
      facets.status = Object.fromEntries(rows.map(r => [r.v, Number(r.c)]));
    }
  } catch (_) { /* фасеты best-effort */ }
  return facets;
}

/* ═══════════════ 5.2 INDEX MANAGEMENT ═══════════════ */

router.get('/indexes', async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM search_indexes WHERE tenant_id = current_tenant_id() ORDER BY index_name`);
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: 'list_failed', detail: dbErr(e) }); }
});

router.post('/indexes', async (req, res) => {
  try {
    const { index_name, entity_type, field_mapping, settings } = req.body || {};
    if (!index_name || !entity_type) return res.status(400).json({ error: 'index_name and entity_type required' });
    const row = await one(`
      INSERT INTO search_indexes (index_name, entity_type, field_mapping, settings)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (tenant_id, index_name) DO NOTHING
      RETURNING *`,
      [String(index_name).slice(0, 64), String(entity_type).slice(0, 64),
       JSON.stringify(field_mapping || {}), JSON.stringify(settings || {})]);
    if (!row) return res.status(409).json({ error: 'index_exists' });
    logAction({ user: req.user, action: 'search.index.create', entity: 'search_index', entity_id: row.id, ip: req.ip });
    res.status(201).json({ data: row });
  } catch (e) { res.status(500).json({ error: 'create_failed', detail: dbErr(e) }); }
});

router.get('/indexes/:id', async (req, res) => {
  try {
    const row = await one(`SELECT * FROM search_indexes WHERE id = $1 AND tenant_id = current_tenant_id()`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ data: row });
  } catch (e) { res.status(500).json({ error: 'get_failed', detail: dbErr(e) }); }
});

router.put('/indexes/:id', async (req, res) => {
  try {
    const { field_mapping, settings, status } = req.body || {};
    const row = await one(`
      UPDATE search_indexes SET
        field_mapping = COALESCE($2, field_mapping),
        settings      = COALESCE($3, settings),
        status        = COALESCE($4, status),
        updated_at    = NOW()
      WHERE id = $1 AND tenant_id = current_tenant_id()
      RETURNING *`,
      [req.params.id,
       field_mapping !== undefined ? JSON.stringify(field_mapping) : null,
       settings !== undefined ? JSON.stringify(settings) : null,
       status || null]);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ data: row });
  } catch (e) { res.status(500).json({ error: 'update_failed', detail: dbErr(e) }); }
});

router.delete('/indexes/:id', async (req, res) => {
  try {
    const row = await one(`DELETE FROM search_indexes WHERE id = $1 AND tenant_id = current_tenant_id() AND is_system = FALSE RETURNING id`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not_found_or_system' });
    logAction({ user: req.user, action: 'search.index.delete', entity: 'search_index', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'delete_failed', detail: dbErr(e) }); }
});

// Маппинг index_name → реальная таблица/условие для пересчёта метрик.
const COUNT_SQL = {
  clients:           `SELECT COUNT(*) c FROM clients WHERE tenant_id = current_tenant_id()`,
  services:          `SELECT COUNT(*) c FROM services`,
  masters:           `SELECT COUNT(*) c FROM masters`,
  products:          `SELECT COUNT(*) c FROM products`,
  appointments:      `SELECT COUNT(*) c FROM appointments WHERE tenant_id = current_tenant_id()`,
  orders:            `SELECT COUNT(*) c FROM orders WHERE tenant_id = current_tenant_id()`,
  gift_certificates: `SELECT COUNT(*) c FROM gift_certificates`,
  subscriptions:     `SELECT COUNT(*) c FROM subscriptions`,
};

/* POST /indexes/:id/reindex — наживо пересчитывает documents_count/index_size_mb
   из реальных таблиц (PG-движок: «индекс» = живые данные + trgm). 202 accepted. */
router.post('/indexes/:id/reindex', async (req, res) => {
  try {
    const idx = await one(`SELECT * FROM search_indexes WHERE id = $1 AND tenant_id = current_tenant_id()`, [req.params.id]);
    if (!idx) return res.status(404).json({ error: 'not_found' });
    const countSql = COUNT_SQL[idx.index_name];
    let docs = 0, sizeMb = 0;
    if (countSql) {
      try { docs = Number((await one(countSql))?.c || 0); } catch (_) {}
      try {
        const sz = await one(`SELECT pg_total_relation_size($1::regclass) b`, [idx.index_name]);
        sizeMb = sz ? +(Number(sz.b) / 1048576).toFixed(2) : 0;
      } catch (_) {}
    }
    await q(`UPDATE search_indexes SET documents_count=$2, index_size_mb=$3, last_indexed_at=NOW(), status='active', updated_at=NOW()
             WHERE id=$1`, [idx.id, docs, sizeMb]);
    logAction({ user: req.user, action: 'search.index.reindex', entity: 'search_index', entity_id: idx.id, ip: req.ip, meta: { docs } });
    res.status(202).json({ task_id: `reindex-${idx.id}-${Date.now()}`, status: 'enqueued', documents_count: docs, index_size_mb: sizeMb });
  } catch (e) { res.status(500).json({ error: 'reindex_failed', detail: dbErr(e) }); }
});

router.get('/indexes/:id/stats', async (req, res) => {
  try {
    const idx = await one(`SELECT * FROM search_indexes WHERE id = $1 AND tenant_id = current_tenant_id()`, [req.params.id]);
    if (!idx) return res.status(404).json({ error: 'not_found' });
    let live = idx.documents_count;
    const countSql = COUNT_SQL[idx.index_name];
    if (countSql) { try { live = Number((await one(countSql))?.c || 0); } catch (_) {} }
    res.json({ data: {
      index_name: idx.index_name, status: idx.status,
      documents_count: idx.documents_count, live_documents_count: live,
      index_size_mb: idx.index_size_mb, last_indexed_at: idx.last_indexed_at,
    } });
  } catch (e) { res.status(500).json({ error: 'stats_failed', detail: dbErr(e) }); }
});

/* ═══════════════ 5.3 DOCUMENTS (graceful) ═══════════════
   PG-движок индексирует живые данные напрямую — отдельного document-store нет.
   Эндпоинты приняты для совместимости с контрактом спеки: помечаем индекс
   как требующий reindex и возвращаем 202. */
router.post('/indexes/:id/documents', async (req, res) => {
  try {
    const idx = await one(`SELECT id FROM search_indexes WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!idx) return res.status(404).json({ error: 'not_found' });
    const docs = Array.isArray(req.body?.documents) ? req.body.documents.length : 0;
    await q(`UPDATE search_indexes SET status='reindexing', updated_at=NOW() WHERE id=$1`, [idx.id]);
    res.status(202).json({ task_id: `index-${idx.id}-${Date.now()}`, indexed: docs, note: 'pg_live_index: triggers reindex of live data' });
  } catch (e) { res.status(500).json({ error: 'index_docs_failed', detail: dbErr(e) }); }
});

router.delete('/indexes/:id/documents/:docId', async (req, res) => {
  try {
    const idx = await one(`SELECT id FROM search_indexes WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!idx) return res.status(404).json({ error: 'not_found' });
    res.status(202).json({ task_id: `del-${idx.id}-${Date.now()}`, note: 'pg_live_index: document removal is driven by source module deletes' });
  } catch (e) { res.status(500).json({ error: 'del_doc_failed', detail: dbErr(e) }); }
});

router.delete('/indexes/:id/documents', async (req, res) => {
  try {
    const idx = await one(`SELECT id FROM search_indexes WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!idx) return res.status(404).json({ error: 'not_found' });
    res.status(202).json({ task_id: `delall-${idx.id}-${Date.now()}`, note: 'pg_live_index: no-op (source-of-truth deletes propagate automatically)' });
  } catch (e) { res.status(500).json({ error: 'del_docs_failed', detail: dbErr(e) }); }
});

/* ═══════════════ 5.4 SYNONYMS ═══════════════ */

router.get('/synonyms', async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM search_synonyms WHERE tenant_id = current_tenant_id() ORDER BY is_system DESC, synonym_group`);
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: 'list_failed', detail: dbErr(e) }); }
});

router.post('/synonyms', async (req, res) => {
  try {
    const { index_id, synonym_group, words, direction, language } = req.body || {};
    if (!synonym_group || !Array.isArray(words) || words.length < 2)
      return res.status(400).json({ error: 'synonym_group and words[] (>=2) required' });
    const row = await one(`
      INSERT INTO search_synonyms (index_id, synonym_group, words, direction, language)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (tenant_id, index_id, synonym_group)
        DO UPDATE SET words = EXCLUDED.words, direction = EXCLUDED.direction,
                      language = EXCLUDED.language, updated_at = NOW()
      RETURNING *`,
      [index_id || null, String(synonym_group).slice(0, 128),
       words.map(w => String(w).slice(0, 128)),
       direction === 'one-way' ? 'one-way' : 'both',
       ['uk', 'ru', 'en'].includes(language) ? language : 'uk']);
    _synCache.rows = null;
    res.status(201).json({ data: row });
  } catch (e) { res.status(500).json({ error: 'create_failed', detail: dbErr(e) }); }
});

router.put('/synonyms/:id', async (req, res) => {
  try {
    const { words, direction, language, is_active } = req.body || {};
    const row = await one(`
      UPDATE search_synonyms SET
        words     = COALESCE($2, words),
        direction = COALESCE($3, direction),
        language  = COALESCE($4, language),
        is_active = COALESCE($5, is_active),
        updated_at = NOW()
      WHERE id = $1 AND tenant_id = current_tenant_id()
      RETURNING *`,
      [req.params.id,
       Array.isArray(words) ? words.map(w => String(w).slice(0, 128)) : null,
       direction || null, language || null,
       typeof is_active === 'boolean' ? is_active : null]);
    if (!row) return res.status(404).json({ error: 'not_found' });
    _synCache.rows = null;
    res.json({ data: row });
  } catch (e) { res.status(500).json({ error: 'update_failed', detail: dbErr(e) }); }
});

router.delete('/synonyms/:id', async (req, res) => {
  try {
    const row = await one(`DELETE FROM search_synonyms WHERE id = $1 AND tenant_id = current_tenant_id() AND is_system = FALSE RETURNING id`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not_found_or_system' });
    _synCache.rows = null;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'delete_failed', detail: dbErr(e) }); }
});

/* POST /synonyms/import — CSV: group,words(|-separated),direction,language */
router.post('/synonyms/import', async (req, res) => {
  try {
    const csv = String(req.body?.csv || '');
    if (!csv.trim()) return res.status(400).json({ error: 'csv body required' });
    const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let imported = 0;
    for (const line of lines) {
      const parts = line.split(',').map(s => s.trim());
      const grp = parts[0];
      const words = (parts[1] || '').split('|').map(w => w.trim()).filter(Boolean);
      if (!grp || words.length < 2 || /^group$/i.test(grp)) continue;  // skip header
      const direction = parts[2] === 'one-way' ? 'one-way' : 'both';
      const language = ['uk', 'ru', 'en'].includes(parts[3]) ? parts[3] : 'uk';
      await q(`INSERT INTO search_synonyms (index_id, synonym_group, words, direction, language)
               VALUES (NULL,$1,$2,$3,$4)
               ON CONFLICT (tenant_id, index_id, synonym_group)
                 DO UPDATE SET words=EXCLUDED.words, updated_at=NOW()`,
        [grp.slice(0, 128), words.map(w => w.slice(0, 128)), direction, language]).then(() => imported++).catch(() => {});
    }
    _synCache.rows = null;
    logAction({ user: req.user, action: 'search.synonyms.import', entity: 'search_synonyms', ip: req.ip, meta: { imported } });
    res.json({ imported });
  } catch (e) { res.status(500).json({ error: 'import_failed', detail: dbErr(e) }); }
});

/* GET /synonyms/export → CSV */
router.get('/synonyms/export', async (req, res) => {
  try {
    const rows = await q(`SELECT synonym_group, words, direction, language FROM search_synonyms WHERE tenant_id = current_tenant_id() ORDER BY synonym_group`);
    const lines = ['group,words,direction,language'];
    for (const r of rows) lines.push([r.synonym_group, (r.words || []).join('|'), r.direction, r.language].join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="synonyms.csv"');
    res.send(lines.join('\n'));
  } catch (e) { res.status(500).json({ error: 'export_failed', detail: dbErr(e) }); }
});

/* ═══════════════ 5.5 ANALYTICS ═══════════════ */

function periodToInterval(p) {
  return ({ '7d': '7 days', '30d': '30 days', '90d': '90 days' }[p]) || '30 days';
}

/* PATCH /api/search/analytics/click  { query, index_name?, result_id, position }
   Регистрирует клик по результату для расчёта CTR / средней позиции (спека 5.5/3.5). */
router.patch('/analytics/click', async (req, res) => {
  try {
    const { query, index_name, result_id, position } = req.body || {};
    if (!query || result_id == null) return res.status(400).json({ error: 'query and result_id required' });
    // обновляем последний матчащий запрос этого пользователя без клика
    const row = await one(`
      UPDATE search_analytics SET clicked_result_id = $3, clicked_position = $4
      WHERE id = (
        SELECT id FROM search_analytics
        WHERE tenant_id = current_tenant_id()
          AND query_normalized = $1
          AND coalesce(index_name,'all') = coalesce($2,'all')
          AND clicked_result_id IS NULL
        ORDER BY created_at DESC LIMIT 1)
      RETURNING id`,
      [norm(query), index_name || 'all', String(result_id).slice(0, 64),
       position != null ? parseInt(position, 10) : null]);
    res.json({ ok: true, updated: !!row });
  } catch (e) { res.status(500).json({ error: 'click_failed', detail: dbErr(e) }); }
});

router.get('/analytics/top-queries', async (req, res) => {
  try {
    const interval = periodToInterval(req.query.period);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const idxFilter = req.query.index_name ? `AND index_name = $2` : '';
    const params = [interval];
    if (req.query.index_name) params.push(String(req.query.index_name));
    const rows = await q(`
      SELECT query_normalized AS query,
             COUNT(*)::int AS count,
             ROUND(AVG(results_count), 1) AS avg_results,
             ROUND(AVG((clicked_result_id IS NOT NULL)::int)::numeric, 3) AS avg_ctr,
             MAX(created_at) AS last_searched_at
      FROM search_analytics
      WHERE tenant_id = current_tenant_id()
        AND created_at >= NOW() - $1::interval ${idxFilter}
      GROUP BY query_normalized
      ORDER BY count DESC
      LIMIT ${limit}`, params);
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: 'top_queries_failed', detail: dbErr(e) }); }
});

router.get('/analytics/zero-results', async (req, res) => {
  try {
    const interval = periodToInterval(req.query.period);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const rows = await q(`
      SELECT query_normalized AS query, COUNT(*)::int AS count, MAX(created_at) AS last_searched_at
      FROM search_analytics
      WHERE tenant_id = current_tenant_id()
        AND results_count = 0
        AND created_at >= NOW() - $1::interval
      GROUP BY query_normalized
      ORDER BY count DESC
      LIMIT ${limit}`, [interval]);
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: 'zero_results_failed', detail: dbErr(e) }); }
});

router.get('/analytics/ctr', async (req, res) => {
  try {
    const interval = periodToInterval(req.query.period);
    const row = await one(`
      SELECT COUNT(*)::int AS searches,
             COUNT(clicked_result_id)::int AS clicks,
             ROUND(AVG((clicked_result_id IS NOT NULL)::int)::numeric, 4) AS ctr,
             ROUND(AVG(clicked_position) FILTER (WHERE clicked_result_id IS NOT NULL), 2) AS avg_clicked_position
      FROM search_analytics
      WHERE tenant_id = current_tenant_id()
        AND created_at >= NOW() - $1::interval`, [interval]);
    res.json({ data: row || { searches: 0, clicks: 0, ctr: 0, avg_clicked_position: null } });
  } catch (e) { res.status(500).json({ error: 'ctr_failed', detail: dbErr(e) }); }
});

router.get('/analytics/summary', async (req, res) => {
  try {
    const interval = periodToInterval(req.query.period);
    const summary = await one(`
      SELECT COUNT(*)::int AS total_searches,
             COUNT(DISTINCT query_normalized)::int AS unique_queries,
             COUNT(*) FILTER (WHERE results_count = 0)::int AS zero_result_searches,
             ROUND(AVG(results_count), 1) AS avg_results,
             ROUND(AVG(response_time_ms), 0) AS avg_response_time_ms,
             ROUND(AVG((clicked_result_id IS NOT NULL)::int)::numeric, 4) AS ctr
      FROM search_analytics
      WHERE tenant_id = current_tenant_id()
        AND created_at >= NOW() - $1::interval`, [interval]);
    const daily = await q(`
      SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS searches,
             ROUND(AVG(response_time_ms), 0) AS avg_response_time_ms
      FROM search_analytics
      WHERE tenant_id = current_tenant_id() AND created_at >= NOW() - $1::interval
      GROUP BY 1 ORDER BY 1`, [interval]);
    res.json({ data: { ...(summary || {}), daily } });
  } catch (e) { res.status(500).json({ error: 'summary_failed', detail: dbErr(e) }); }
});

/* GET /api/search/:index?q=..&filters={}&sort=..&page=1&per_page=25&highlight=1
   Поиск в одном индексе: фасеты, фильтры, highlight, сортировка, пагинация.
   ВАЖНО: объявлен последним — это catch-all по :index, чтобы не перехватывать
   литеральные пути (/indexes, /synonyms, /analytics/*, /autocomplete, /multi). */
router.get('/:index', async (req, res) => {
  const t0 = Date.now();
  try {
    const type = String(req.params.index || '').trim();
    if (!ALL_TYPES.includes(type)) return res.status(404).json({ error: 'unknown_index', index: type });
    const raw = String(req.query.q || '').trim();
    if (raw.length < 2) return res.json({ hits: [], total: 0, facets: {}, processing_time_ms: 0 });

    const perPage = Math.min(Math.max(parseInt(req.query.per_page, 10) || 25, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = (page - 1) * perPage;
    let filters = {};
    if (req.query.filters) { try { filters = JSON.parse(req.query.filters); } catch { /* ignore */ } }
    const doHl = req.query.highlight === '1';
    const variants = await synonymVariants(raw);

    // берём на 1 больше для определения наличия следующей страницы
    let hits = await searchEntity(type, raw, variants, perPage + 1, offset, filters);
    const hasMore = hits.length > perPage;
    hits = hits.slice(0, perPage);

    if (doHl) hits = hits.map(h => ({ ...h, title_highlighted: highlight(h.title, raw), subtitle_highlighted: highlight(h.subtitle, raw) }));

    // Фасеты: подсчёт по filterable-полям индекса (по совпавшим, до фильтра).
    const facets = await computeFacets(type, raw, variants);

    const ms = Date.now() - t0;
    logQuery(req, { query: raw, index_name: type, results_count: hits.length, response_time_ms: ms, filters });
    res.json({ index: type, hits, total: hits.length, page, per_page: perPage, has_more: hasMore, facets, processing_time_ms: ms });
  } catch (e) {
    console.error('[search/:index]', e.message);
    res.status(500).json({ error: 'search_failed', detail: dbErr(e) });
  }
});

module.exports = router;
