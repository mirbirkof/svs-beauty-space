#!/usr/bin/env node
// price-materials-0411: дублі послуг → active=false (НЕ видалення) з бекапом у backups/hair-dups-0411.json.
// Деактивуємо пару «дубль → лишається» лише якщо: однакова ціна, однакова суть назви, і послуга, що лишається,
// покриває ВСІХ активних майстрів дубля (інакше майстер втратив би послугу) — такі йдуть у список «звірити».
// Запуск: node -r dotenv/config scripts/hair-dups-0411.js [--apply]
'use strict';
const fs = require('fs'), path = require('path');
const { Pool } = require('pg');
const TENANT = '00000000-0000-0000-0000-000000000001';
const PAIRS = [[59, 58], [63, 62], [44, 24], [153, 148], [198, 196], [197, 196], [195, 202], [203, 202], [208, 207], [218, 207],
  [199, 201], [200, 201], [204, 206], [205, 206], [209, 211], [210, 211], [149, 151], [150, 151], [143, 144], [146, 147],
  [155, 156], [158, 160], [159, 160], [29, 30], [39, 40]];
const norm = (s) => String(s || '').toLowerCase().replace(/[()]/g, ' ').replace(/біовирівювання|бовирівювання/g, 'біовирівнювання')
  .replace(/консультация/g, 'консультація').replace(/\s+/g, ' ').replace(/\s*\+\s*/g, '+').trim();

(async () => {
  const apply = process.argv.includes('--apply');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();
  const ok = [], skip = [], backup = { created_at: new Date().toISOString(), note: 'active=false для дублів; відкат: UPDATE services SET active=true WHERE id = ANY(deactivated)', services: [], master_services: [], deactivated: [] };
  try {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
    for (const [dup, keep] of PAIRS) {
      const s = (await db.query(`SELECT * FROM services WHERE id = ANY($1) AND tenant_id=$2`, [[dup, keep], TENANT])).rows;
      const d = s.find(x => x.id === dup), k = s.find(x => x.id === keep);
      if (!d || !k) { skip.push({ dup, keep, why: 'немає послуги' }); continue; }
      if (d.active === false) { skip.push({ dup, keep, why: 'вже неактивна' }); continue; }
      if (Number(d.price) !== Number(k.price)) { skip.push({ dup, keep, why: `різні ціни ${d.price}/${k.price}` }); continue; }
      const nd = norm(d.name).replace(/\(?матеріал\)?/, 'матеріал'), nk = norm(k.name);
      const same = nd.split(' ').sort().join(' ') === nk.replace(/\(?матеріал\)?/, 'матеріал').split(' ').sort().join(' ');
      const ms = (await db.query(`SELECT ms.* FROM master_services ms JOIN masters m ON m.id=ms.master_id
                                   WHERE ms.service_id = ANY($1) AND ms.active IS NOT FALSE AND m.active IS NOT FALSE`, [[dup, keep]])).rows;
      const dm = new Set(ms.filter(x => x.service_id === dup).map(x => x.master_id)), km = new Set(ms.filter(x => x.service_id === keep).map(x => x.master_id));
      const lost = [...dm].filter(m => !km.has(m));
      if (!same) { skip.push({ dup, keep, why: `назви різняться: «${d.name}» / «${k.name}»` }); continue; }
      if (lost.length) { skip.push({ dup, keep, why: `майстри ${lost.join(',')} мають лише дубль` }); continue; }
      backup.services.push(d);
      backup.master_services.push(...(await db.query(`SELECT * FROM master_services WHERE service_id=$1`, [dup])).rows);
      backup.deactivated.push(dup);
      ok.push({ dup, keep, name: d.name, price: Number(d.price) });
    }
    if (apply && backup.deactivated.length) {
      const f = path.join(__dirname, '..', '..', 'backups', 'hair-dups-0411.json');
      if (fs.existsSync(f)) throw new Error('бекап уже є — повторний запуск не потрібен: ' + f);
      fs.writeFileSync(f, JSON.stringify(backup, null, 1));
      await db.query(`UPDATE services SET active = false WHERE id = ANY($1) AND tenant_id=$2`, [backup.deactivated, TENANT]);
    }
    await db.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ apply, deactivate: ok, skipped: skip }, null, 1));
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error('FAIL', e.message); process.exitCode = 1; }
  finally { db.release(); await pool.end(); }
})();
