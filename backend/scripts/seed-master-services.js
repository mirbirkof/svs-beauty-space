// Сід master_services з BeautyPro mapping АЛЕ тільки для АКТИВНИХ майстрів нашої БД.
// BeautyPro налаштований не до кінця → довіряємо лише перетину з нашими active=true майстрами.
// Звільнені (active=false) відсікаються автоматично. Ідемпотентно (ON CONFLICT update).
// Джерело BP-даних: живий svs-booking-api (має ключі BeautyPro).
require('dotenv').config();
const { Pool } = require('pg');
const https = require('https');

const url = process.env.DATABASE_URL;
const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
const BP = 'https://svs-booking-api.onrender.com/api/booking';

function get(u) {
  return new Promise((res, rej) => {
    https.get(u, { timeout: 60000 }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

(async () => {
  const dry = process.argv.includes('--dry');
  console.log('Fetching BeautyPro masters+services...');
  const [bpMasters, bpServices] = await Promise.all([get(BP + '/masters'), get(BP + '/services')]);
  console.log(`BP: ${bpMasters.length} masters, ${bpServices.length} services`);

  // Наші активні майстри з beautypro_id → map bp_id -> our master_id
  const mRows = (await pool.query(
    `SELECT id, name, beautypro_id FROM masters WHERE active = true AND beautypro_id IS NOT NULL`
  )).rows;
  const mByBp = new Map(mRows.map(r => [String(r.beautypro_id), r]));
  console.log(`Our active masters with beautypro_id: ${mRows.length}`);

  // Наші послуги з beautypro_id → map bp_id -> our service_id
  const sRows = (await pool.query(
    `SELECT id, name, beautypro_id FROM services WHERE beautypro_id IS NOT NULL AND deleted_at IS NULL`
  )).rows;
  const sByBp = new Map(sRows.map(r => [String(r.beautypro_id), r]));
  console.log(`Our services with beautypro_id: ${sRows.length}`);

  let pairs = 0, skippedM = 0, skippedS = 0;
  const toInsert = [];
  for (const bm of bpMasters) {
    const om = mByBp.get(String(bm.id));
    if (!om) { if ((bm.services || []).length) skippedM++; continue; } // не активний/нема в нас
    for (const bs of (bm.services || [])) {
      const os = sByBp.get(String(bs.id));
      if (!os) { skippedS++; continue; }
      toInsert.push({ master_id: om.id, service_id: os.id, price: bs.price ?? null });
      pairs++;
    }
  }
  console.log(`Pairs to seed: ${pairs} (skipped: ${skippedM} masters not-active/unknown, ${skippedS} services unknown)`);

  if (dry) {
    // покажемо приклад: війки
    const lash = bpServices.filter(s => /вій|ресни/i.test(s.name)).map(s => String(s.id));
    const lashSet = new Set(lash);
    const lashMasters = new Set();
    for (const bm of bpMasters) {
      const om = mByBp.get(String(bm.id)); if (!om) continue;
      if ((bm.services || []).some(x => lashSet.has(String(x.id)))) lashMasters.add(om.name);
    }
    console.log('DRY. Lash masters after active-filter:', [...lashMasters].join(', ') || '(none)');
    await pool.end(); return;
  }

  // upsert
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const p of toInsert) {
      await c.query(
        `INSERT INTO master_services (master_id, service_id, price, source, active)
         VALUES ($1,$2,$3,'beautypro_seed',true)
         ON CONFLICT (tenant_id, master_id, service_id)
         DO UPDATE SET price = EXCLUDED.price, active = true, updated_at = NOW()`,
        [p.master_id, p.service_id, p.price]
      );
    }
    await c.query('COMMIT');
    console.log(`Seeded ${toInsert.length} master_services rows.`);
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }

  const cnt = (await pool.query('SELECT count(*) n FROM master_services')).rows[0].n;
  console.log('Total master_services rows now:', cnt);
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
