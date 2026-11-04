#!/usr/bin/env node
// price-cards-0411: картки мініапу = рядки прайсу салону (Instagram «Актуальне», reports/ig-price-0411/prices-ig.md).
// services.price у CRM НЕ змінюється і нічого не видаляється: прайс-ціна живе у service_length_variants.list_price*.
// Дублі/«без матеріалу» ховаються як аліаси процедури (у CRM лишаються активними).
// Ідемпотентний: процедура — за key, варіант — за (процедура, length_code); зайві варіанти → active=false.
// Нові послуги (дитячий манікюр, 6 масажів, креативний макіяж) створюються лише якщо такої назви ще немає.
// Запуск: DATABASE_URL=… node scripts/seed-price-cards-0411.js [--dry]
'use strict';
const { Pool } = require('pg');
const TENANT = '00000000-0000-0000-0000-000000000001';
const TETIANA = 25, KATYA = 73;

const CUT = [{ key: 'cut', label: 'Стрижка під час фарбування', price: 200 }];
const HINT_HAIR = 'Ціна «від»; до +30% за густоти/довжини вище середнього';
const L = (code, level, svc, list, list_to) => ({ code, label: code.replace('-', '–') + ' довжина', level, svc, list, list_to });
const T = (code, label, level, svc, list, extra) => Object.assign({ code, label, level, svc, list }, extra || {});

// Нові послуги CRM: ref — службове ім'я в цьому файлі; cat_from — з якої послуги взяти категорію
const NEW = [
  { ref: 'kid_mani', name: 'Манікюр дитячий', price: 350, dur: 45, cat_from: 88, masters: [20, 71, TETIANA] },
  { ref: 'm_back', name: 'Масаж спини + комірцевої зони', price: 400, dur: 45, cat_from: 20, masters: [KATYA] },
  { ref: 'm_neck', name: 'Масаж комірцевої зони', price: 350, dur: 20, cat_from: 20, masters: [KATYA] },
  { ref: 'm_legs', name: 'Масаж сідниці + ноги + стопи', price: 300, dur: 30, cat_from: 20, masters: [KATYA] },
  { ref: 'm_full', name: 'Загальний масаж', price: 550, dur: 60, cat_from: 20, masters: [KATYA] },
  { ref: 'm_cell', name: 'Антицелюлітний масаж', price: 450, dur: 40, cat_from: 20, masters: [KATYA] },
  { ref: 'm_face', name: 'Масаж обличчя', price: 200, dur: 20, cat_from: 20, masters: [KATYA] },
  { ref: 'mk_creative', name: 'Макіяж креативний', price: 900, dur: 90, cat_from: 84, masters: [38] },
];

