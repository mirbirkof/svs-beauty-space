#!/usr/bin/env node
// price-materials-0411: засів «процедура → варіант довжини» з НАЯВНИХ послуг CRM (ціни не змінюються).
// Ідемпотентний: процедура за key; варіанти вставляються лише якщо в процедури їх ще немає
// (правки адміна з CRM не перетираються). Запуск: node -r dotenv/config scripts/seed-hair-variants-0411.js [--dry]
'use strict';
const { Pool } = require('pg');
const TENANT = '00000000-0000-0000-0000-000000000001';
const CM_NOTE = 'см — за шкалою біовирівнювання (2 = до 25, 3 = до 45, 4 = до 60, 5 = до 80); звірити з прайсом';
// [code, label, cm_from, cm_to, level, work, material_service | null]
const P = [
  { key: 'bio', title: 'Біовирівнювання', sort: 10, mode: 'separate',
    note: 'Варіанти — набір «до N см» (25/93, 26/94, 31/95, 36/41). Набір «N довжина робота/матеріал» (24/23, 30/28, 34/32, 40/38) — аліаси, звірити з Боссом.',
    alias: [22, 23, 24, 27, 28, 29, 30, 32, 34, 37, 38, 39, 40, 44],
    v: [['2', '2 довжина', null, 25, 2, 25, 93], ['3', '3 довжина', 25, 45, 3, 26, 94], ['4', '4 довжина', 45, 60, 4, 31, 95], ['5', '5 довжина', 60, 80, 5, 36, 41]] },
  { key: 'cold', title: 'Холодне відновлення', sort: 20, mode: 'separate', note: CM_NOTE,
    alias: [195, 197, 198, 199, 200, 203, 204, 205, 208, 209, 210, 218],
    v: [['1-2', '1–2 довжина', null, 25, 2, 201, 196], ['3-4', '3–4 довжина', 25, 60, 4, 206, 202], ['5-6', '5–6 довжина', 60, null, 6, 211, 207]] },
  { key: 'cold_bio', title: 'Холодне відновлення Biomimetic', sort: 21, mode: 'separate', note: CM_NOTE, alias: [],
    v: [['1-2', '1–2 довжина', null, 25, 2, 212, 217], ['3-4', '3–4 довжина', 25, 60, 4, 213, 214], ['5-6', '5–6 довжина', 60, null, 6, 215, 216]] },
  { key: 'dye', title: 'Фарбування', sort: 30, mode: 'extra', note: 'Робота без барвників; барвник рахується за фактом. ' + CM_NOTE, alias: [],
    v: [['1', '1 довжина', null, null, 1, 168], ['2', '2 довжина', null, 25, 2, 170], ['3', '3 довжина', 25, 45, 3, 172], ['4', '4 довжина', 45, 60, 4, 174]] },
  { key: 'dye_wash', title: 'Фарбування + миття', sort: 31, mode: 'extra', note: 'Робота без барвників. ' + CM_NOTE, alias: [],
    v: [['1', '1 довжина', null, null, 1, 164], ['2', '2 довжина', null, 25, 2, 165], ['3', '3 довжина', 25, 45, 3, 166], ['4', '4 довжина', 45, 60, 4, 167]] },
  { key: 'dye_onetone_cut', title: 'Фарбування однотон + стрижка', sort: 32, mode: 'extra', note: 'Робота без барвників. ' + CM_NOTE, alias: [],
    v: [['1-2', '1–2 довжина', null, 25, 2, 185], ['3-4', '3–4 довжина', 25, 60, 4, 186]] },
  { key: 'total_blond', title: 'Фарбування тотал блонд', sort: 33, mode: 'extra', note: 'Освітлення + тонування + догляд; чи входить матеріал — у назві не сказано, звірити. ' + CM_NOTE, alias: [],
    v: [['1-2', '1–2 довжина', null, 25, 2, 187], ['3-4', '3–4 довжина', 25, 60, 4, 188], ['5-6', '5–6 довжина', 60, null, 6, 189]] },
  { key: 'cut_w', title: 'Стрижка жіноча', sort: 40, mode: 'none', note: 'Матеріал не потрібен. «Стрижка жіноча» без довжини (144, 1000) — аліас. ' + CM_NOTE, alias: [144],
    v: [['1-2', '1–2 довжина', null, 25, 2, 145], ['3-4', '3–4 довжина', 25, 60, 4, 147]] },
];

(async () => {
  const dry = process.argv.includes('--dry');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
    const ids = [...new Set(P.flatMap(p => p.alias.concat(p.v.flatMap(v => [v[5], v[6]]))).filter(Boolean))];
    const have = new Set((await db.query(`SELECT id FROM services WHERE id = ANY($1) AND tenant_id = $2`, [ids, TENANT])).rows.map(r => r.id));
    const miss = ids.filter(i => !have.has(i));
    if (miss.length) throw new Error('немає послуг: ' + miss.join(','));
    for (const p of P) {
      const r = await db.query(
        `INSERT INTO service_procedures (tenant_id, key, title, category, alias_service_ids, note, sort)
         VALUES ($1,$2,$3,'Волосся',$4,$5,$6)
         ON CONFLICT (tenant_id, key) DO UPDATE SET updated_at = NOW() RETURNING id`,
        [TENANT, p.key, p.title, p.alias, p.note, p.sort]);
      const pid = r.rows[0].id;
      const n = (await db.query(`SELECT count(*)::int n FROM service_length_variants WHERE procedure_id = $1`, [pid])).rows[0].n;
      if (n) { console.log(`= ${p.key}: вже ${n} варіантів`); continue; }
      let i = 0;
      for (const [code, label, from, to, level, work, mat] of p.v) {
        await db.query(
          `INSERT INTO service_length_variants (tenant_id, procedure_id, length_code, length_label, cm_from, cm_to, level,
              work_service_id, material_mode, material_service_id, sort)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [TENANT, pid, code, label, from, to, level, work, mat ? 'separate' : p.mode, mat || null, (i += 10)]);
      }
      console.log(`+ ${p.key}: ${p.v.length} варіантів`);
    }
    await db.query(dry ? 'ROLLBACK' : 'COMMIT');
    console.log(dry ? 'DRY — відкат' : 'OK');
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error('FAIL', e.message); process.exitCode = 1; }
  finally { db.release(); await pool.end(); }
})();
module.exports = { P };
