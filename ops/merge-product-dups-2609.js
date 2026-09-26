#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   СКЛЕЙКА ДУБЛЕЙ ТОВАРОВ (Босс 26.09: «Почисти склады от повторяющихся позиций»).

   Запуск (из любого места):
     node svs-beauty-space/ops/merge-product-dups-2609.js           → --dry (по умолчанию, ничего не пишет)
     node svs-beauty-space/ops/merge-product-dups-2609.js --apply   → склейка в ОДНОЙ транзакции
   БД: DATABASE_URL из backend/.env (или env DB_URL=... для песочницы).

   ЧТО СЧИТАЕТСЯ ДУБЛЕМ
   A) товары: активные products с одинаковыми lower(trim(name)) + brand_id (NULL = NULL);
   B) варианты: активные product_variants одного товара с одинаковым lower(trim(volume)).
   ХРАНИТЕЛЬ группы (вариант): есть остаток (stock_qty или warehouse_stock) → есть категория →
   заполнен unit_ml → больше ссылок (движения/материалы/продажи) → раньше создан → меньше id.

   ЧТО ДЕЛАЕТ --apply (НИЧЕГО НЕ УДАЛЯЕТ ИЗ ТОВАРОВ/ВАРИАНТОВ):
   - перевешивает ссылки с варианта-дубля на вариант-хранитель во всех таблицах (FK + колонки без FK);
   - warehouse_stock (PK variant+warehouse): при конфликте СУММИРУЕТ qty/reserved, avg_cost — средневзвешенно;
   - открытые акты инвентаризации: если в акте есть строка хранителя — строки СКЛАДЫВАЮТСЯ
     (expected = сумма; actual = сумма заполненных, либо NULL если не заполнено ни одно), строка дубля
     удаляется (это черновик подсчёта, не товар); закрытые/отменённые акты — только перевешиваются;
   - прочие уникальные ключи (materials визита, нормы, расходники, поставщики, правила закупки):
     при конфликте — количества суммируются в строку хранителя, строка дубля удаляется, всё в бэкапе;
   - stock_qty хранителя += stock_qty дублей; у дубля stock_qty=0, active=false; товар-дубль active=false;
   - пустые категория / цена за грам / собівартість за грам / unit_ml хранителя дополняются из дубля;
   - salon_stock (замороженный реестр BeautyPro) НЕ ТРОГАЕТСЯ: на его строки ссылается история продаж;
   - исторические JSON (audit_log.meta, domain_events, stock_import_docs.items) не переписываются.
   Перед --apply: полный бэкап всех затронутых строк → ops/_merge_dups_backup_2609.json; запись в audit_log.
   ИНВАРИАНТЫ (до/после, иначе ROLLBACK): по каждой группе сумма stock_qty, остатки warehouse_stock
   по складам, число и сумма stock_movements, суммы продаж/материалов/поставок — не меняются.
   ═══════════════════════════════════════════════════════════════ */
const path = require('path');
const fs = require('fs');
const BACKEND = path.join(__dirname, '..', 'backend');
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env') });
const { Client } = require(path.join(BACKEND, 'node_modules', 'pg'));

const APPLY = process.argv.includes('--apply');
// --canonical (26.09, второй проход): «тот же товар», который точный поиск не видит — одинаковое имя,
// но бренд пустой/другой, или объём написан иначе («250 ml»/«250ml», «1000ml»/«1л», «100мл»/«100ml»).
// Ключ = нормализованные слова имени (порядок/регистр/пунктуация не важны) + канонический объём.
// Только если: у каждой карточки 1 активный вариант; единицы учёта совпадают (граммы с граммами,
// штуки со штуками); бренды не противоречат (не больше одного «настоящего» бренда, NULL/«Інше» не в счёт).
const CANON = process.argv.includes('--canonical');
const BACKUP = process.env.MERGE_BACKUP || path.join(__dirname, CANON ? '_merge_dups_backup_2609_canonical.json' : '_merge_dups_backup_2609.json');
const imp = require(path.join(BACKEND, 'lib', 'stock-import'));
const DB_URL = process.env.DB_URL || process.env.DATABASE_URL;

