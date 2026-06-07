/* ═══════════════════════════════════════════════════════
   SVS Beauty World — Catalog Legacy Adapter
   Отдаёт каталог в формате старого js/shop-data.js
   чтобы витрина shop.html могла подключиться к live API
   одной строкой без переписывания.

   GET /api/catalog/legacy/all  → { brands, categories, category_groups, products }
   Кэшируется в памяти на 5 минут.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const pg = require('../db-pg');

let cache = null;
let cachedAt = 0;
const TTL = 5 * 60 * 1000;

async function build() {
  const [brands, categories, products, variants] = await Promise.all([
    pg.query('SELECT id, name FROM brands ORDER BY name'),
    pg.query("SELECT id, name, icon, group_name FROM categories ORDER BY group_name, name"),
    pg.query(`SELECT id, name, brand_id, category_id, photo, description
              FROM products WHERE active = TRUE ORDER BY name`),
    pg.query(`SELECT product_id, volume, price, wholesale, stock_qty
              FROM product_variants WHERE active = TRUE ORDER BY price`),
  ]);

  // map variants by product_id
  const vmap = {};
  for (const v of variants.rows) {
    if (!vmap[v.product_id]) vmap[v.product_id] = [];
    vmap[v.product_id].push({
      v: v.volume || 'стандарт',
      price: Number(v.price),
      wholesale: Number(v.wholesale),
      stock: v.stock_qty == null ? null : Number(v.stock_qty),
    });
  }

  // category groups
  const groupMap = {};
  for (const c of categories.rows) {
    const g = c.group_name || 'Інше';
    if (!groupMap[g]) groupMap[g] = { name: g, cats: [] };
    groupMap[g].cats.push(c.id);
  }

  return {
    brands: brands.rows.map(b => ({ id: b.id, name: b.name })),
    categories: categories.rows.map(c => ({ id: c.id, name: c.name, icon: c.icon })),
    category_groups: Object.values(groupMap),
    products: products.rows.map(p => ({
      id: p.id,
      name: p.name,
      brand: p.brand_id,
      category: p.category_id,
      photo: p.photo,
      volumes: vmap[p.id] || [],
      desc: p.description || '',
    })),
    generated_at: new Date().toISOString(),
    cached: false,
  };
}

router.get('/all', async (req, res) => {
  try {
    const now = Date.now();
    if (cache && now - cachedAt < TTL) {
      return res.json({ ...cache, cached: true, cache_age_sec: Math.round((now - cachedAt) / 1000) });
    }
    cache = await build();
    cachedAt = now;
    res.json(cache);
  } catch (e) {
    console.error('[legacy:all]', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/invalidate', (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  cache = null;
  res.json({ ok: true, cleared: true });
});

module.exports = router;