// kind: 'length' (волосся, силует) | 'type' (вид послуги)
const P = [
  // ── Волосся ──
  { key: 'bio', title: 'Біовирівнювання', kind: 'length', addons: CUT, hint: HINT_HAIR, keepVariants: true,
    note: 'Прайс: 1-2 від 2900, 3 від 3700, 4 від 4700, 5 від 5800. Чілка 1000 (id42) — онлайн не бронюється.',
    v: [Object.assign(L('2', 2, 25, 2900), { label: '1–2 довжина' }), L('3', 3, 26, 3700), L('4', 4, 31, 4700), L('5', 5, 36, 5800)] },
  { key: 'total_blond', title: 'Вихід з техніки у тотал блонд', kind: 'length', addons: CUT, hint: HINT_HAIR,
    note: 'Освітлення всього полотна + тонування + догляд + гігієна кінчиків + укладка.',
    v: [L('1', 1, 187, 3500), L('2', 2, 187, 4000), L('3', 3, 188, 5000), L('4', 4, 188, 5500), L('5', 5, 189, 6500)] },
  { key: 'complex_dye', title: 'Складне фарбування', kind: 'length', addons: CUT, hint: HINT_HAIR, cat: 'Волосся',
    note: 'Brazilian Blond/Brunette, Air Touch; освітлення, догляд, кінчики, укладка.', alias: [141],
    v: [L('2', 2, 163, 4000), L('3', 3, 163, 5000), L('4', 4, 163, 6500), L('5', 5, 163, 9000)] },
  { key: 'black_out', title: 'Вихід з чорного', kind: 'length', addons: CUT, hint: HINT_HAIR, cat: 'Волосся',
    note: '3 кислотні змивки, лужіння, догляд, стрижка, укладка.', alias: [45],
    v: [L('1', 1, 46, 4000), L('2', 2, 46, 5000), L('3', 3, 46, 6000), L('4', 4, 46, 7500), L('5', 5, 46, 8500)] },
  { key: 'contouring', title: 'Контуринг', kind: 'length', addons: CUT, hint: HINT_HAIR, cat: 'Волосся',
    note: 'Освітлення + тонування пасм біля обличчя.', alias: [60, 61, 182, 183],
    v: [L('1-2', 2, 184, 2500), L('3-4', 4, 184, 2600), L('5', 5, 184, 2700)] },
  { key: 'top_contour', title: 'Часткове висвітлення топ зони + контуринг', kind: 'length', addons: CUT, hint: HINT_HAIR, cat: 'Волосся',
    note: 'Послуга CRM id62 — 60 хв, звірити тривалість.',
    v: [L('1-2', 2, 62, 2600), L('3-4', 4, 62, 2900), L('5', 5, 62, 3100)] },
  { key: 'milir', title: 'Мілірування', kind: 'length', addons: CUT, hint: HINT_HAIR, cat: 'Волосся',
    note: 'Часткове освітлення, догляд, тонування, укладка.', alias: [14, 15, 16, 17, 80, 81, 82, 98, 99, 100],
    v: [L('2', 2, 96, 2700), L('3', 3, 97, 3200), L('4', 4, 97, 3600), L('5', 5, 97, 5000)] },
  { key: 'dye', title: 'Фарбування тон в тон / тонування', kind: 'length', addons: CUT, hint: HINT_HAIR, keepVariants: true,
    note: 'Корені + тонування довжини. Прайс — діапазон.',
    alias: [164, 165, 166, 167, 185, 186, 169, 171, 173, 175, 178, 179, 180, 181, 190, 191, 192, 193],
    v: [L('1', 1, 168, 1400, 2000), L('2', 2, 170, 1500, 2100), L('3', 3, 172, 1700, 2500), L('4', 4, 174, 2000, 2700), L('5', 5, 174, 2300, 3000)] },
  // ── Вії ──
  { key: 'lash_ext', title: 'Нарощування вій', kind: 'type', alias: [113, 109],
    v: [T('classic', 'Класика', 1, 105, 700), T('2d', '2D', 2, 106, 750), T('3d', '3D', 3, 104, 800), T('hollywood', 'Hollywood', 4, 111, 900)] },
  { key: 'lash_led', title: 'LED нарощування вій', kind: 'type',
    v: [T('classic', 'Класика', 1, 8, 700), T('2d', '2D', 2, 2, 750), T('3d', '3D', 3, 4, 800), T('hollywood', 'Hollywood', 4, 6, 900)] },
  { key: 'lash_off', title: 'Зняття вій без подальшого нарощування', kind: 'type', alias: [54],
    v: [T('one', 'Зняття вій', 1, 55, 300)] },
  // ── Нігті: інші майстри / топ-майстер Тетяна ──
  ...[
    ['nail_correction', 'Корекція нарощених нігтів', 67, 66, 750, 800, 850, [68, 69, 70]],
    ['nail_gel', 'Манікюр з покриттям гель-лак', 91, 90, 700, 750, 800, [87]],
    ['nail_mani_w', 'Манікюр жіночий', 88, 89, 450, null, 500, []],
    ['nail_mani_kid', 'Манікюр дитячий', 'kid_mani', null, 350, null, 400, []],
    ['nail_mani_m', 'Манікюр чоловічий', 92, null, 500, null, 550, []],
    ['nail_remove', 'Зняття покриття', 56, null, 200, null, 250, [53]],
    ['nail_repair', 'Ремонт / реставрація нігтя', 138, 139, 100, null, 100, [140]],
    ['nail_design', 'Дизайн (втирка, фольга, френч)', 52, null, 100, null, 100, []],
    ['nail_ext', 'Нарощування нігтів 5–6 довжина', 119, 120, 1000, null, 1100, [115, 116, 118]],
    ['pedi_full', 'Педикюр жіночий повний', 126, 125, 550, null, 600, [124]],
    ['pedi_toes', 'Педикюр тільки пальчики', 127, null, 500, null, 550, [131]],
    ['pedi_m', 'Педикюр чоловічий', 133, 134, 550, null, 650, []],
    ['pedi_gel', 'Педикюр повний з гель-лаком', 130, 129, 750, null, 800, []],
    ['pedi_gel_toes', 'Педикюр гель-лак тільки пальчики', 128, null, 650, null, 700, [132]],
  ].map(([key, title, base, top, list, list_to, list_top, alias]) => ({
    key, title, kind: 'type', top_ids: [TETIANA], alias, hint: key === 'nail_ext' ? 'Ціна «від»' : null,
    v: [T('one', title, 1, base, list, { list_to, top, list_top })] })),
  // ── Масаж (Катя) ──
  { key: 'massage_back', title: 'Масаж спини + комірцевої зони', kind: 'type', v: [T('one', '45 хв', 1, 'm_back', 400)] },
  { key: 'massage_neck', title: 'Масаж комірцевої зони', kind: 'type', v: [T('one', '15–20 хв', 1, 'm_neck', 350)] },
  { key: 'massage_legs', title: 'Масаж сідниці + ноги + стопи', kind: 'type', v: [T('one', '30 хв', 1, 'm_legs', 300)] },
  { key: 'massage_full', title: 'Загальний масаж', kind: 'type', alias: [20, 21, 48, 71, 75, 101, 123],
    v: [T('one', '1 год', 1, 'm_full', 550, { list_to: 600 })] },
  { key: 'massage_cell', title: 'Антицелюлітний масаж', kind: 'type', v: [T('one', '40 хв', 1, 'm_cell', 450, { list_to: 500 })] },
  { key: 'massage_face', title: 'Масаж обличчя', kind: 'type', v: [T('one', '20 хв', 1, 'm_face', 200, { list_to: 250 })] },
  // ── Візаж ──
  { key: 'makeup', title: 'Макіяж', kind: 'type', alias: [83, 233, 234, 235],
    addons: [{ key: 'lashes', label: 'Накладні вії', price: 50 }, { key: 'decolte', label: 'Оформлення декольте', price: 50 },
      { key: 'early', label: 'Запис до 8:00', price: 100 }],
    note: 'CRM «Макіяж денний» (85) = 800, прайс 700. «Весільний» (83) — прихований.',
    v: [T('day', 'Нюдовий / денний', 1, 85, 700), T('evening', 'Вечірній', 2, 84, 800), T('creative', 'Креативний та інший', 3, 'mk_creative', 900)] },
];
const DEACTIVATE_PROCS = ['dye_wash', 'dye_onetone_cut']; // їхні послуги стали аліасами «dye»

