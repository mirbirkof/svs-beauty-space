// [13.10] Картка нового майстра без звʼязок: пропозиція за спеціальністю + «Додати N послуг» (пісочниця QA_DB_URL, :3053, ПК 1280×800).
// Фікстури з міткою QA-MSVC-UI створюються і прибираються тут же, лише в пісочниці.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url + '/../../backend/');
const BK = new URL('../backend/', import.meta.url).pathname;
require(BK + 'node_modules/dotenv').config({ path: BK + '.env' });
const { startQaServer } = require(BK + 'test/_qa-server.js');
const { Client } = require(BK + 'node_modules/pg');
const TENANT = '00000000-0000-0000-0000-000000000001', MARK = 'QA-MSVC-UI', PORT = 3053;
const db = new Client({ connectionString: process.env.QA_DB_URL, ssl: { rejectUnauthorized: false } }); await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;
let S, b, ownerId, mid; const out = []; const ok = (c, m) => out.push((c ? 'ok  ' : 'BAD ') + m);
try {
  mid = (await q(`INSERT INTO masters (name, specialty, active, provides_services, tenant_id) VALUES ($1,'Майстер манікюру',true,true,$2) RETURNING id`, [MARK + ' Ася', TENANT]))[0].id;
  S = await startQaServer({ port: PORT });
  const ownRole = (await q(`SELECT id FROM roles WHERE code='owner' ORDER BY id LIMIT 1`))[0];
  ownerId = (await q(`INSERT INTO users (display_name, role_id, is_active, tenant_id) VALUES ($1,$2,true,$3) RETURNING id`, [MARK + ' власник', ownRole.id, TENANT]))[0].id;
  const OWN = crypto.randomBytes(32).toString('hex');
  await q(`INSERT INTO user_tokens (user_id, token_hash, label, expires_at, tenant_id) VALUES ($1,$2,$3,NOW()+INTERVAL '1 hour',$4)`, [ownerId, crypto.createHash('sha256').update(OWN).digest('hex'), MARK, TENANT]);
  const ownerUser = (await (await fetch(S.base + '/api/auth/staff/me', { headers: { Authorization: 'Bearer ' + OWN } })).json()).user;
  b = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await p.goto(S.base + '/admin/', { waitUntil: 'domcontentloaded' });
  await p.evaluate(({ t, u }) => { localStorage.setItem('svs_admin_token', t); localStorage.setItem('svs_user', JSON.stringify(u)); }, { t: OWN, u: ownerUser });
  await p.goto(S.base + '/admin/', { waitUntil: 'networkidle' });
  const pick = await p.evaluate(async (id) => { const s = await getMasterServiceIds(id); return s ? s.size : null; }, mid);
  const nails = Number((await q(`SELECT COUNT(*) n FROM services WHERE deleted_at IS NULL AND active IS NOT FALSE AND COALESCE(is_material,false)=false AND category='Нігті'`))[0].n);
  const all = Number((await q(`SELECT COUNT(*) n FROM services WHERE deleted_at IS NULL AND active IS NOT FALSE`))[0].n);
  ok(pick === nails && pick < all, `журнал: для майстра без звʼязок пропонує ${pick} послуг (Нігті ${nails}), не весь каталог ${all}`);
  await p.evaluate((id) => openMasterCard(id), mid); await p.waitForTimeout(1500);
  await p.evaluate(() => mcTab('services')); await p.waitForSelector('#mcSvcSuggestBtn', { timeout: 15000 });
  const txt = await p.textContent('#mcSvcList');
  ok(/Пропоную \d+ послуг за спеціальністю «Майстер манікюру»/.test(txt) && /Нігті/.test(txt), 'картка: пропозиція «за спеціальністю Майстер манікюру · Нігті»');
  await p.screenshot({ path: BK + '../reports/msvc-1310-before.png' });
  await p.dblclick('#mcSvcSuggestBtn'); await p.waitForTimeout(2500);
  const n = Number((await q(`SELECT COUNT(*) n FROM master_services WHERE master_id=$1`, [mid]))[0].n);
  const cats = (await q(`SELECT DISTINCT s.category c FROM master_services ms JOIN services s ON s.id=ms.service_id WHERE ms.master_id=$1`, [mid])).map(r => r.c);
  ok(n === nails && cats.length === 1 && cats[0] === 'Нігті', `після «Додати» (подвійний клік): ${n} звʼязок, категорії ${cats.join(',')}`);
  const rows = await p.$$eval('#mcSvcList input[type=checkbox]', els => els.length);
  ok(rows === n, `список у картці: ${rows} рядків з тумблерами`);
  await p.screenshot({ path: BK + '../reports/msvc-1310-after.png' });
} catch (e) { out.push('BAD exception ' + e.message); }
finally {
  if (b) await b.close(); if (S) S.stop();
  if (mid) { await q(`DELETE FROM master_services WHERE master_id=$1`, [mid]); await q(`DELETE FROM masters WHERE id=$1`, [mid]).catch(() => {}); }
  if (ownerId) { await q(`DELETE FROM user_tokens WHERE user_id=$1`, [ownerId]); await q(`DELETE FROM audit_log WHERE user_id=$1`, [ownerId]).catch(() => {}); await q(`DELETE FROM users WHERE id=$1`, [ownerId]).catch(() => {}); }
  await db.end(); console.log(out.join('\n'));
}
