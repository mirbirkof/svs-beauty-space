#!/usr/bin/env node
// Песочниця (QA_DB_URL) — набір товарів з РЕАЛЬНИМИ назвами з проду (фарби Extremo / Socolor / Eterna,
// шампуні, маски, окисники), щоб показати порядок складу й інвентаризації «до/після» (задача crm-sort-2609).
// ТІЛЬКИ QA-база: на прод-URL відмовляється працювати. Усе, що створює, має id з префіксом qasort-
// (+ список створених довідників у /tmp/qasort-state.json) і прибирається режимом --clean.
//   node ops/seed-sort-fixtures-2609.js --seed /tmp/prods.json
//   node ops/seed-sort-fixtures-2609.js --clean
require('/home/client/workspace/svs-beauty-space/backend/node_modules/dotenv').config({ path: '/home/client/workspace/svs-beauty-space/backend/.env' });
const { Client } = require('/home/client/workspace/svs-beauty-space/backend/node_modules/pg');
const fs = require('fs');
const T = '00000000-0000-0000-0000-000000000001';
const STATE = '/tmp/qasort-state.json';
const QA = process.env.QA_DB_URL;
if (!QA || QA === process.env.DATABASE_URL) { console.error('QA_DB_URL не задано або збігається з продом — стоп'); process.exit(2); }

(async () => {
  const db = new Client({ connectionString: QA, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const mode = process.argv[2];
  if (mode === '--clean') {
    const pids = (await q(`SELECT id FROM products WHERE id LIKE 'qasort-%'`)).map(r => r.id);
    const vids = (await q(`SELECT id FROM product_variants WHERE product_id = ANY($1::text[])`, [pids])).map(r => r.id);
    await q(`DELETE FROM inventory_audit_items WHERE variant_id = ANY($1::int[])`, [vids]);
    await q(`DELETE FROM store_inventory_lines WHERE variant_id = ANY($1::int[])`, [vids]);
    await q(`DELETE FROM warehouse_stock WHERE variant_id = ANY($1::int[])`, [vids]);
    await q(`DELETE FROM stock_movements WHERE variant_id = ANY($1::int[])`, [vids]);
    await q(`DELETE FROM product_variants WHERE id = ANY($1::int[])`, [vids]);
    await q(`DELETE FROM products WHERE id = ANY($1::text[])`, [pids]);
    const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { cats: [], brands: [], audits: [], storeActs: [] };
    if (st.audits?.length) await q(`DELETE FROM inventory_audits WHERE id = ANY($1::int[])`, [st.audits]);
    if (st.storeActs?.length) { await q(`DELETE FROM store_inventory_lines WHERE act_id = ANY($1::int[])`, [st.storeActs]); await q(`DELETE FROM store_inventory_acts WHERE id = ANY($1::int[])`, [st.storeActs]); }
    for (const c of st.cats || []) await q(`DELETE FROM categories WHERE tenant_id=$1 AND id=$2 AND NOT EXISTS (SELECT 1 FROM products WHERE category_id=$2)`, [T, c]);
    for (const b of st.brands || []) await q(`DELETE FROM brands WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM products WHERE brand_id=$1)`, [b]);
    fs.rmSync(STATE, { force: true });
    console.log(`прибрано: товарів ${pids.length}, варіантів ${vids.length}`);
    await db.end(); return;
  }
  if (mode !== '--seed') { console.error('режим: --seed <prods.json> | --clean'); process.exit(2); }
  const P = JSON.parse(fs.readFileSync(process.argv[3] || '/tmp/prods.json', 'utf8'));
  const pick = P.filter(p => /^(extremo|socolor|eterna|color sync|sync|synk)\b/i.test(p.name.trim())
    || /шампунь|маска|окисник|кондиціонер|пігмент|термозахист|набір/i.test(p.name)).slice(0, 420);
  const st = { cats: [], brands: [], audits: [], storeActs: [] };
  const haveCats = new Set((await q(`SELECT id FROM categories WHERE tenant_id=$1`, [T])).map(r => r.id));
  const haveBrands = new Set((await q(`SELECT id FROM brands`)).map(r => r.id));
  const BR = { matrix: 'Matrix', loreal: "L'Oréal", raywell: 'Raywell', envie: 'Envie', extremo: 'Extremo', invidia: 'Invidia', inshe: 'Інше' };
  for (const p of pick) {
    if (p.category_id && !haveCats.has(p.category_id)) {
      await q(`INSERT INTO categories (id, name, tenant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [p.category_id, p.category_id, T]);
      haveCats.add(p.category_id); st.cats.push(p.category_id);
    }
    if (p.brand_id && !haveBrands.has(p.brand_id)) {
      await q(`INSERT INTO brands (id, name, tenant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [p.brand_id, BR[p.brand_id] || p.brand_id, T]);
      haveBrands.add(p.brand_id); st.brands.push(p.brand_id);
    }
  }
  // регістр/пробіли: дві картки однієї серії різним написанням — мають стояти поруч
  pick.push({ id: 'x-9m-a', name: 'socolor 9m', brand_id: null, category_id: 'krasky', ppg: 12, vols: 'за грам' });
  pick.push({ id: 'x-9m-b', name: 'SOCOLOR  9M ', brand_id: 'matrix', category_id: null, ppg: null, vols: '90 мл' });
  let i = 0, nV = 0; const storeVids = [];
  for (const p of pick) {
    const pid = 'qasort-' + String(p.id).slice(0, 40) + '-' + (i++);
    await q(`INSERT INTO products (id, name, brand_id, category_id, price_per_gram, active, tenant_id) VALUES ($1,$2,$3,$4,$5,true,$6)`,
      [pid, p.name, p.brand_id || null, p.category_id || null, p.ppg || null, T]);
    const vols = String(p.vols || 'стандарт').split('|').slice(0, 3);
    for (const [k, vol] of vols.entries()) {
      const gram = /грам|^г$/.test(vol);
      const stock = (i * 37 + k * 11) % 9 === 0 ? 0 : gram ? ((i * 53) % 180) : ((i + k) % 7);
      const r = await q(`INSERT INTO product_variants (product_id, volume, price, wholesale, stock_qty, unit_ml, active, tenant_id)
                         VALUES ($1,$2,$3,$4,$5,$6,true,$7) RETURNING id`,
        [pid, vol, gram ? 12 : 300 + (i % 5) * 50, gram ? 180 : 200, stock, gram ? 60 : 1, T]);
      nV++;
      if (!gram && storeVids.length < 40 && i % 3 === 0) storeVids.push(r[0].id);
    }
  }
  for (const [k, vid] of storeVids.entries())
    await q(`INSERT INTO warehouse_stock (variant_id, warehouse_id, qty, avg_cost) VALUES ($1,'store',$2,$3)
             ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty=EXCLUDED.qty`, [vid, k % 6, 150 + k]);
  fs.writeFileSync(STATE, JSON.stringify(st));
  console.log(`засіяно: товарів ${pick.length}, варіантів ${nV}, на складі магазину ${storeVids.length}; нові довідники: кат ${st.cats.join(',') || '—'}, бренди ${st.brands.join(',') || '—'}`);
  await db.end();
})().catch(e => { console.error(e); process.exit(1); });
