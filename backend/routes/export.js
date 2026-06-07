/* ═══════════════════════════════════════════════════════
   SVS Beauty World — CSV Export
   GET /api/export/orders.csv      (admin) — заказы
   GET /api/export/clients.csv     (admin) — клиенты
   GET /api/export/products.csv    (admin) — товары + остатки
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');

router.use((req, res, next) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

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

module.exports = router;
