#!/usr/bin/env node
/* ════════════════════════════════════════════
   Regenerate static js/shop-data.js from DB.
   Используется watchdog'ом при ротации тоннеля
   и любой раз когда меняем товары — чтобы витрина
   на GitHub Pages показывала актуальные товары
   БЕЗ зависимости от live API при загрузке.
   ════════════════════════════════════════════ */
require('dotenv').config({ path: __dirname + '/../.env' });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const OUT = path.resolve(__dirname, '../../js/shop-data.js');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('[regen] DATABASE_URL missing'); process.exit(1);
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const brands = (await pool.query(
    `SELECT id, name FROM brands ORDER BY name`
  )).rows;

  const categories = (await pool.query(
    `SELECT id, name, icon FROM categories ORDER BY name`
  )).rows;

  // group categories — пока загружаем из старого файла, потому что таблицы category_groups может не быть
  let groups = [];
  try {
    const g = await pool.query(
      `SELECT name, cats FROM category_groups ORDER BY display_order`
    );
    groups = g.rows;
  } catch (e) {
    // Fallback: парсим из существующего файла
    try {
      const old = fs.readFileSync(OUT, 'utf8');
      const m = old.match(/var SHOP_CATEGORY_GROUPS = (\[.*?\]);/s);
      if (m) groups = JSON.parse(m[1]);
    } catch (_) {}
  }

  const prodRes = await pool.query(
    `SELECT p.id, p.name, p.brand_id, p.category_id, p.photo, p.description,
            COALESCE(json_agg(
              json_build_object(
                'v', pv.volume,
                'price', pv.price::float,
                'wholesale', pv.wholesale::float,
                'stock', COALESCE(pv.stock_qty, 0),
                'variant_id', pv.id
              ) ORDER BY pv.id
            ) FILTER (WHERE pv.id IS NOT NULL AND pv.active = true), '[]'::json) AS volumes
     FROM products p
     LEFT JOIN product_variants pv ON pv.product_id = p.id
     WHERE p.active = true
     GROUP BY p.id
     ORDER BY p.brand_id, p.name`
  );
  const products = prodRes.rows.map(p => ({
    id: p.id,
    name: p.name,
    brand: p.brand_id,
    category: p.category_id,
    photo: p.photo || '',
    volumes: p.volumes || [],
    desc: p.description || ''
  }));

  await pool.end();

  const date = new Date().toISOString().slice(0, 10);
  const body =
`/* SVS Beauty Space — Shop Data (auto-generated from DB)
   Generated: ${new Date().toISOString()}
   Total: ${products.length} products, ${brands.length} brands, ${categories.length} categories */

var SHOP_BRANDS = ${JSON.stringify(brands)};

var SHOP_CATEGORIES = ${JSON.stringify(categories)};

var SHOP_CATEGORY_GROUPS = ${JSON.stringify(groups)};

var SHOP_PRODUCTS = ${JSON.stringify(products, null, 0)};

var SHOP_DATA_SOURCE = 'static-db';
var SHOP_DATA_GENERATED = '${new Date().toISOString()}';
`;

  fs.writeFileSync(OUT, body, 'utf8');
  const size = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log(`[regen] wrote ${OUT} (${size} KB, ${products.length} products)`);
})().catch(e => { console.error('[regen] fatal:', e.message); process.exit(2); });
