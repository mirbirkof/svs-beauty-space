/* ═══════════════════════════════════════════════════════
   SVS Beauty World — Catalog API (Postgres)
   GET /api/catalog/health      — статус БД
   GET /api/catalog/brands      — все бренды
   GET /api/catalog/categories  — все категории + группы
   GET /api/catalog/products    — список товаров (?brand=&category=&search=&limit=&offset=)
   GET /api/catalog/products/:id — товар + варианты
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const pg = require('../db-pg');

// Middleware: если Postgres не подключён — отдаём 503
router.use((req, res, next) => {
  if (!pg.isEnabled()) {
    return res.status(503).json({ error: 'Postgres не подключён (нет DATABASE_URL)' });
  }
  next();
});

router.get('/health', async (req, res) => {
  try {
    const r = await pg.query('SELECT NOW() AS now, COUNT(*)::int AS products FROM products');
    res.json({ ok: true, now: r.rows[0].now, products: r.rows[0].products });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/brands', async (req, res) => {
  try {
    const r = await pg.query('SELECT id, name, logo, about FROM brands ORDER BY name');
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/categories', async (req, res) => {
  try {
    const r = await pg.query(
      'SELECT id, name, icon, group_name FROM categories ORDER BY group_name, name'
    );
    // group by group_name
    const groups = {};
    for (const row of r.rows) {
      const g = row.group_name || 'Інше';
      if (!groups[g]) groups[g] = { name: g, categories: [] };
      groups[g].categories.push({ id: row.id, name: row.name, icon: row.icon });
    }
    res.json({ flat: r.rows, grouped: Object.values(groups) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/products', async (req, res) => {
  try {
    const { brand, category, search } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const conds = ['p.active = TRUE'];
    const params = [];
    if (brand) { params.push(brand); conds.push(`p.brand_id = $${params.length}`); }
    if (category) { params.push(category); conds.push(`p.category_id = $${params.length}`); }
    if (search) {
      params.push('%' + search.toLowerCase() + '%');
      conds.push(`LOWER(p.name) LIKE $${params.length}`);
    }
    params.push(limit); const lp = params.length;
    params.push(offset); const op = params.length;

    const sql = `
      SELECT p.id, p.name, p.brand_id, p.category_id, p.photo,
             MIN(v.price) AS price_from,
             MAX(v.price) AS price_to,
             COUNT(v.id)::int AS variants_count
      FROM products p
      LEFT JOIN product_variants v ON v.product_id = p.id AND v.active = TRUE
      WHERE ${conds.join(' AND ')}
      GROUP BY p.id
      ORDER BY p.name
      LIMIT $${lp} OFFSET $${op}
    `;
    const r = await pg.query(sql, params);

    // total count
    const countSql = `SELECT COUNT(*)::int AS total FROM products p WHERE ${conds.join(' AND ')}`;
    const cr = await pg.query(countSql, params.slice(0, params.length - 2));

    res.json({ items: r.rows, total: cr.rows[0].total, limit, offset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/products/:id', async (req, res) => {
  try {
    const p = await pg.query(
      `SELECT p.*, b.name AS brand_name, c.name AS category_name
       FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = $1 AND p.active = TRUE`,
      [req.params.id]
    );
    if (!p.rowCount) return res.status(404).json({ error: 'Не знайдено' });
    const v = await pg.query(
      `SELECT id, volume, price, wholesale, sku, stock_qty
       FROM product_variants
       WHERE product_id = $1 AND active = TRUE
       ORDER BY price`,
      [req.params.id]
    );
    res.json({ ...p.rows[0], variants: v.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