async function run(db, { dry = false, log = console.log } = {}) {
  await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
  // 1) нові послуги
  const ref = {};
  for (const n of NEW) {
    const ex = await db.query(`SELECT id FROM services WHERE tenant_id=$1 AND name=$2 AND deleted_at IS NULL ORDER BY id LIMIT 1`, [TENANT, n.name]);
    let id = ex.rows[0] && ex.rows[0].id;
    if (!id) {
      const src = (await db.query(`SELECT category, category_id FROM services WHERE id=$1`, [n.cat_from])).rows[0] || {};
      id = (await db.query(
        `INSERT INTO services (tenant_id, name, category, category_id, duration_min, price, active, internal_note)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,'price-cards-0411: рядок прайсу салону') RETURNING id`,
        [TENANT, n.name, src.category || null, src.category_id || null, n.dur, n.price])).rows[0].id;
      log(`+ послуга ${id} «${n.name}» ${n.price} ₴ ${n.dur} хв`);
    }
    for (const m of n.masters) {
      const r = await db.query(
        `INSERT INTO master_services (tenant_id, master_id, service_id, active)
         SELECT $1,$2,$3,TRUE WHERE NOT EXISTS (SELECT 1 FROM master_services WHERE master_id=$2 AND service_id=$3)`, [TENANT, m, id]);
      if (r.rowCount) log(`  + майстер ${m} → ${id}`);
    }
    ref[n.ref] = id;
  }
  const sid = x => (typeof x === 'string' ? ref[x] : x);
  // 2) перевірка: усі послуги існують
  const ids = [...new Set(P.flatMap(p => (p.alias || []).concat(p.v.flatMap(v => [sid(v.svc), sid(v.top)]))).filter(Boolean))];
  const have = new Set((await db.query(`SELECT id FROM services WHERE id = ANY($1) AND tenant_id=$2`, [ids, TENANT])).rows.map(r => r.id));
  const work = new Set(P.flatMap(p => p.v.flatMap(v => [sid(v.svc), sid(v.top)])).filter(Boolean));
  const miss = [...work].filter(i => !have.has(i));
  if (miss.length) throw new Error('немає послуг: ' + miss.join(','));
  const missAlias = ids.filter(i => !have.has(i) && !work.has(i));
  if (missAlias.length) log(`! аліасів немає в цій базі (пропущено): ${missAlias.join(',')}`);
  for (const p of P) if (p.alias) p.aliasOk = p.alias.filter(a => have.has(a));
  // 3) процедури й варіанти
  let sort = 100, nv = 0;
  for (const p of P) {
    sort += 1;
    const base = sid(p.v[0].svc);
    const cat = p.cat || (await db.query(`SELECT category FROM services WHERE id=$1`, [base])).rows[0].category;
    const r = await db.query(
      `INSERT INTO service_procedures (tenant_id, key, title, category, alias_service_ids, note, sort, addons, top_master_ids, price_hint, variant_kind, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,TRUE)
       ON CONFLICT (tenant_id, key) DO UPDATE SET title=EXCLUDED.title, category=EXCLUDED.category,
         alias_service_ids=ARRAY(SELECT DISTINCT unnest(service_procedures.alias_service_ids || EXCLUDED.alias_service_ids) ORDER BY 1),
         note=COALESCE(EXCLUDED.note, service_procedures.note), addons=EXCLUDED.addons, top_master_ids=EXCLUDED.top_master_ids,
         price_hint=EXCLUDED.price_hint, variant_kind=EXCLUDED.variant_kind, active=TRUE, updated_at=NOW()
       RETURNING id`,
      [TENANT, p.key, p.title, cat, p.aliasOk || [], p.note || null, sort, JSON.stringify(p.addons || []), p.top_ids || [], p.hint || null, p.kind]);
    const pid = r.rows[0].id;
    const old = (await db.query(`SELECT id, length_code FROM service_length_variants WHERE procedure_id=$1`, [pid])).rows;
    const keep = new Set();
    let i = 0;
    for (const v of p.v) {
      i += 10;
      const vals = [sid(v.svc), v.label, v.level, v.list, v.list_to || null, v.list_top || null, null, sid(v.top) || null, i];
      const o = old.find(x => x.length_code === v.code);
      if (o) {
        await db.query(
          `UPDATE service_length_variants SET work_service_id=$2, length_label=$3, level=$4, list_price=$5, list_price_to=$6,
             list_price_top=$7, list_price_top_to=$8, work_service_top_id=$9, sort=$10, active=TRUE, updated_at=NOW() WHERE id=$1`,
          [o.id, ...vals]);
        keep.add(o.id);
      } else {
        const ins = await db.query(
          `INSERT INTO service_length_variants (tenant_id, procedure_id, length_code, length_label, level, work_service_id, material_mode,
             list_price, list_price_to, list_price_top, list_price_top_to, work_service_top_id, sort)
           VALUES ($1,$2,$3,$4,$5,$6,'none',$7,$8,$9,$10,$11,$12) RETURNING id`,
          [TENANT, pid, v.code, vals[1], vals[2], vals[0], vals[3], vals[4], vals[5], vals[6], vals[7], vals[8]]);
        keep.add(ins.rows[0].id);
      }
      nv++;
    }
    const off = old.filter(o => !keep.has(o.id)).map(o => o.id);
    if (off.length) await db.query(`UPDATE service_length_variants SET active=FALSE, updated_at=NOW() WHERE id = ANY($1)`, [off]);
    log(`= ${p.key}: ${p.v.length} варіантів${off.length ? `, вимкнено старих ${off.length}` : ''}`);
  }
  const d = await db.query(`UPDATE service_procedures SET active=FALSE, updated_at=NOW() WHERE tenant_id=$1 AND key = ANY($2) AND active RETURNING key`, [TENANT, DEACTIVATE_PROCS]);
  if (d.rowCount) log(`- вимкнено процедури: ${d.rows.map(x => x.key).join(', ')}`);
  log(`Разом: ${P.length} карток, ${nv} варіантів${dry ? ' (DRY — відкат)' : ''}`);
  return { cards: P.length, variants: nv, ref };
}

module.exports = { P, NEW, run };

if (require.main === module) (async () => {
  const dry = process.argv.includes('--dry');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await run(db, { dry });
    await db.query(dry ? 'ROLLBACK' : 'COMMIT');
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error('ПОМИЛКА:', e.message); process.exitCode = 1; }
  finally { db.release(); await pool.end(); }
})();