// Таблицы со ссылкой на вариант. uniq = остальные колонки уникального ключа вместе с variant_id;
// sum = количественные колонки, которые складываются при конфликте.
const VARIANT_REFS = [
  { t: 'stock_movements', c: 'variant_id' },
  { t: 'appointment_materials', c: 'variant_id', uniq: ['appointment_id'], sum: ['qty_used'] },
  { t: 'internal_transfer_items', c: 'variant_id' },
  { t: 'material_consumption_log', c: 'variant_id' },
  { t: 'order_items', c: 'variant_id' },
  { t: 'procedure_materials', c: 'variant_id', uniq: ['norm_id'], sum: ['quantity'] },
  { t: 'purchase_order_items', c: 'variant_id' },
  { t: 'service_consumables', c: 'variant_id', uniq: ['service_id'], sum: ['qty_per_use'], keepKeeper: true },
  { t: 'store_inventory_lines', c: 'variant_id', uniq: ['act_id'], sum: ['expected_qty', 'counted_qty'], noId: true },
  { t: 'store_receipt_items', c: 'variant_id' },
  { t: 'store_sale_items', c: 'variant_id' },
  // warehouse_stock и inventory_audit_items — отдельная логика ниже
];
// Таблицы со ссылкой на товар (text id).
const PRODUCT_REFS = [
  { t: 'stock_movements', c: 'product_id' },
  { t: 'purchase_order_items', c: 'product_id' },
  { t: 'stock_receipt_items', c: 'product_id' },
  { t: 'material_consumption', c: 'product_id' },
  { t: 'ai_sales_offers', c: 'offer_product_id' },
  { t: 'ai_sales_rules', c: 'offer_product_id' },
  { t: 'auto_purchase_rules', c: 'product_id', uniqAlone: true },
  { t: 'supplier_products', c: 'product_id', uniq: ['supplier_id'] },
];

async function tableExists(db, t) {
  const r = await db.query(`SELECT to_regclass('public.' || $1) AS x`, [t]);
  return !!r.rows[0].x;
}

function strictKey(name, volume) {
  // как productSig, но БЕЗ выбрасывания общих слов («color sync» ≠ «sync» — такие пары только на проверку)
  const sizes = [];
  const t = imp.norm(name).replace(/(\d+(?:\.\d+)?)\s*(мл|ml|л|l|кг|kg|гр|г|g)(?![a-zа-яёіїєґ])/g, (m, n, u) => {
    if (/^(гр|г|g)$/.test(u) && !/^\d+$/.test(n)) return m;
    let x = Number(n), uu = /^(мл|ml)$/.test(u) ? 'ml' : /^(л|l)$/.test(u) ? 'l' : /^(кг|kg)$/.test(u) ? 'kg' : 'g';
    if (uu === 'l') { x *= 1000; uu = 'ml'; } if (uu === 'kg') { x *= 1000; uu = 'g'; }
    sizes.push(x + uu); return ' ';
  });
  const words = [...new Set(t.split(' ').filter(Boolean))].sort().join(' ');
  return words + '|' + (sizes[0] || '');
}
const isGramUnit = (v) => /^(г|гр|за грам|g)$/i.test(String(v.volume || '').trim()) || Number(v.unit_ml) === 1;

