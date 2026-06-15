/* ═══════════════════════════════════════════════════════
   INF-03 — Глобальный поиск (Global Search)
   Подключается как /api/search

   Что закрывает:
   - единый поиск по всем ключевым сущностям CRM: клиенты, услуги,
     мастера/сотрудники, товары, заказы, подарочные сертификаты, абонементы;
   - нечёткий поиск (pg_trgm) + ILIKE по имени/телефону/email/коду;
   - нормализация телефона (поиск по последним цифрам без учёта формата);
   - релевантность: точное совпадение → префикс → trigram similarity;
   - группировка результатов по типу + единый плоский список (?flat=1);
   - быстрый автокомплит (?limit=5) для глобальной строки поиска в шапке.

   Права: search.read (см. миграцию 085_search_permissions.sql).
   Мультитенантность: фильтр по tenant_id там, где колонка есть.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

// только цифры (для поиска по телефону без учёта +380 / пробелов / скобок)
function digits(s) { return String(s || '').replace(/\D+/g, ''); }

router.use(requirePerm('search.read'));

/* GET /api/search?q=...&types=clients,services&limit=8&flat=0
   q       — строка запроса (мин. 2 символа)
   types   — список сущностей через запятую (по умолчанию все)
   limit   — лимит на каждую сущность (1..50, default 8)
   flat    — 1 → вернуть единый отсортированный список вместо групп */
