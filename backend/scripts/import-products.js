#!/usr/bin/env node
/**
 * SVS Beauty World — Import products from js/shop-data.js → PostgreSQL
 *
 * Usage: DATABASE_URL=postgresql://... node scripts/import-products.js
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const SHOP_DATA_PATH = path.join(__dirname, '..', '..', 'js', 'shop-data.js');

function loadShopData() {
  // shop-data.js is browser-style (uses `var`). Evaluate in sandbox.
  const code = fs.readFileSync(SHOP_DATA_PATH, 'utf8');
  const sandbox = {};
  // eslint-disable-next-line no-new-func
  const wrapped = new Function(`${code}; return {SHOP_BRANDS, SHOP_CATEGORIES, SHOP_CATEGORY_GROUPS, SHOP_PRODUCTS};`);
  return wrapped.call(sandbox);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_URL env (Neon connection string).');
    process.exit(1);
  }

  const { SHOP_BRANDS, SHOP_CATEGORIES, SHOP_CATEGORY_GROUPS, SHOP_PRODUCTS } = loadShopData();
  console.log(`Loaded: ${SHOP_BRANDS.length} brands, ${SHOP_CATEGORIES.length} categories, ${SHOP_PRODUCTS.length} products`);

  // Map category → group
  const catToGroup = {};
  SHOP_CATEGORY_GROUPS.forEach(g => g.cats.forEach(c => { catToGroup[c] = g.name; }));

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connected to Postgres.');

  try {
    await client.query('BEGIN');

    // Brands
    for (const b of SHOP_BRANDS) {
      await client.query(
        `INSERT INTO brands(id, name) VALUES($1, $2)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [b.id, b.name]
      );
    }
    console.log(`✓ Brands: ${SHOP_BRANDS.length}`);

    // Categories
    for (const c of SHOP_CATEGORIES) {
      await client.query(
        `INSERT INTO categories(id, name, icon, group_name) VALUES($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, icon = EXCLUDED.icon, group_name = EXCLUDED.group_name`,
        [c.id, c.name, c.icon || null, catToGroup[c.id] || null]
      );
    }
    console.log(`✓ Categories: ${SHOP_CATEGORIES.length}`);

    // Products + variants
    let productCount = 0;
    let variantCount = 0;
    for (const p of SHOP_PRODUCTS) {
      await client.query(
        `INSERT INTO products(id, name, brand_id, category_id, photo, description, active)
         VALUES($1, $2, $3, $4, $5, $6, TRUE)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           brand_id = EXCLUDED.brand_id,
           category_id = EXCLUDED.category_id,
           photo = EXCLUDED.photo,
           description = EXCLUDED.description,
           updated_at = NOW()`,
        [p.id, p.name, p.brand, p.category, p.photo || null, p.desc || null]
      );
      productCount++;

      // Reset variants for this product (simpler than diffing)
      await client.query(`DELETE FROM product_variants WHERE product_id = $1`, [p.id]);
      for (const v of (p.volumes || [])) {
        await client.query(
          `INSERT INTO product_variants(product_id, volume, price, wholesale, sku, stock_qty, active)
           VALUES($1, $2, $3, $4, $5, 0, TRUE)`,
          [p.id, v.v, v.price, v.wholesale || null, `${p.id}::${v.v}`]
        );
        variantCount++;
      }
    }
    console.log(`✓ Products: ${productCount}, Variants: ${variantCount}`);

    await client.query('COMMIT');
    console.log('\nImport complete.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Import FAILED:', e.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
