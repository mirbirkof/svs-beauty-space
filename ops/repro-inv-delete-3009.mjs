// [30.09] «🗑 Видалити» акт інвентаризації — в браузері (пісочниця QA_DB_URL, свій сервер :3037, ПК 1280×800).
// Власник: кнопка в непроведених актах, confirm, подвійний клік = 1 запит, рядок зникає, залишки ті самі.
// Не власник (адмін зі stock.manage): кнопки немає. Фікстури QA-INV-DEL-UI прибираються наприкінці.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { loginIntoPage } from './qa-login.mjs';
const require = createRequire(import.meta.url + '/../../backend/');
const BK = new URL('../backend/', import.meta.url).pathname;
require(BK + 'node_modules/dotenv').config({ path: BK + '.env' });
const { startQaServer } = require(BK + 'test/_qa-server.js');
const { Client } = require(BK + 'node_modules/pg');

const PORT = Number(process.env.REPRO_PORT || 3037);
const MARK = 'QA-INV-DEL-UI';
const TENANT = '00000000-0000-0000-0000-000000000001';
const db = new Client({ connectionString: process.env.QA_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;
const PID = 'qa-inv-del-ui-' + Date.now().toString(36);
const vids = [];
let S, b, adminId, ownerId;
const out = { requests: 0, dialogs: [], errs: [] };
try {
  await q(`INSERT INTO products (id, name, active, tenant_id) VALUES ($1,$2,true,$3)`, [PID, MARK + ' товар', TENANT]);
  for (const st of [6, 2]) vids.push((await q(`INSERT INTO product_variants (product_id, volume, price, wholesale, stock_qty, active, tenant_id) VALUES ($1,$2,100,60,$3,true,$4) RETURNING id`, [PID, 'v' + st, st, TENANT]))[0].id);
  const role = (await q(`SELECT id FROM roles WHERE code='admin' ORDER BY id LIMIT 1`))[0];
  adminId = (await q(`INSERT INTO users (display_name, role_id, is_active, permissions_override, tenant_id) VALUES ($1,$2,true,$3::jsonb,$4) RETURNING id`, [MARK + ' адмін', role.id, JSON.stringify(['stock.read', 'stock.manage']), TENANT]))[0].id;
  const ADM = crypto.randomBytes(32).toString('hex');
  await q(`INSERT INTO user_tokens (user_id, token_hash, label, expires_at, tenant_id) VALUES ($1,$2,$3,NOW()+INTERVAL '1 hour',$4)`, [adminId, crypto.createHash('sha256').update(ADM).digest('hex'), MARK, TENANT]);
  S = await startQaServer({ port: PORT });
  const api = async (m, u, body) => (await fetch(S.base + u, { method: m, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': S.token }, body: body ? JSON.stringify(body) : undefined })).json();
  // разные наборы позиций: одинаковый набор за 2 мин сервер отдаёт тем же актом (защита от двойного «Створити»)
  const mk = async (n, set) => (await api('POST', '/api/inventory/audits', { scope: 'spot', scope_filter: { variant_ids: set }, notes: MARK + ' ' + n })).audit_id;
  const aKeep = await mk('лишається', [vids[0]]); // в роботі
  const aDel = await mk('видалити', [vids[1]]);   // в роботі → видаляємо кнопкою
  const aDone = await mk('проведений', vids);
  const det = await api('GET', '/api/inventory/audits/' + aDone);
  await api('PATCH', '/api/inventory/items/' + det.items[0].id, { actual_qty: Number(det.items[0].expected_qty) });
  await api('POST', `/api/inventory/audits/${aDone}/complete`);
  const stockBefore = await q(`SELECT id, stock_qty::float s FROM product_variants WHERE id=ANY($1::int[]) ORDER BY id`, [vids]);

  // владелец: временный логин с ролью owner (сессия как после входа); не владелец — настоящий вход QA-адміна
  const ownRole = (await q(`SELECT id FROM roles WHERE code='owner' ORDER BY id LIMIT 1`))[0];
  ownerId = (await q(`INSERT INTO users (display_name, role_id, is_active, tenant_id) VALUES ($1,$2,true,$3) RETURNING id`, [MARK + ' власник', ownRole.id, TENANT]))[0].id;
  const OWN = crypto.randomBytes(32).toString('hex');
  await q(`INSERT INTO user_tokens (user_id, token_hash, label, expires_at, tenant_id) VALUES ($1,$2,$3,NOW()+INTERVAL '1 hour',$4)`, [ownerId, crypto.createHash('sha256').update(OWN).digest('hex'), MARK, TENANT]);
  const ownerUser = (await (await fetch(S.base + '/api/auth/staff/me', { headers: { Authorization: 'Bearer ' + OWN } })).json()).user;

  b = await chromium.launch({ args: ['--no-sandbox'] });
  const open = async (who) => {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => out.errs.push('JS: ' + e.message));
    p.on('dialog', async (d) => { out.dialogs.push(d.message()); await d.accept(); });
    p.on('request', (r) => { if (/\/api\/inventory\/audits\/\d+\/delete/.test(r.url())) out.requests++; });
    if (who === 'owner') {
      await p.goto(S.base + '/admin/', { waitUntil: 'domcontentloaded' });
      await p.evaluate(({ t, u }) => { localStorage.setItem('svs_admin_token', t); localStorage.setItem('svs_user', JSON.stringify(u)); }, { t: OWN, u: ownerUser });
      await p.goto(S.base + '/admin/', { waitUntil: 'networkidle' });
    } else {
      await loginIntoPage(p, S.base, process.env.QA_UI_PHONE, process.env.QA_UI_PASSWORD);
    }
    await p.evaluate(() => openEmbed('/admin/crm-extra.html#inventory', 'fact_check Інвентаризація'));
    await p.waitForTimeout(4000);
    const fr = p.frames().find((f) => f.url().includes('crm-extra.html'));
    await fr.waitForSelector('#inv-list tr[data-id]', { timeout: 20000 });
    return { p, fr };
  };
  const rowInfo = (fr, id) => fr.evaluate((id) => { const tr = document.querySelector(`#inv-list tr[data-id="${id}"]`); return tr ? { shown: true, del: !!tr.querySelector('.inv-del') } : { shown: false }; }, id);

  // ── власник
  const { p, fr } = await open('owner');
  out.owner_before = { keep: await rowInfo(fr, aKeep), del: await rowInfo(fr, aDel), done: await rowInfo(fr, aDone) };
  const vp = await p.evaluate(() => document.querySelector('meta[name=viewport]').content);
  await fr.locator(`#inv-list tr[data-id="${aDel}"]`).scrollIntoViewIfNeeded();
  await p.screenshot({ path: '/tmp/inv-del-owner-before.png' });
  await fr.locator(`#inv-list tr[data-id="${aDel}"] .inv-del`).dblclick();
  await p.waitForTimeout(3000);
  out.owner_after = { keep: await rowInfo(fr, aKeep), del: await rowInfo(fr, aDel), done: await rowInfo(fr, aDone) };
  await p.screenshot({ path: '/tmp/inv-del-owner-after.png' });
  // ── не власник
  const A = await open('admin');
  out.admin_view = { keep: await rowInfo(A.fr, aKeep), done: await rowInfo(A.fr, aDone), anyDelBtn: await A.fr.locator('.inv-del').count() };
  await A.p.screenshot({ path: '/tmp/inv-del-nonowner.png' });

  const stockAfter = await q(`SELECT id, stock_qty::float s FROM product_variants WHERE id=ANY($1::int[]) ORDER BY id`, [vids]);
  const row = (await q(`SELECT status, deleted_at IS NOT NULL deleted, deleted_by FROM inventory_audits WHERE id=$1`, [aDel]))[0];
  Object.assign(out, { viewport: vp, aKeep, aDel, aDone, db_row: row, stock_same: JSON.stringify(stockBefore) === JSON.stringify(stockAfter), stockBefore, stockAfter });
} finally {
  if (b) await b.close();
  if (S) S.stop();
  await q(`DELETE FROM inventory_audit_items WHERE audit_id IN (SELECT id FROM inventory_audits WHERE notes LIKE $1)`, [MARK + '%']);
  await q(`DELETE FROM inventory_audits WHERE notes LIKE $1`, [MARK + '%']);
  if (vids.length) { await q(`DELETE FROM stock_movements WHERE variant_id=ANY($1::int[])`, [vids]); await q(`DELETE FROM product_variants WHERE id=ANY($1::int[])`, [vids]); }
  await q(`DELETE FROM products WHERE id=$1`, [PID]);
  for (const uid of [adminId, ownerId].filter(Boolean)) { const adminId = uid; await q(`DELETE FROM user_tokens WHERE user_id=$1`, [adminId]); await q(`DELETE FROM audit_log WHERE user_id=$1`, [adminId]).catch(() => {}); await q(`DELETE FROM users WHERE id=$1`, [adminId]).catch(() => {}); }
  await db.end();
  console.log(JSON.stringify(out, null, 1));
}