async function findCanonGroups(db) {
  const r = await db.query(`
    SELECT p.id product_id, p.name, p.brand_id, v.id variant_id, v.volume, v.unit_ml::float unit_ml
      FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active IS NOT FALSE
     WHERE p.active IS NOT FALSE
       AND (SELECT count(*) FROM product_variants x WHERE x.product_id = p.id AND x.active IS NOT FALSE) = 1`);
  const m = new Map();
  for (const x of r.rows) {
    const k = strictKey(x.name, x.volume);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  const out = [], skipped = [];
  for (const [k, xs] of m) {
    if (xs.length < 2) continue;
    const brands = new Set(xs.map(x => x.brand_id).filter(b => b && b !== 'inshe'));
    const units = new Set(xs.map(x => isGramUnit(x) ? 'gram' : 'piece'));
    const label = xs.map(x => `«${x.name}» ${x.volume}`).join(' / ');
    if (units.size > 1) { skipped.push(`${label}: разные единицы учёта (граммы/штуки) — на проверку`); continue; }
    if (brands.size > 1 && !xs.every(x => imp.detectBrand(x.name))) { skipped.push(`${label}: разные бренды ${[...brands].join(',')} — на проверку`); continue; }
    out.push({ kind: 'product', key: k, name: xs[0].name, members: xs.map(x => ({ product_id: x.product_id, variants: [{ id: x.variant_id }] })) });
  }
  return { groups: out, skipped };
}

async function findGroups(db) {
  if (CANON) { const c = await findCanonGroups(db); return { productGroups: c.groups, variantGroups: [], canonSkipped: c.skipped }; }
  // A) дубли товаров
  const a = await db.query(`
    WITH d AS (
      SELECT lower(trim(name)) n, coalesce(brand_id,'') b FROM products
       WHERE active IS NOT FALSE GROUP BY 1,2 HAVING count(*) > 1)
    SELECT p.id product_id, p.name, p.brand_id, p.category_id, p.created_at, p.price_per_gram, p.cost_per_gram,
           d.n || ' | ' || d.b AS gkey,
           (SELECT json_agg(json_build_object('id', v.id, 'volume', v.volume, 'stock_qty', v.stock_qty::float,
                     'unit_ml', v.unit_ml::float) ORDER BY v.id)
              FROM product_variants v WHERE v.product_id = p.id AND v.active IS NOT FALSE) AS variants
      FROM products p JOIN d ON d.n = lower(trim(p.name)) AND d.b = coalesce(p.brand_id,'')
     WHERE p.active IS NOT FALSE
     ORDER BY d.n, p.id`);
  const groups = new Map();
  for (const r of a.rows) {
    if (!groups.has(r.gkey)) groups.set(r.gkey, { kind: 'product', key: r.gkey, name: r.name, members: [] });
    groups.get(r.gkey).members.push(r);
  }
  // B) дубли вариантов внутри одного товара
  const b = await db.query(`
    SELECT v.product_id, p.name, v.id AS variant_id, v.volume
      FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE v.active IS NOT FALSE AND p.active IS NOT FALSE
       AND (v.product_id, lower(trim(v.volume))) IN (
         SELECT product_id, lower(trim(volume)) FROM product_variants
          WHERE active IS NOT FALSE GROUP BY 1,2 HAVING count(*) > 1)
     ORDER BY v.product_id, v.id`);
  const vgroups = new Map();
  for (const r of b.rows) {
    const k = r.product_id + ' | ' + String(r.volume || '').trim().toLowerCase();
    if (!vgroups.has(k)) vgroups.set(k, { kind: 'variant', key: k, name: `${r.name} · ${r.volume}`, variantIds: [] });
    vgroups.get(k).variantIds.push(r.variant_id);
  }
  return { productGroups: [...groups.values()], variantGroups: [...vgroups.values()] };
}

// сведения по варианту для выбора хранителя и для отчёта
async function variantInfo(db, ids) {
  const r = await db.query(`
    SELECT v.id, v.product_id, v.volume, v.stock_qty::float stock_qty, v.unit_ml::float unit_ml,
           p.category_id, p.created_at p_created,
           COALESCE((SELECT json_object_agg(w.warehouse_id, w.qty::float) FROM warehouse_stock w WHERE w.variant_id = v.id), '{}'::json) wh,
           (SELECT count(*)::int FROM stock_movements m WHERE m.variant_id = v.id) mv,
           (SELECT count(*)::int FROM appointment_materials m WHERE m.variant_id = v.id) am,
           (SELECT count(*)::int FROM store_sale_items m WHERE m.variant_id = v.id) ss,
           (SELECT count(*)::int FROM store_receipt_items m WHERE m.variant_id = v.id) sr,
           (SELECT count(*)::int FROM order_items m WHERE m.variant_id = v.id) oi,
           (SELECT count(*)::int FROM procedure_materials m WHERE m.variant_id = v.id) pm,
           (SELECT count(*)::int FROM service_consumables m WHERE m.variant_id = v.id) sc,
           (SELECT count(*)::int FROM inventory_audit_items m WHERE m.variant_id = v.id) ia,
           (SELECT count(*)::int FROM salon_stock m WHERE m.variant_id = v.id) sst
      FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE v.id = ANY($1::int[])`, [ids]);
  const m = new Map();
  for (const x of r.rows) {
    const whSum = Object.values(x.wh || {}).reduce((s, q) => s + Number(q || 0), 0);
    x.hasStock = (x.stock_qty > 0 || whSum > 0) ? 1 : 0;
    x.refs = x.mv + x.am + x.ss + x.sr + x.oi + x.pm + x.sc;
    m.set(x.id, x);
  }
  return m;
}

function pickKeeper(infos) {
  return [...infos].sort((a, b) =>
    b.hasStock - a.hasStock ||
    (b.category_id ? 1 : 0) - (a.category_id ? 1 : 0) ||
    (b.unit_ml ? 1 : 0) - (a.unit_ml ? 1 : 0) ||
    b.refs - a.refs ||
    new Date(a.p_created) - new Date(b.p_created) ||
    a.id - b.id)[0];
}

// Инварианты по набору вариантов (вся группа, до и после)
async function invariants(db, ids) {
  const q = async (sql) => (await db.query(sql, [ids])).rows[0];
  const stock = await q(`SELECT COALESCE(sum(stock_qty),0)::float s FROM product_variants WHERE id = ANY($1::int[])`);
  const wh = (await db.query(`SELECT warehouse_id, sum(qty)::float q, sum(COALESCE(reserved_qty,0))::float r
                                FROM warehouse_stock WHERE variant_id = ANY($1::int[]) GROUP BY 1 ORDER BY 1`, [ids])).rows;
  const mv = await q(`SELECT count(*)::int n, COALESCE(sum(delta),0)::float s FROM stock_movements WHERE variant_id = ANY($1::int[])`);
  const am = await q(`SELECT COALESCE(sum(qty_used),0)::float s FROM appointment_materials WHERE variant_id = ANY($1::int[])`);
  const ss = await q(`SELECT count(*)::int n, COALESCE(sum(qty),0)::float q FROM store_sale_items WHERE variant_id = ANY($1::int[])`);
  const sr = await q(`SELECT count(*)::int n, COALESCE(sum(qty),0)::float q FROM store_receipt_items WHERE variant_id = ANY($1::int[])`);
  const oi = await q(`SELECT count(*)::int n, COALESCE(sum(qty),0)::float q FROM order_items WHERE variant_id = ANY($1::int[])`);
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return JSON.stringify({
    stock: r3(stock.s), wh: wh.map(w => `${w.warehouse_id}=${r3(w.q)}/${r3(w.r)}`),
    moves: `${mv.n}:${r3(mv.s)}`, materials: r3(am.s), store_sales: `${ss.n}:${r3(ss.q)}`,
    receipts: `${sr.n}:${r3(sr.q)}`, orders: `${oi.n}:${r3(oi.q)}`,
  });
}

async function backupRows(db, plan) {
  const vids = plan.flatMap(g => [g.keeper.id, ...g.dups.map(d => d.id)]);
  const pids = [...new Set(plan.flatMap(g => [g.keeper.product_id, ...g.dups.map(d => d.product_id)]))];
  const out = { created_at: new Date().toISOString(), plan: plan.map(g => ({
    group: g.name, keeper_variant: g.keeper.id, keeper_product: g.keeper.product_id,
    dup_variants: g.dups.map(d => d.id), dup_products: g.dupProducts })), tables: {} };
  const grab = async (t, where, params) => {
    if (!(await tableExists(db, t))) return;
    const r = await db.query(`SELECT * FROM ${t} WHERE ${where}`, params);
    if (r.rows.length) out.tables[t] = (out.tables[t] || []).concat(r.rows);
  };
  await grab('products', `id = ANY($1::text[])`, [pids]);
  await grab('product_variants', `id = ANY($1::int[])`, [vids]);
  await grab('warehouse_stock', `variant_id = ANY($1::int[])`, [vids]);
  await grab('inventory_audit_items', `variant_id = ANY($1::int[])`, [vids]);
  for (const r of VARIANT_REFS) if (r.t !== 'stock_movements') await grab(r.t, `${r.c} = ANY($1::int[])`, [vids]);
  await grab('stock_movements', `variant_id = ANY($1::int[]) OR product_id = ANY($2::text[])`, [vids, pids]);
  for (const r of PRODUCT_REFS) if (!['stock_movements', 'purchase_order_items'].includes(r.t)) await grab(r.t, `${r.c} = ANY($1::text[])`, [pids]);
  fs.writeFileSync(BACKUP, JSON.stringify(out, null, 1));
  return Object.fromEntries(Object.entries(out.tables).map(([k, v]) => [k, v.length]));
}

// Перевесить ссылки одного варианта-дубля на хранителя
async function moveVariant(db, dupId, keepId, keepProduct, stats) {
  const inc = (k, n) => { if (n) stats[k] = (stats[k] || 0) + n; };
  for (const r of VARIANT_REFS) {
    if (!(await tableExists(db, r.t))) continue;
    if (r.uniq) {
      // конфликты уникального ключа: строка дубля, у которой есть «двойник» у хранителя
      const on = r.uniq.map(u => `k.${u} IS NOT DISTINCT FROM d.${u}`).join(' AND ');
      const sets = (r.sum || []).map(s => `${s} = CASE WHEN k.${s} IS NULL AND d.${s} IS NULL THEN NULL ELSE COALESCE(k.${s},0) + COALESCE(d.${s},0) END`);
      const conf = await db.query(
        `SELECT d.* FROM ${r.t} d JOIN ${r.t} k ON k.${r.c} = $2 AND ${on} WHERE d.${r.c} = $1`, [dupId, keepId]);
      for (const d of conf.rows) {
        const keyWhere = r.uniq.map((u, i) => `${u} IS NOT DISTINCT FROM $${i + 2}`).join(' AND ');
        const keyVals = r.uniq.map(u => d[u]);
        if (sets.length && !r.keepKeeper) {
          const setSql = (r.sum || []).map((s, i) => `${s} = CASE WHEN ${s} IS NULL AND $${r.uniq.length + 2 + i}::numeric IS NULL THEN NULL ELSE COALESCE(${s},0) + COALESCE($${r.uniq.length + 2 + i}::numeric,0) END`).join(', ');
          await db.query(`UPDATE ${r.t} SET ${setSql} WHERE ${r.c} = $1 AND ${keyWhere}`,
            [keepId, ...keyVals, ...(r.sum || []).map(s => d[s])]);
        }
        await db.query(`DELETE FROM ${r.t} WHERE ${r.c} = $1 AND ${keyWhere}`, [dupId, ...keyVals]);
        inc(`${r.t}:conflict-merged`, 1);
      }
      void sets;
    }
    const u = await db.query(`UPDATE ${r.t} SET ${r.c} = $2 WHERE ${r.c} = $1`, [dupId, keepId]);
    inc(r.t, u.rowCount);
  }
  // warehouse_stock: суммировать по складам
  const ws = await db.query(`SELECT * FROM warehouse_stock WHERE variant_id = $1`, [dupId]);
  for (const w of ws.rows) {
    const k = await db.query(`SELECT * FROM warehouse_stock WHERE variant_id = $1 AND warehouse_id = $2 FOR UPDATE`, [keepId, w.warehouse_id]);
    if (k.rows[0]) {
      const kq = Number(k.rows[0].qty || 0), dq = Number(w.qty || 0);
      const kc = k.rows[0].avg_cost == null ? null : Number(k.rows[0].avg_cost);
      const dc = w.avg_cost == null ? null : Number(w.avg_cost);
      let cost = kc;
      if (kc == null) cost = dc;
      else if (dc != null && kq + dq > 0) cost = Math.round(((kq * kc + dq * dc) / (kq + dq)) * 10000) / 10000;
      await db.query(`UPDATE warehouse_stock SET qty = COALESCE(qty,0) + $3, reserved_qty = COALESCE(reserved_qty,0) + $4,
                             avg_cost = $5, updated_at = NOW() WHERE variant_id = $1 AND warehouse_id = $2`,
        [keepId, w.warehouse_id, dq, Number(w.reserved_qty || 0), cost]);
      await db.query(`DELETE FROM warehouse_stock WHERE variant_id = $1 AND warehouse_id = $2`, [dupId, w.warehouse_id]);
      inc('warehouse_stock:summed', 1);
    } else {
      await db.query(`UPDATE warehouse_stock SET variant_id = $2, updated_at = NOW() WHERE variant_id = $1 AND warehouse_id = $3`, [dupId, keepId, w.warehouse_id]);
      inc('warehouse_stock', 1);
    }
  }
  // акты инвентаризации
  const ia = await db.query(
    `SELECT i.*, a.status FROM inventory_audit_items i JOIN inventory_audits a ON a.id = i.audit_id WHERE i.variant_id = $1`, [dupId]);
  for (const it of ia.rows) {
    const k = it.status === 'in_progress'
      ? await db.query(`SELECT * FROM inventory_audit_items WHERE audit_id = $1 AND variant_id = $2 ORDER BY id LIMIT 1`, [it.audit_id, keepId])
      : { rows: [] };
    if (k.rows[0]) {
      const kk = k.rows[0];
      const actual = (kk.actual_qty == null && it.actual_qty == null) ? null : Number(kk.actual_qty || 0) + Number(it.actual_qty || 0);
      await db.query(`UPDATE inventory_audit_items SET expected_qty = COALESCE(expected_qty,0) + $2, actual_qty = $3,
                             counted_at = COALESCE(counted_at, $4), counted_by = COALESCE(counted_by, $5)
                       WHERE id = $1`,
        [kk.id, Number(it.expected_qty || 0), actual, it.counted_at, it.counted_by]);
      await db.query(`DELETE FROM inventory_audit_items WHERE id = $1`, [it.id]);
      inc('inventory_audit_items:merged-open', 1);
    } else {
      await db.query(`UPDATE inventory_audit_items SET variant_id = $2 WHERE id = $1`, [it.id, keepId]);
      inc('inventory_audit_items', 1);
    }
  }
  // остаток варианта
  const s = await db.query(`SELECT stock_qty FROM product_variants WHERE id = $1 FOR UPDATE`, [dupId]);
  const dq = Number(s.rows[0].stock_qty || 0);
  if (dq) await db.query(`UPDATE product_variants SET stock_qty = COALESCE(stock_qty,0) + $2 WHERE id = $1`, [keepId, dq]);
  // unit_ml хранителя пуст → из дубля
  await db.query(`UPDATE product_variants k SET unit_ml = d.unit_ml FROM product_variants d
                   WHERE k.id = $1 AND d.id = $2 AND k.unit_ml IS NULL AND d.unit_ml IS NOT NULL`, [keepId, dupId]);
  await db.query(`UPDATE product_variants SET stock_qty = 0, active = false WHERE id = $1`, [dupId]);
  void keepProduct;
}

async function moveProduct(db, dupPid, keepPid, stats) {
  const inc = (k, n) => { if (n) stats[k] = (stats[k] || 0) + n; };
  for (const r of PRODUCT_REFS) {
    if (!(await tableExists(db, r.t))) continue;
    if (r.uniqAlone) {
      const k = await db.query(`SELECT 1 FROM ${r.t} WHERE ${r.c} = $1`, [keepPid]);
      if (k.rows[0]) { const d = await db.query(`DELETE FROM ${r.t} WHERE ${r.c} = $1`, [dupPid]); inc(`${r.t}:conflict-dropped`, d.rowCount); continue; }
    } else if (r.uniq) {
      const on = r.uniq.map(u => `k.${u} IS NOT DISTINCT FROM d.${u}`).join(' AND ');
      const d = await db.query(`DELETE FROM ${r.t} d USING ${r.t} k WHERE d.${r.c} = $1 AND k.${r.c} = $2 AND ${on}`, [dupPid, keepPid]);
      inc(`${r.t}:conflict-dropped`, d.rowCount);
    }
    const u = await db.query(`UPDATE ${r.t} SET ${r.c} = $2 WHERE ${r.c} = $1`, [dupPid, keepPid]);
    inc(`${r.t}.${r.c}`, u.rowCount);
  }
  // пустые поля хранителя — из дубля (категория, цена/собівартість за грам)
  await db.query(`UPDATE products k SET category_id = COALESCE(k.category_id, d.category_id),
                         price_per_gram = COALESCE(k.price_per_gram, d.price_per_gram),
                         cost_per_gram = COALESCE(k.cost_per_gram, d.cost_per_gram), updated_at = NOW()
                    FROM products d WHERE k.id = $1 AND d.id = $2`, [keepPid, dupPid]);
  await db.query(`UPDATE products SET active = false, updated_at = NOW() WHERE id = $1`, [dupPid]);
}

async function main() {
  if (!DB_URL) throw new Error('нет DATABASE_URL');
  const db = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const host = (() => { try { return new URL(DB_URL).host; } catch (_) { return '?'; } })();
  console.log(`БД: ${host} · режим: ${APPLY ? 'APPLY (запись)' : 'DRY (только чтение)'}`);
  try {
    await db.query('BEGIN');
    // один исполнитель за раз
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('merge-product-dups-2609'))`);
    const { productGroups, variantGroups, canonSkipped } = await findGroups(db);
    const plan = [];
    const problems = [...(canonSkipped || [])];
    for (const g of productGroups) {
      const vids = [];
      for (const m of g.members) {
        const vs = m.variants || [];
        if (vs.length !== 1) { problems.push(`${g.name}: у товара ${m.product_id} активных вариантов ${vs.length} — группа пропущена`); vids.length = 0; break; }
        vids.push(vs[0].id);
      }
      if (!vids.length) continue;
      const info = await variantInfo(db, vids);
      const keeper = pickKeeper([...info.values()]);
      const dups = [...info.values()].filter(x => x.id !== keeper.id);
      plan.push({ kind: 'product', name: g.name, keeper, dups, dupProducts: dups.map(d => d.product_id), allIds: vids });
    }
    for (const g of variantGroups) {
      const info = await variantInfo(db, g.variantIds);
      const keeper = pickKeeper([...info.values()]);
      const dups = [...info.values()].filter(x => x.id !== keeper.id);
      plan.push({ kind: 'variant', name: g.name, keeper, dups, dupProducts: [], allIds: g.variantIds });
    }

    // таблица «группа → хранитель → что переносится»
    const fmtWh = (w) => Object.entries(w || {}).map(([k, v]) => `${k}=${v}`).join(',') || '—';
    const refsTxt = (x) => ['mv', 'am', 'ss', 'sr', 'oi', 'pm', 'sc', 'ia'].filter(k => x[k]).map(k => `${k}${x[k]}`).join(' ') || '—';
    console.log(`\nГрупп: ${plan.length} (товарных ${plan.filter(p => p.kind === 'product').length}, вариантных ${plan.filter(p => p.kind === 'variant').length}); дублей-вариантов: ${plan.reduce((s, p) => s + p.dups.length, 0)}`);
    console.log('Обозначения: mv движения, am материалы визитов, ss продажи магазина, sr приходы магазина, oi заказы, pm нормы, sc расходники, ia строки актов, sst строки salon_stock (НЕ трогаются)\n');
    for (const g of plan) {
      const k = g.keeper;
      console.log(`■ ${g.name}`);
      console.log(`   ХРАНИТЕЛЬ v${k.id} ${k.product_id} [${k.category_id || 'без категорії'}] остаток ${k.stock_qty} склады ${fmtWh(k.wh)} ссылки ${refsTxt(k)}`);
      for (const d of g.dups) {
        console.log(`   ← дубль v${d.id} ${d.product_id} [${d.category_id || 'без категорії'}] остаток ${d.stock_qty} склады ${fmtWh(d.wh)} ссылки ${refsTxt(d)}${d.sst ? ` · salon_stock ${d.sst} (остаются)` : ''}`);
      }
    }
    if (problems.length) console.log('\n⚠ Пропущено:\n  ' + problems.join('\n  '));

    const before = {};
    for (const g of plan) before[g.name] = await invariants(db, g.allIds);
    const totalMovesBefore = (await db.query(`SELECT count(*)::int n, COALESCE(sum(delta),0)::float s FROM stock_movements`)).rows[0];

    if (!APPLY) {
      await db.query('ROLLBACK');
      console.log('\nDRY: ничего не записано. Для склейки: --apply');
      return;
    }

    const saved = await backupRows(db, plan);
    console.log('\nБэкап:', BACKUP, JSON.stringify(saved));

    const stats = {};
    for (const g of plan) {
      for (const d of g.dups) await moveVariant(db, d.id, g.keeper.id, g.keeper.product_id, stats);
      for (const pid of g.dupProducts) if (pid !== g.keeper.product_id) await moveProduct(db, pid, g.keeper.product_id, stats);
    }

    // инварианты
    let bad = 0;
    for (const g of plan) {
      const after = await invariants(db, g.allIds);
      if (after !== before[g.name]) { bad++; console.log(`✗ ИНВАРИАНТ ${g.name}\n   до:    ${before[g.name]}\n   после: ${after}`); }
      const dupLeft = await db.query(`SELECT count(*)::int n FROM product_variants WHERE id = ANY($1::int[]) AND (active IS NOT FALSE OR stock_qty <> 0)`, [g.dups.map(d => d.id)]);
      if (dupLeft.rows[0].n) { bad++; console.log(`✗ ${g.name}: дубль остался активным/с остатком`); }
    }
    const totalMovesAfter = (await db.query(`SELECT count(*)::int n, COALESCE(sum(delta),0)::float s FROM stock_movements`)).rows[0];
    if (JSON.stringify(totalMovesAfter) !== JSON.stringify(totalMovesBefore)) { bad++; console.log('✗ stock_movements всего изменились', totalMovesBefore, totalMovesAfter); }
    const again = await findGroups(db);
    const left = again.productGroups.length + again.variantGroups.length;
    if (left) { bad++; console.log(`✗ после склейки осталось групп дублей: ${left}`); }
    if (bad) throw new Error(`инварианты не сошлись (${bad}) — ROLLBACK, данные не изменены`);

    await db.query(
      `INSERT INTO audit_log (user_id, user_label, action, entity, entity_id, meta)
       VALUES (NULL, 'ops/merge-product-dups-2609', 'stock.merge_duplicates', 'product', NULL, $1)`,
      [JSON.stringify({ groups: plan.length, dups: plan.reduce((s, p) => s + p.dups.length, 0), backup: path.basename(BACKUP), stats,
        plan: plan.map(g => ({ g: g.name, keep: g.keeper.id, dups: g.dups.map(d => d.id) })) })]);
    await db.query('COMMIT');
    console.log('\nAPPLY OK. Перенесено:', JSON.stringify(stats));
    console.log(`Инварианты сошлись по ${plan.length} группам; stock_movements всего ${totalMovesAfter.n} (сумма ${totalMovesAfter.s}) без изменений; групп дублей осталось: 0`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('ОШИБКА:', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
}

main();