router.get('/', async (req, res) => {
  try {
    const raw = String(req.query.q || '').trim();
    if (raw.length < 2) return res.json({ query: raw, groups: {}, results: [], total: 0 });

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);
    const allTypes = ['clients', 'services', 'masters', 'products', 'orders', 'gift_certificates', 'subscriptions'];
    const want = req.query.types
      ? String(req.query.types).split(',').map(s => s.trim()).filter(t => allTypes.includes(t))
      : allTypes;

    const like = `%${raw}%`;
    const prefix = `${raw}%`;
    const dig = digits(raw);
    const digLike = dig ? `%${dig}%` : null;

    const groups = {};
    const tasks = [];

    // ── CLIENTS (имя / телефон / email) ──
    if (want.includes('clients')) {
      tasks.push((async () => {
        groups.clients = await q(`
          SELECT id, name, phone, email, total_spent, last_visit_at,
                 GREATEST(similarity(coalesce(name,''), $1), 0) AS sim
          FROM clients
          WHERE tenant_id = current_tenant_id()
            AND ( name ILIKE $2
               OR email ILIKE $2
               OR ($3::text IS NOT NULL AND regexp_replace(coalesce(phone,''),'\\D','','g') ILIKE $3) )
          ORDER BY (name ILIKE $4) DESC, sim DESC, last_visit_at DESC NULLS LAST
          LIMIT $5
        `, [raw, like, digLike, prefix, limit]);
      })());
    }

    // ── SERVICES (название / категория) ──
    if (want.includes('services')) {
      tasks.push((async () => {
        groups.services = await q(`
          SELECT id, name, category, price, duration_min,
                 GREATEST(similarity(coalesce(name,''), $1), 0) AS sim
          FROM services
          WHERE tenant_id = current_tenant_id()
            AND deleted_at IS NULL
            AND ( name ILIKE $2 OR coalesce(name_ua,'') ILIKE $2
               OR coalesce(name_en,'') ILIKE $2 OR coalesce(category,'') ILIKE $2 )
          ORDER BY (name ILIKE $3) DESC, sim DESC
          LIMIT $4
        `, [raw, like, prefix, limit]);
      })());
    }

    // ── MASTERS / сотрудники (имя / фамилия / телефон / спец.) ──
    if (want.includes('masters')) {
      tasks.push((async () => {
        groups.masters = await q(`
          SELECT id, name, surname, phone, specialty, staff_role,
                 GREATEST(similarity(coalesce(name,'')||' '||coalesce(surname,''), $1), 0) AS sim
          FROM masters
          WHERE tenant_id = current_tenant_id()
            AND ( name ILIKE $2 OR coalesce(surname,'') ILIKE $2
               OR coalesce(specialty,'') ILIKE $2
               OR ($3::text IS NOT NULL AND regexp_replace(coalesce(phone,''),'\\D','','g') ILIKE $3) )
          ORDER BY (name ILIKE $4) DESC, sim DESC, active DESC
          LIMIT $5
        `, [raw, like, digLike, prefix, limit]);
      })());
    }

    // ── PRODUCTS (название) ──
    if (want.includes('products')) {
      tasks.push((async () => {
        groups.products = await q(`
          SELECT id, name, stock, active,
                 GREATEST(similarity(coalesce(name,''), $1), 0) AS sim
          FROM products
          WHERE tenant_id = current_tenant_id()
            AND ( name ILIKE $2 OR coalesce(description,'') ILIKE $2 )
          ORDER BY (name ILIKE $3) DESC, sim DESC
          LIMIT $4
        `, [raw, like, prefix, limit]);
      })());
    }

    // ── ORDERS (по № или примечанию; по имени/телефону клиента) ──
    if (want.includes('orders')) {
      const orderId = /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
      tasks.push((async () => {
        groups.orders = await q(`
          SELECT o.id, o.total, o.status, o.payment_method, o.created_at,
                 c.name AS client_name, c.phone AS client_phone
          FROM orders o
          LEFT JOIN clients c ON c.id = o.client_id
          WHERE o.tenant_id = current_tenant_id()
            AND ( ($1::int IS NOT NULL AND o.id = $1)
               OR o.notes ILIKE $2
               OR c.name ILIKE $2
               OR ($3::text IS NOT NULL AND regexp_replace(coalesce(c.phone,''),'\\D','','g') ILIKE $3) )
          ORDER BY o.created_at DESC
          LIMIT $4
        `, [orderId, like, digLike, limit]);
      })());
    }

    // ── GIFT CERTIFICATES (код / покупатель / получатель) — нет tenant_id ──
    if (want.includes('gift_certificates')) {
      tasks.push((async () => {
        groups.gift_certificates = await q(`
          SELECT id, code, type, status, remaining_amount, buyer_name, buyer_phone,
                 recipient_name, valid_until
          FROM gift_certificates
          WHERE code ILIKE $2
             OR buyer_name ILIKE $2 OR recipient_name ILIKE $2
             OR ($3::text IS NOT NULL AND regexp_replace(coalesce(buyer_phone,''),'\\D','','g') ILIKE $3)
             OR ($3::text IS NOT NULL AND regexp_replace(coalesce(recipient_phone,''),'\\D','','g') ILIKE $3)
          ORDER BY (code ILIKE $4) DESC, created_at DESC
          LIMIT $5
        `, [raw, like, digLike, prefix, limit]);
      })());
    }

    // ── SUBSCRIPTIONS / абонементы (№ / клиент) — нет tenant_id ──
    if (want.includes('subscriptions')) {
      tasks.push((async () => {
        groups.subscriptions = await q(`
          SELECT s.id, s.subscription_number, s.status, s.visits_remaining,
                 s.expires_at, c.name AS client_name, c.phone AS client_phone
          FROM subscriptions s
          LEFT JOIN clients c ON c.id = s.client_id
          WHERE s.subscription_number ILIKE $1
             OR c.name ILIKE $1
             OR ($2::text IS NOT NULL AND regexp_replace(coalesce(c.phone,''),'\\D','','g') ILIKE $2)
          ORDER BY s.created_at DESC
          LIMIT $3
        `, [like, digLike, limit]);
      })());
    }

    await Promise.all(tasks);

    // total + плоский список
    let total = 0;
    const results = [];
    for (const [type, rows] of Object.entries(groups)) {
      total += rows.length;
      if (req.query.flat === '1') {
        for (const r of rows) {
          const title =
            type === 'clients' ? r.name :
            type === 'services' ? r.name :
            type === 'masters' ? [r.name, r.surname].filter(Boolean).join(' ') :
            type === 'products' ? r.name :
            type === 'orders' ? `Замовлення #${r.id}` :
            type === 'gift_certificates' ? `Сертифікат ${r.code}` :
            type === 'subscriptions' ? `Абонемент ${r.subscription_number}` : '';
          results.push({ type, id: r.id, title, data: r, sim: Number(r.sim || 0) });
        }
      }
    }
    if (req.query.flat === '1') results.sort((a, b) => b.sim - a.sim);

    res.json({ query: raw, groups, results, total });
  } catch (e) {
    console.error('[search] error:', e.message);
    res.status(500).json({ error: 'search_failed', detail: e.message });
  }
});

module.exports = router;
