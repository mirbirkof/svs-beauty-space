// price-cards-0411 e2e на QA (окремий сервер :3062 поверх QA_DB_URL, сид seed-price-cards-0411 уже застосований у QA):
//  • каталог: «Манікюр жіночий» — одна картка «від 450», top_master_ids=[25], послуги 88/89 окремо не видно;
//    біозавивка — 4 довжини за прайсом + опція «стрижка +200» і підказка «до +30%»;
//  • бронь нігтів: Тетяна (25) → у візит іде топ-послуга 89, оцінка 500; Анжела (20) → послуга 88, оцінка 450;
//  • бронь волосся з опцією cut → оцінка = прайс + 200, у назві «+ Стрижка під час фарбування»; чужий ключ опції ігнорується;
//  • services.price у CRM бронь не змінює.
// Фікстури: графік на 2 дні (source=qa-price-cards-0411) + клієнти 78xxxxxxxx — прибираються в after.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { startQaServer } = require('./_qa-server');
const { Client } = require('pg');
const { sign } = require('../lib/tg-initdata');

const PORT = 3062;
const TENANT = '00000000-0000-0000-0000-000000000001';
const FIX_SRC = 'qa-price-cards-0411';
const BOT = '7000000002:QA-' + crypto.randomBytes(10).toString('hex');
const uids = [], apIds = [];
let db, S, D0;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const initFor = (user) => sign({ auth_date: Math.floor(Date.now() / 1000), query_id: 'AAp' + user.id, user }, BOT);
async function call(init, method, url, body) {
  const res = await fetch(S.base + '/api/miniapp' + url, { method,
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': init }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}
async function readyUser() {
  const u = { id: 7800000000 + Math.floor(Math.random() * 99999999), first_name: 'QA Прайс' }; uids.push(u.id);
  const init = initFor(u);
  const r = await call(init, 'POST', '/contact', { phone: '+38098' + String(Math.floor(1e6 + Math.random() * 8.9e6)), name: 'QA Прайс ' + String(u.id).slice(-4) });
  assert.strictEqual(r.status, 200, 'contact: ' + JSON.stringify(r.body));
  return init;
}
async function firstSlot(init, service, master) {
  for (const d of [D0, D0p1]) {
    const r = await call(init, 'GET', `/slots?service=${service}&master=${master}&date=${d}`);
    assert.strictEqual(r.status, 200, 'slots ' + JSON.stringify(r.body));
    const sl = (r.body.slots || []).find(s => Number(s.master_id) === master);
    if (sl) return { date: d, start_min: sl.start_min };
  }
  throw new Error(`немає слотів: послуга ${service}, майстер ${master}`);
}
let D0p1, HAIR_M, nail, bio;

before(async () => {
  db = new Client({ connectionString: process.env.QA_DB_URL }); await db.connect();
  await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
  [{ d: D0 }] = await q(`SELECT ((now() AT TIME ZONE 'Europe/Kyiv')::date + 2)::text d`);
  [{ d: D0p1 }] = await q(`SELECT ($1::date + 1)::text d`, [D0]);
  nail = (await q(`SELECT v.id, v.work_service_id, v.work_service_top_id FROM service_procedures p JOIN service_length_variants v ON v.procedure_id=p.id
                    WHERE p.key='nail_mani_w' AND v.active`))[0];
  bio = (await q(`SELECT v.id, v.work_service_id, v.list_price FROM service_procedures p JOIN service_length_variants v ON v.procedure_id=p.id
                   WHERE p.key='bio' AND v.active ORDER BY v.level, v.id LIMIT 1`))[0];
  assert.ok(nail && bio, 'сид price-cards-0411 не застосований у QA');
  HAIR_M = (await q(`SELECT m.id FROM master_services x JOIN masters m ON m.id=x.master_id WHERE x.service_id=$1 AND x.active IS NOT FALSE
                      AND m.active IS NOT FALSE AND m.online_booking_enabled IS NOT FALSE ORDER BY m.id LIMIT 1`, [bio.work_service_id]))[0].id;
  // графік 10:00–18:00 на D0, D0+1 — лише там, де в майстра цього дня немає ручного дня
  await q(`INSERT INTO master_schedule_days (master_id, work_date, start_time, end_time, tenant_id, source)
           SELECT m, $1::date + i, '10:00', '18:00', $2, $3 FROM unnest($4::int[]) m, generate_series(0,1) i
            WHERE NOT EXISTS (SELECT 1 FROM master_schedule_days d WHERE d.master_id=m AND d.work_date=$1::date + i)`,
  [D0, TENANT, FIX_SRC, [25, 20, HAIR_M]]);
  S = await startQaServer({ port: PORT, extraEnv: { TELEGRAM_BOT_TOKEN: BOT, ADMIN_TG_CHAT: '', BOT_TEXT_BOOKING: '' } });
});
after(async () => {
  try {
    if (apIds.length) {
      await q(`DELETE FROM booking_reminders WHERE appointment_id = ANY($1::int[])`, [apIds]).catch(() => {});
      await q(`DELETE FROM online_bookings WHERE appointment_id = ANY($1::int[]) OR legacy_appointment_ref = ANY($2::text[])`, [apIds, apIds.map(String)]).catch(e => console.error('cleanup ob', e.message));
      await q(`DELETE FROM appointment_services WHERE appointment_id = ANY($1::int[])`, [apIds]).catch(() => {});
      await q(`DELETE FROM appointments WHERE id = ANY($1::int[])`, [apIds]).catch(e => console.error('cleanup ap', e.message));
    }
    if (uids.length) {
      const cl = (await q(`SELECT id FROM clients WHERE telegram_id::text = ANY($1::text[])`, [uids.map(String)])).map(r => r.id);
      if (cl.length) {
        const rest = (await q(`SELECT id FROM appointments WHERE client_id = ANY($1::int[])`, [cl])).map(r => r.id);
        if (rest.length) {
          await q(`DELETE FROM online_bookings WHERE appointment_id = ANY($1::int[])`, [rest]).catch(() => {});
          await q(`DELETE FROM appointments WHERE id = ANY($1::int[])`, [rest]).catch(() => {});
        }
        await q(`DELETE FROM online_bookings WHERE client_id = ANY($1::int[])`, [cl]).catch(() => {});
        await q(`DELETE FROM clients WHERE id = ANY($1::int[])`, [cl]).catch(e => console.error('cleanup cl', e.message));
      }
    }
    await q(`DELETE FROM master_schedule_days WHERE source=$1`, [FIX_SRC]).catch(e => console.error('cleanup sched', e.message));
  } finally { if (S) S.stop(); await db.end(); }
});

test('каталог: нігті «від 450» однією карткою з топ-майстром, волосся з опцією стрижки', async () => {
  const init = await readyUser();
  const r = await call(init, 'GET', '/catalog');
  assert.strictEqual(r.status, 200);
  const all = r.body.categories.flatMap(c => c.services);
  const mani = all.filter(s => s.name === 'Манікюр жіночий');
  assert.strictEqual(mani.length, 1, 'одна картка манікюру');
  assert.strictEqual(mani[0].price, 450); assert.strictEqual(mani[0].price_from, true);
  assert.deepStrictEqual(mani[0].top_master_ids, [25]);
  assert.ok(!all.some(s => s.id === 88 || s.id === 89), 'послуги 88/89 окремо не показуються');
  const b = all.find(s => s.proc_id && s.variants && s.variants.some(v => v.id === bio.id));
  assert.ok(b, 'картка біозавивки');
  assert.deepStrictEqual(b.variants.map(v => v.list), [2900, 3700, 4700, 5800]);
  assert.deepStrictEqual((b.addons || []).map(a => [a.key, a.price]), [['cut', 200]]);
  assert.match(b.price_hint || '', /30%/);
});

test('бронь нігтів: Тетяна → топ-послуга і 500 ₴, Анжела → базова і 450 ₴', async () => {
  const before = (await q(`SELECT id, price FROM services WHERE id = ANY($1::int[]) ORDER BY id`, [[nail.work_service_id, nail.work_service_top_id]]));
  for (const [master, svc, total] of [[25, nail.work_service_top_id, 500], [20, nail.work_service_id, 450]]) {
    const init = await readyUser();
    const sl = await firstSlot(init, nail.work_service_id, master);
    const r = await call(init, 'POST', '/book', { service_id: nail.work_service_id, master_id: master, ...sl, variant_id: nail.id });
    assert.strictEqual(r.status, 200, `book ${master}: ` + JSON.stringify(r.body));
    const bk = r.body.booking; apIds.push(...bk.ids);
    assert.strictEqual(bk.estimate.total, total, 'оцінка за прайсом майстра');
    assert.strictEqual(bk.service, 'Манікюр жіночий');
    const [ap] = await q(`SELECT service_id, master_id, length_variant_id, (price_estimate->>'total')::numeric t FROM appointments WHERE id=$1`, [bk.ids[0]]);
    assert.strictEqual(Number(ap.service_id), Number(svc), 'у візит іде послуга CRM майстра');
    assert.strictEqual(Number(ap.master_id), master);
    assert.strictEqual(Number(ap.length_variant_id), nail.id);
    assert.strictEqual(Number(ap.t), total);
  }
  const afterP = (await q(`SELECT id, price FROM services WHERE id = ANY($1::int[]) ORDER BY id`, [[nail.work_service_id, nail.work_service_top_id]]));
  assert.deepStrictEqual(afterP, before, 'services.price не змінюється');
});

test('бронь волосся з опцією «стрижка +200»: чужі ключі опцій ігноруються', async () => {
  const init = await readyUser();
  const sl = await firstSlot(init, bio.work_service_id, HAIR_M);
  const r = await call(init, 'POST', '/book', { service_id: bio.work_service_id, master_id: HAIR_M, ...sl, variant_id: bio.id, addons: ['cut', 'free_gold'] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const bk = r.body.booking; apIds.push(...bk.ids);
  assert.strictEqual(bk.estimate.total, Number(bio.list_price) + 200);
  assert.deepStrictEqual(bk.estimate.addons.map(a => a.key), ['cut']);
  assert.match(bk.service, /\+ Стрижка під час фарбування/);
  assert.match(bk.estimate_text, /з опціями \+200/);
});
