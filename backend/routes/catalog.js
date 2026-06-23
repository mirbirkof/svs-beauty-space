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
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
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
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

router.get('/products', async (req, res) => {
  try {
    // search = старий параметр, q = новий (підтримуємо обидва). Описание теж шукаємо.
    const { brand, category } = req.query;
    const search = req.query.q || req.query.search;
    // Пагінація: дефолт limit 50, max 100. ?page= (з 1) має пріоритет над ?offset=.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const page = req.query.page != null ? Math.max(parseInt(req.query.page, 10) || 1, 1) : null;
    const offset = page != null ? (page - 1) * limit : Math.max(parseInt(req.query.offset, 10) || 0, 0);

    // Діапазон ціни (по price_from агрегату): скінченні невідʼємні числа.
    const priceMin = Number.isFinite(parseFloat(req.query.price_min)) && parseFloat(req.query.price_min) >= 0
      ? parseFloat(req.query.price_min) : null;
    const priceMax = Number.isFinite(parseFloat(req.query.price_max)) && parseFloat(req.query.price_max) >= 0
      ? parseFloat(req.query.price_max) : null;

    const conds = ['p.active = TRUE'];
    const params = [];
    if (brand) { params.push(brand); conds.push(`p.brand_id = $${params.length}`); }
    if (category) { params.push(category); conds.push(`p.category_id = $${params.length}`); }
    if (search) {
      params.push('%' + String(search).toLowerCase() + '%');
      const p = '$' + params.length;
      conds.push(`(LOWER(p.name) LIKE ${p} OR LOWER(COALESCE(p.description,'')) LIKE ${p})`);
    }
    // фільтр по ціні — на наявних активних варіантах товару
    if (priceMin != null) {
      params.push(priceMin);
      conds.push(`EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id=p.id AND pv.active=TRUE AND pv.price >= $${params.length})`);
    }
    if (priceMax != null) {
      params.push(priceMax);
      conds.push(`EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id=p.id AND pv.active=TRUE AND pv.price <= $${params.length})`);
    }

    // Сортування — лише з білого списку (захист від інʼєкції в ORDER BY).
    const sortMap = {
      price_asc: 'price_from ASC NULLS LAST, p.name',
      price_desc: 'price_from DESC NULLS LAST, p.name',
      name: 'p.name ASC',
      popular: 'variants_count DESC, p.name',
    };
    const orderBy = sortMap[req.query.sort] || 'p.name';

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
      ORDER BY ${orderBy}
      LIMIT $${lp} OFFSET $${op}
    `;
    const r = await pg.query(sql, params);

    // total count
    const countSql = `SELECT COUNT(*)::int AS total FROM products p WHERE ${conds.join(' AND ')}`;
    const cr = await pg.query(countSql, params.slice(0, params.length - 2));
    const total = cr.rows[0].total;

    res.json({
      items: r.rows,
      total,
      limit,
      offset,
      ...(page != null ? { page, pages: Math.ceil(total / limit) || 1 } : {}),
      has_more: offset + r.rows.length < total,
    });
  } catch (e) {
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
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
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

module.exports = router;
