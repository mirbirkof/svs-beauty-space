/* INF-08 BI Platform — конструктор отчётов без SQL.
 *
 * Безопасность: пользователь НИКОГДА не пишет SQL. Он выбирает измерения, метрики и
 * фильтры из СЕРВЕРНОГО белого списка (DATASETS). Любое значение фильтра уходит
 * параметром ($1,$2…) — SQL-инъекция невозможна. Идентификаторы колонок берутся
 * только из whitelist, никакой интерполяции пользовательских строк в текст запроса.
 *
 * Прагматично (1 салон): живые данные из основных таблиц, без DWH/ETL, без кэша
 * прогонов, без drag-and-drop-комбайна и scheduled-рассылок (для этого есть triggers/COM).
 */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();

// ── ТЗ-хелперы дат (Киев), синхронно с reports.js ──
function kyivOffsetMin(date) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kiev',
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  const p = {}; for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month-1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}
function kyivDayBound(dateStr, isEnd) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const naive = Date.UTC(y, m-1, d, isEnd ? 23 : 0, isEnd ? 59 : 0, isEnd ? 59 : 0, isEnd ? 999 : 0);
  const off = kyivOffsetMin(new Date(naive));
  return new Date(naive - off*60000);
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ════════════════════ БЕЛЫЙ СПИСОК ДАТАСЕТОВ ════════════════════
// Каждый ключ dim/measure/filter → готовый SQL-фрагмент (фикс, не из ввода).
const DATASETS = {
  appointments: {
    label: 'Записи / візити',
    base: 'appointments a',
    joins: {
      master:  'LEFT JOIN masters m  ON m.id = a.master_id',
      service: 'LEFT JOIN services s ON s.id = a.service_id',
    },
    dateField: 'a.starts_at',
    // Скасовані та неявки НЕ є виручкою — виключаємо за замовчуванням.
    // Якщо користувач явно фільтрує за статусом — цей дефолт не застосовується.
    defaultWhere: "a.status NOT IN ('cancelled','noshow')",
    defaultWhereSkipFilter: 'status',
    dimensions: {
      master:           { sql: "COALESCE(NULLIF(m.name,''), a.client_name, '—')", label: 'Майстер', join: 'master' },
      service:          { sql: "COALESCE(NULLIF(s.name,''), NULLIF(a.services_text,''), '—')", label: 'Послуга', join: 'service' },
      service_category: { sql: "COALESCE(NULLIF(s.category,''), '—')", label: 'Категорія послуги', join: 'service' },
      status:           { sql: "COALESCE(a.status,'—')", label: 'Статус' },
      source:           { sql: "COALESCE(NULLIF(a.source,''),'—')", label: 'Джерело' },
      payment_method:   { sql: "COALESCE(NULLIF(a.payment_method,''),'—')", label: 'Спосіб оплати' },
      day:              { sql: "to_char(a.starts_at,'YYYY-MM-DD')", label: 'День' },
      week:             { sql: "to_char(date_trunc('week',a.starts_at),'YYYY-MM-DD')", label: 'Тиждень' },
      month:            { sql: "to_char(a.starts_at,'YYYY-MM')", label: 'Місяць' },
      weekday:          { sql: "trim(to_char(a.starts_at,'TMDay'))", label: 'День тижня' },
      hour:             { sql: "to_char(a.starts_at,'HH24')||':00'", label: 'Година' },
    },
    measures: {
      count:     { sql: 'COUNT(*)', label: 'К-сть записів' },
      revenue:   { sql: 'COALESCE(SUM(COALESCE(a.real_amount,a.price)),0)', label: 'Виручка' },
      avg_check: { sql: 'COALESCE(ROUND(AVG(NULLIF(COALESCE(a.real_amount,a.price),0)),2),0)', label: 'Середній чек' },
      cashback:  { sql: 'COALESCE(SUM(a.cashback),0)', label: 'Кешбек' },
      clients:   { sql: 'COUNT(DISTINCT a.client_id)', label: 'Унік. клієнтів' },
    },
    filters: {
      status:         { sql: 'a.status', type: 'text' },
      source:         { sql: 'a.source', type: 'text' },
      master_id:      { sql: 'a.master_id', type: 'int' },
      service_id:     { sql: 'a.service_id', type: 'int' },
      payment_method: { sql: 'a.payment_method', type: 'text' },
      price:          { sql: 'a.price', type: 'num' },
    },
  },

  clients: {
    label: 'Клієнтська база',
    base: 'clients c',
    joins: {},
    dateField: 'c.created_at',
    dimensions: {
      client:       { sql: "COALESCE(NULLIF(c.name,''), c.phone, '—')", label: 'Клієнт' },
      source:       { sql: "COALESCE(NULLIF(c.source,''),'—')", label: 'Джерело' },
      signup_month: { sql: "to_char(c.created_at,'YYYY-MM')", label: 'Місяць реєстрації' },
      has_telegram: { sql: "CASE WHEN c.telegram_id IS NOT NULL THEN 'так' ELSE 'ні' END", label: 'Telegram' },
    },
    measures: {
      count:          { sql: 'COUNT(*)', label: 'К-сть клієнтів' },
      total_spent:    { sql: 'COALESCE(SUM(c.total_spent),0)', label: 'Сума витрат' },
      avg_spent:      { sql: 'COALESCE(ROUND(AVG(NULLIF(c.total_spent,0)),2),0)', label: 'Середні витрати' },
      loyalty_points: { sql: 'COALESCE(SUM(c.loyalty_points),0)', label: 'Бонуси' },
    },
    filters: {
      source:      { sql: 'c.source', type: 'text' },
      total_spent: { sql: 'c.total_spent', type: 'num' },
      loyalty_points: { sql: 'c.loyalty_points', type: 'int' },
    },
  },

  orders: {
    label: 'Замовлення (товари)',
    base: 'orders o',
    joins: { seller: 'LEFT JOIN masters m ON m.id = o.seller_master_id' },
    dateField: 'o.created_at',
    dimensions: {
      status:         { sql: "COALESCE(o.status,'—')", label: 'Статус' },
      payment_method: { sql: "COALESCE(NULLIF(o.payment_method,''),'—')", label: 'Оплата' },
      seller:         { sql: "COALESCE(NULLIF(m.name,''),'—')", label: 'Продавець', join: 'seller' },
      delivery_type:  { sql: "COALESCE(NULLIF(o.delivery_type,''),'—')", label: 'Доставка' },
      month:          { sql: "to_char(o.created_at,'YYYY-MM')", label: 'Місяць' },
      day:            { sql: "to_char(o.created_at,'YYYY-MM-DD')", label: 'День' },
    },
    measures: {
      count:     { sql: 'COUNT(*)', label: 'К-сть замовлень' },
      revenue:   { sql: 'COALESCE(SUM(o.total),0)', label: 'Виручка' },
      avg_order: { sql: 'COALESCE(ROUND(AVG(NULLIF(o.total,0)),2),0)', label: 'Середнє замовлення' },
      discount:  { sql: 'COALESCE(SUM(o.discount),0)', label: 'Знижки' },
    },
    filters: {
      status:         { sql: 'o.status', type: 'text' },
      payment_method: { sql: 'o.payment_method', type: 'text' },
      total:          { sql: 'o.total', type: 'num' },
    },
  },

  order_items: {
    label: 'Позиції товарів',
    base: 'order_items oi JOIN orders o ON o.id = oi.order_id',
    joins: {},
    dateField: 'o.created_at',
    dimensions: {
      product: { sql: "COALESCE(NULLIF(oi.product_name,''),'—')", label: 'Товар' },
      month:   { sql: "to_char(o.created_at,'YYYY-MM')", label: 'Місяць' },
    },
    measures: {
      qty:     { sql: 'COALESCE(SUM(oi.qty),0)', label: 'Кількість' },
      revenue: { sql: 'COALESCE(SUM(oi.line_total),0)', label: 'Виручка' },
      orders:  { sql: 'COUNT(DISTINCT oi.order_id)', label: 'Замовлень' },
    },
    filters: {
      product_name: { sql: 'oi.product_name', type: 'text' },
    },
  },

  payments: {
    label: 'Платежі',
    base: 'payments p',
    joins: {},
    dateField: 'COALESCE(p.paid_at, p.created_at)',
    dimensions: {
      method:   { sql: "COALESCE(NULLIF(p.method,''),'—')", label: 'Метод' },
      status:   { sql: "COALESCE(p.status,'—')", label: 'Статус' },
      provider: { sql: "COALESCE(NULLIF(p.provider,''),'—')", label: 'Провайдер' },
      purpose:  { sql: "COALESCE(NULLIF(p.purpose,''),'—')", label: 'Призначення' },
      month:    { sql: "to_char(COALESCE(p.paid_at,p.created_at),'YYYY-MM')", label: 'Місяць' },
    },
    measures: {
      count:  { sql: 'COUNT(*)', label: 'К-сть' },
      amount: { sql: 'COALESCE(SUM(p.amount),0)', label: 'Сума' },
      avg:    { sql: 'COALESCE(ROUND(AVG(NULLIF(p.amount,0)),2),0)', label: 'Середній платіж' },
    },
    filters: {
      status:   { sql: 'p.status', type: 'text' },
      method:   { sql: 'p.method', type: 'text' },
      provider: { sql: 'p.provider', type: 'text' },
      amount:   { sql: 'p.amount', type: 'num' },
    },
  },
};

