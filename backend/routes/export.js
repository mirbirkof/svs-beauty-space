/* ═══════════════════════════════════════════════════════
   SVS Beauty World — Export (M25)
   GET /api/export/orders.csv        (admin) — заказы
   GET /api/export/clients.csv       (admin) — клиенты
   GET /api/export/products.csv      (admin) — товары + остатки
   GET /api/export/appointments.csv  (admin) — визиты/записи
   GDPR (право на переносимость данных, ст.16 ЗУ "Про захист персональних даних"):
   GET /api/export/gdpr/client/:id        — полный JSON-дамп всех данных клиента
   GET /api/export/gdpr/client/:id.csv    — сводка клиента в CSV
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

router.use(requirePerm('export.read'));

function toCsv(rows, columns) {
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[,"\n]/.test(s) ? `"${s}"` : s;
  };
  const header = columns.map(c => c.label).join(',');
  const body = rows.map(r => columns.map(c => escape(r[c.key])).join(',')).join('\n');
  return '\ufeff' + header + '\n' + body;
}

router.get('/orders.csv', async (req, res) => {
  const pool = getPool();
  const r = await pool.query(`
    SELECT o.id, o.created_at, c.phone, c.name AS client_name,
           o.total, o.status, o.payment_method, o.delivery_type, o.notes
    FROM orders o LEFT JOIN clients c ON c.id = o.client_id
    ORDER BY o.id DESC LIMIT 5000`);
  const csv = toCsv(r.rows, [
    { key: 'id', label: 'ID' },
    { key: 'created_at', label: 'Дата' },
    { key: 'phone', label: 'Телефон' },
    { key: 'client_name', label: 'Клієнт' },
    { key: 'total', label: 'Сума' },
    { key: 'status', label: 'Статус' },
    { key: 'payment_method', label: 'Оплата' },
    { key: 'delivery_type', label: 'Доставка' },
    { key: 'notes', label: 'Примітки' },
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${Date.now()}.csv"`);
  res.send(csv);
});

router.get('/clients.csv', async (req, res) => {
  const pool = getPool();
  const r = await pool.query(`
    SELECT c.id, c.phone, c.name, c.email, c.loyalty_points, c.total_spent, c.created_at,
           (SELECT COUNT(*) FROM orders WHERE client_id = c.id) AS orders_count
    FROM clients c ORDER BY c.id DESC LIMIT 10000`);
  const csv = toCsv(r.rows, [
    { key: 'id', label: 'ID' },
    { key: 'phone', label: 'Телефон' },
    { key: 'name', label: 'Імʼя' },
    { key: 'email', label: 'Email' },
    { key: 'orders_count', label: 'Замовлень' },
    { key: 'total_spent', label: 'Витрачено' },
    { key: 'loyalty_points', label: 'Бонуси' },
    { key: 'created_at', label: 'Реєстрація' },
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="clients-${Date.now()}.csv"`);
  res.send(csv);
});

router.get('/products.csv', async (req, res) => {
  const pool = getPool();
  const r = await pool.query(`
    SELECT p.id, p.name, p.brand_id, p.category_id,
           pv.volume, pv.price, pv.wholesale, pv.stock_qty, pv.sku
    FROM products p
    LEFT JOIN product_variants pv ON pv.product_id = p.id
    WHERE p.active = TRUE
    ORDER BY p.name, pv.price`);
  const csv = toCsv(r.rows, [
    { key: 'id', label: 'ID товару' },
    { key: 'name', label: 'Назва' },
    { key: 'brand_id', label: 'Бренд' },
    { key: 'category_id', label: 'Категорія' },
    { key: 'volume', label: 'Обʼєм' },
    { key: 'price', label: 'Ціна' },
    { key: 'wholesale', label: 'Опт' },
    { key: 'stock_qty', label: 'Залишок' },
    { key: 'sku', label: 'SKU' },
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="products-${Date.now()}.csv"`);
  res.send(csv);
});

router.get('/appointments.csv', async (req, res) => {
  const pool = getPool();
  const { from, to } = req.query;
  const cond = [];
  const args = [];
  if (from) { args.push(from); cond.push(`a.starts_at >= $${args.length}`); }
  if (to)   { args.push(to);   cond.push(`a.starts_at <= $${args.length}`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const r = await pool.query(`
    SELECT a.id, a.starts_at, a.status,
           COALESCE(c.name, a.client_name) AS client_name,
           COALESCE(c.phone, '')          AS phone,
           COALESCE(m.name, '')           AS master_name,
           COALESCE(s.name, a.services_text) AS service_name,
           a.price, a.payment_method, a.source,
           CASE WHEN a.beautypro_id IS NOT NULL THEN 'BeautyPro' ELSE 'Власна' END AS origin
    FROM appointments a
    LEFT JOIN clients  c ON c.id = a.client_id
    LEFT JOIN masters  m ON m.id = a.master_id
    LEFT JOIN services s ON s.id = a.service_id
    ${where}
    ORDER BY a.starts_at DESC LIMIT 20000`, args);
  const csv = toCsv(r.rows, [
    { key: 'id', label: 'ID' },
    { key: 'starts_at', label: 'Дата/час' },
    { key: 'client_name', label: 'Клієнт' },
    { key: 'phone', label: 'Телефон' },
    { key: 'master_name', label: 'Майстер' },
    { key: 'service_name', label: 'Послуга' },
    { key: 'price', label: 'Ціна' },
    { key: 'payment_method', label: 'Оплата' },
    { key: 'status', label: 'Статус' },
    { key: 'source', label: 'Джерело' },
    { key: 'origin', label: 'Походження' },
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="appointments-${Date.now()}.csv"`);
  res.send(csv);
});

// ── GDPR: полный дамп всех данных одного клиента ──────────
async function collectClientData(pool, id) {
  const client = (await pool.query('SELECT * FROM clients WHERE id=$1', [id])).rows[0];
  if (!client) return null;
  const [appointments, orders, loyalty, cash] = await Promise.all([
    pool.query(`SELECT a.id, a.starts_at, a.status, a.price, a.payment_method,
                       COALESCE(m.name,'') AS master, COALESCE(s.name,a.services_text) AS service
                FROM appointments a
                LEFT JOIN masters m ON m.id=a.master_id
                LEFT JOIN services s ON s.id=a.service_id
                WHERE a.client_id=$1 ORDER BY a.starts_at DESC`, [id]),
    pool.query('SELECT id, created_at, total, status, payment_method, delivery_type FROM orders WHERE client_id=$1 ORDER BY id DESC', [id]),
    pool.query('SELECT id, delta, reason, ref_type, created_at FROM loyalty_ledger WHERE client_id=$1 ORDER BY id DESC', [id]),
    pool.query('SELECT id, type, amount, method, description, created_at FROM cash_operations WHERE ref_type=\'client\' AND ref_id=$1 ORDER BY id DESC', [id]),
  ]);
  return {
    client,
    appointments: appointments.rows,
    orders: orders.rows,
    loyalty_ledger: loyalty.rows,
    cash_operations: cash.rows,
  };
}

router.get('/gdpr/client/:id(\\d+).csv', async (req, res) => {
  const pool = getPool();
  const data = await collectClientData(pool, req.params.id);
  if (!data) return res.status(404).json({ error: 'client_not_found' });
  await logAction({ user: req.user, action: 'export.gdpr_csv', entity: 'client', entity_id: req.params.id, ip: req.ip });
  const c = data.client;
  const lines = [];
  lines.push('РОЗДІЛ,Поле,Значення');
  const esc = (v) => { const s = v==null?'':String(v).replace(/"/g,'""'); return /[,"\n]/.test(s)?`"${s}"`:s; };
  for (const [k, v] of Object.entries(c)) lines.push(`Профіль,${esc(k)},${esc(v)}`);
  lines.push('');
  lines.push('ВІЗИТИ');
  lines.push('Дата,Майстер,Послуга,Ціна,Статус');
  data.appointments.forEach(a => lines.push([a.starts_at, a.master, a.service, a.price, a.status].map(esc).join(',')));
  lines.push('');
  lines.push('ЗАМОВЛЕННЯ');
  lines.push('Дата,Сума,Статус,Оплата');
  data.orders.forEach(o => lines.push([o.created_at, o.total, o.status, o.payment_method].map(esc).join(',')));
  lines.push('');
  lines.push('БОНУСИ');
  lines.push('Дата,Зміна,Причина');
  data.loyalty_ledger.forEach(l => lines.push([l.created_at, l.delta, l.reason].map(esc).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gdpr-client-${req.params.id}.csv"`);
  res.send('\ufeff' + lines.join('\n'));
});

router.get('/gdpr/client/:id(\\d+)', async (req, res) => {
  const pool = getPool();
  const data = await collectClientData(pool, req.params.id);
  if (!data) return res.status(404).json({ error: 'client_not_found' });
  await logAction({ user: req.user, action: 'export.gdpr_json', entity: 'client', entity_id: req.params.id, ip: req.ip });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gdpr-client-${req.params.id}.json"`);
  res.send(JSON.stringify({ exported_at: new Date().toISOString(), ...data }, null, 2));
});

module.exports = router;