const OPS = { '=':'=', '!=':'<>', '>':'>', '>=':'>=', '<':'<', '<=':'<=', like:'ILIKE' };

function coerce(v, type) {
  if (type === 'int') { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }
  if (type === 'num') { const n = Number(v);       return Number.isFinite(n) ? n : 0; }
  return String(v);
}

// ── Сборка параметризованного запроса из whitelist ──
function buildQuery(ds, cfg = {}) {
  const dimKeys = (cfg.dimensions || []).filter(k => ds.dimensions[k]).slice(0, 4);
  let measKeys  = (cfg.measures   || []).filter(k => ds.measures[k]);
  if (!measKeys.length) measKeys = [ds.measures.count ? 'count' : Object.keys(ds.measures)[0]];

  const params = [];
  const needJoins = new Set();

  const selDims = dimKeys.map((k, i) => { const d = ds.dimensions[k]; if (d.join) needJoins.add(d.join); return `${d.sql} AS d${i}`; });
  const selMeas = measKeys.map((k, i) => { const m = ds.measures[k];   if (m.join) needJoins.add(m.join); return `${m.sql} AS v${i}`; });

  const where = [];
  if (ds.dateField) {
    if (cfg.from && DATE_RE.test(cfg.from)) { params.push(kyivDayBound(cfg.from, false).toISOString()); where.push(`${ds.dateField} >= $${params.length}`); }
    if (cfg.to   && DATE_RE.test(cfg.to))   { params.push(kyivDayBound(cfg.to,   true ).toISOString()); where.push(`${ds.dateField} <= $${params.length}`); }
  }
  for (const f of (cfg.filters || [])) {
    const fd = ds.filters[f && f.field]; if (!fd) continue;
    if (fd.join) needJoins.add(fd.join);
    if (f.op === 'in' && Array.isArray(f.value) && f.value.length) {
      const ph = f.value.slice(0, 100).map(v => { params.push(coerce(v, fd.type)); return `$${params.length}`; });
      where.push(`${fd.sql} IN (${ph.join(',')})`);
    } else if (f.op === 'is_null') {
      where.push(`${fd.sql} IS NULL`);
    } else if (f.op === 'not_null') {
      where.push(`${fd.sql} IS NOT NULL`);
    } else if (OPS[f.op] && f.value != null && f.value !== '') {
      const val = f.op === 'like' ? `%${f.value}%` : coerce(f.value, fd.type);
      params.push(val);
      where.push(`${fd.sql} ${OPS[f.op]} $${params.length}`);
    }
  }

  // Дефолтний фільтр датасету (напр. виключення скасованих візитів),
  // якщо користувач не задав явний фільтр по відповідному полю.
  if (ds.defaultWhere) {
    const skip = ds.defaultWhereSkipFilter;
    const userOverrode = skip && (cfg.filters || []).some(f => f && f.field === skip);
    if (!userOverrode) where.push(ds.defaultWhere);
  }

  const joins = Object.keys(ds.joins || {}).filter(j => needJoins.has(j)).map(j => ds.joins[j]).join('\n    ');
  const groupBy = dimKeys.length ? `GROUP BY ${dimKeys.map((_, i) => i + 1).join(', ')}` : '';

  // ORDER BY только по выбранным алиасам
  let orderSql = '';
  const sort = cfg.sort || {};
  const dir = String(sort.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  if (sort.key && dimKeys.includes(sort.key))       orderSql = `ORDER BY d${dimKeys.indexOf(sort.key)} ${dir}`;
  else if (sort.key && measKeys.includes(sort.key)) orderSql = `ORDER BY v${measKeys.indexOf(sort.key)} ${dir}`;
  else if (measKeys.length)                         orderSql = 'ORDER BY v0 DESC';
  else if (dimKeys.length)                          orderSql = 'ORDER BY d0 ASC';

  let limit = parseInt(cfg.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 500;
  limit = Math.min(limit, 10000);

  const sql = `SELECT ${[...selDims, ...selMeas].join(', ')}
    FROM ${ds.base}
    ${joins}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ${groupBy}
    ${orderSql}
    LIMIT ${limit}`;

  const columns = [
    ...dimKeys.map(k => ({ key: k, label: ds.dimensions[k].label, kind: 'dim' })),
    ...measKeys.map(k => ({ key: k, label: ds.measures[k].label, kind: 'measure' })),
  ];
  return { sql, params, columns, dimKeys, measKeys };
}

function mapRows(rows, dimKeys, measKeys) {
  return rows.map(r => {
    const o = {};
    dimKeys.forEach((k, i) => { o[k] = r['d' + i]; });
    measKeys.forEach((k, i) => { o[k] = r['v' + i] == null ? 0 : Number(r['v' + i]); });
    return o;
  });
}

async function runConfig(dataset, cfg) {
  const ds = DATASETS[dataset];
  if (!ds) { const e = new Error('unknown dataset'); e.code = 400; throw e; }
  const built = buildQuery(ds, cfg || {});
  const { rows } = await pool.query(built.sql, built.params);
  return { columns: built.columns, rows: mapRows(rows, built.dimKeys, built.measKeys), row_count: rows.length };
}

// ════════════════════ ШАБЛОНЫ (beauty) ════════════════════
const TEMPLATES = [
  { key: 'rev_by_master',  name: 'Виручка по майстрах',        category: 'Фінанси',   dataset: 'appointments', config: { dimensions:['master'], measures:['revenue','count','avg_check'], sort:{key:'revenue',dir:'desc'} } },
  { key: 'top_services',   name: 'Топ послуг за виручкою',     category: 'Послуги',   dataset: 'appointments', config: { dimensions:['service'], measures:['revenue','count'], sort:{key:'revenue',dir:'desc'}, limit:20 } },
  { key: 'rev_by_cat',     name: 'Виручка по категоріях',      category: 'Послуги',   dataset: 'appointments', config: { dimensions:['service_category'], measures:['revenue','count'], sort:{key:'revenue',dir:'desc'} } },
  { key: 'rev_by_month',   name: 'Динаміка виручки по місяцях', category: 'Фінанси',  dataset: 'appointments', config: { dimensions:['month'], measures:['revenue','count','avg_check'], sort:{key:'month',dir:'asc'} } },
  { key: 'load_weekday',   name: 'Завантаження по днях тижня',  category: 'Завантаження', dataset: 'appointments', config: { dimensions:['weekday'], measures:['count','revenue'], sort:{key:'count',dir:'desc'} } },
  { key: 'load_hour',      name: 'Завантаження по годинах',     category: 'Завантаження', dataset: 'appointments', config: { dimensions:['hour'], measures:['count'], sort:{key:'hour',dir:'asc'} } },
  { key: 'appt_status',    name: 'Записи по статусах',          category: 'Послуги',   dataset: 'appointments', config: { dimensions:['status'], measures:['count','revenue'], sort:{key:'count',dir:'desc'} } },
  { key: 'client_sources', name: 'Джерела клієнтів',            category: 'Клієнти',   dataset: 'clients',      config: { dimensions:['source'], measures:['count','total_spent'], sort:{key:'count',dir:'desc'} } },
  { key: 'top_clients',    name: 'Топ клієнтів за витратами',   category: 'Клієнти',   dataset: 'clients',      config: { dimensions:['client'], measures:['total_spent','loyalty_points'], sort:{key:'total_spent',dir:'desc'}, limit:30 } },
  { key: 'new_clients',    name: 'Нові клієнти по місяцях',     category: 'Клієнти',   dataset: 'clients',      config: { dimensions:['signup_month'], measures:['count'], sort:{key:'signup_month',dir:'asc'} } },
  { key: 'sales_by_month', name: 'Продажі товарів по місяцях',  category: 'Магазин',   dataset: 'orders',       config: { dimensions:['month'], measures:['revenue','count','avg_order'], sort:{key:'month',dir:'asc'} } },
  { key: 'top_products',   name: 'Топ товарів',                 category: 'Магазин',   dataset: 'order_items',  config: { dimensions:['product'], measures:['revenue','qty'], sort:{key:'revenue',dir:'desc'}, limit:20 } },
  { key: 'pay_methods',    name: 'Платежі по методах',          category: 'Фінанси',   dataset: 'payments',     config: { dimensions:['method','status'], measures:['count','amount'], sort:{key:'amount',dir:'desc'} } },
];

// ════════════════════ ROUTES ════════════════════
router.use((req, res, next) => requirePerm('reports.read')(req, res, next));

// Метаданные whitelist для UI (без SQL-фрагментов)
router.get('/datasets', (req, res) => {
  const out = {};
  for (const [k, ds] of Object.entries(DATASETS)) {
    out[k] = {
      label: ds.label,
      has_date: !!ds.dateField,
      dimensions: Object.entries(ds.dimensions).map(([key, d]) => ({ key, label: d.label })),
      measures:   Object.entries(ds.measures).map(([key, m]) => ({ key, label: m.label })),
      filters:    Object.entries(ds.filters).map(([key, f]) => ({ key, type: f.type })),
    };
  }
  res.json({ datasets: out, operators: Object.keys(OPS).concat(['in','is_null','not_null']) });
});

router.get('/templates', (req, res) => res.json({ templates: TEMPLATES }));

// Выполнить ad-hoc отчёт
router.post('/run', async (req, res) => {
  try {
    const { dataset, ...cfg } = req.body || {};
    const out = await runConfig(dataset, cfg);
    res.json(out);
  } catch (e) {
    res.status(e.code === 400 ? 400 : 500).json({ error: e.message });
  }
});

// Список сохранённых
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, description, dataset, config, is_favorite, is_shared,
              created_by_name, created_at, updated_at
         FROM bi_reports ORDER BY is_favorite DESC, updated_at DESC`);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Сохранить
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !DATASETS[b.dataset]) return res.status(400).json({ error: 'name и валидный dataset обязательны' });
    const { rows } = await pool.query(
      `INSERT INTO bi_reports (name, description, dataset, config, is_favorite, is_shared, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [String(b.name).slice(0,200), b.description || null, b.dataset, b.config || {},
       !!b.is_favorite, b.is_shared !== false, req.user?.id || null, req.user?.display_name || null]);
    logAction({ user: req.user, action: 'bi.report.create', entity: 'bi_report', entity_id: rows[0].id, ip: req.ip, meta: { name: b.name, dataset: b.dataset } }).catch(()=>{});
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Получить + выполнить (только числовой id — иначе 404, а не 500 с текстом SQL)
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bi_reports WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const rep = rows[0];
    let result = null;
    try { result = await runConfig(rep.dataset, rep.config); } catch (e) { result = { error: e.message }; }
    res.json({ report: rep, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Обновить
router.put('/:id(\\d+)', async (req, res) => {
  try {
    const b = req.body || {};
    const fields = [], vals = []; let i = 1;
    for (const k of ['name','description','dataset','config','is_favorite','is_shared']) {
      if (b[k] === undefined) continue;
      if (k === 'dataset' && !DATASETS[b[k]]) return res.status(400).json({ error: 'unknown dataset' });
      fields.push(`${k}=$${i++}`); vals.push(k === 'config' ? (b[k]||{}) : b[k]);
    }
    if (!fields.length) return res.status(400).json({ error: 'нечего обновлять' });
    vals.push(req.params.id);
    const { rows } = await pool.query(`UPDATE bi_reports SET ${fields.join(',')}, updated_at=NOW() WHERE id=$${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    logAction({ user: req.user, action: 'bi.report.update', entity: 'bi_report', entity_id: Number(req.params.id), ip: req.ip, meta: { fields: Object.keys(b) } }).catch(()=>{});
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id(\\d+)/favorite', async (req, res) => {
  try {
    const { rows } = await pool.query('UPDATE bi_reports SET is_favorite = NOT is_favorite, updated_at=NOW() WHERE id=$1 RETURNING id, is_favorite', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM bi_reports WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    logAction({ user: req.user, action: 'bi.report.delete', entity: 'bi_report', entity_id: Number(req.params.id), ip: req.ip, meta: {} }).catch(()=>{});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CSV-экспорт (ad-hoc через POST-конфиг или сохранённый через ?id=)
function toCsv(columns, rows) {
  const esc = v => { const s = v == null ? '' : String(v); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = columns.map(c => esc(c.label)).join(';');
  const body = rows.map(r => columns.map(c => esc(r[c.key])).join(';')).join('\n');
  return '\uFEFF' + head + '\n' + body; // BOM → Excel читает кириллицу
}
router.post('/export.csv', async (req, res) => {
  try {
    const { dataset, ...cfg } = req.body || {};
    const out = await runConfig(dataset, cfg);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report-${Date.now()}.csv"`);
    res.send(toCsv(out.columns, out.rows));
  } catch (e) { res.status(e.code === 400 ? 400 : 500).json({ error: e.message }); }
});

// Fallback: невалидный id / неизвестный путь → чистый JSON 404 (не 500 с текстом SQL)
router.use((req, res) => res.status(404).json({ error: 'not_found' }));

module.exports = router;
// Тест-доступ к внутренностям (без HTTP/RBAC) — для smoke-тестов и переиспользования.
module.exports._internals = { runConfig, buildQuery, DATASETS, TEMPLATES };
