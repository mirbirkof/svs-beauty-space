// [28.10] Змішана оплата в «Оформити продаж товару» (Босс: «там тільки окремо картка, готівка і переказ»).
// ТІЛЬКИ тестова база (QA_DB_URL, :3054, ПК 1280×800). Фікстури з міткою QA-POSMIX створюються і прибираються тут же.
// Проводимо РЕАЛЬНИЙ продаж у тестовій базі й дивимось, що лягло в касу: суми по способах, списання складу один раз, повтор не задвоює.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url + '/../../backend/');
const BK = new URL('../backend/', import.meta.url).pathname;
require(BK + 'node_modules/dotenv').config({ path: BK + '.env' });
const { startQaServer } = require(BK + 'test/_qa-server.js');
const { Client } = require(BK + 'node_modules/pg');
const TENANT = '00000000-0000-0000-0000-000000000001', MARK = 'QA-POSMIX', PORT = 3054;
if (!process.env.QA_DB_URL || process.env.QA_DB_URL === process.env.DATABASE_URL) { console.log('НЕТ отдельной тестовой базы — стоп'); process.exit(2); }
const db = new Client({ connectionString: process.env.QA_DB_URL, ssl: { rejectUnauthorized: false } }); await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;
let S, b, ownerId; const out = []; const ok = (c, m) => out.push((c ? 'ok  ' : 'BAD ') + m);
const PID1 = MARK.toLowerCase() + '-a-' + Date.now().toString(36), PID2 = MARK.toLowerCase() + '-b-' + Date.now().toString(36);
const errs = [];
try {
  S = await startQaServer({ port: PORT });
  const ownRole = (await q(`SELECT id FROM roles WHERE code='owner' ORDER BY id LIMIT 1`))[0];
  ownerId = (await q(`INSERT INTO users (display_name, role_id, is_active, tenant_id) VALUES ($1,$2,true,$3) RETURNING id`, [MARK + ' власник', ownRole.id, TENANT]))[0].id;
  const OWN = crypto.randomBytes(32).toString('hex');
  await q(`INSERT INTO user_tokens (user_id, token_hash, label, expires_at, tenant_id) VALUES ($1,$2,$3,NOW()+INTERVAL '1 hour',$4)`, [ownerId, crypto.createHash('sha256').update(OWN).digest('hex'), MARK, TENANT]);
  const ownerUser = (await (await fetch(S.base + '/api/auth/staff/me', { headers: { Authorization: 'Bearer ' + OWN } })).json()).user;
  b = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  p.on('pageerror', e => errs.push('JS: ' + e.message));
  p.on('dialog', async d => { errs.push('ALERT: ' + d.message()); await d.accept(); });
  await p.goto(S.base + '/admin/', { waitUntil: 'domcontentloaded' });
  await p.evaluate(({ t, u }) => { localStorage.setItem('svs_admin_token', t); localStorage.setItem('svs_user', JSON.stringify(u)); }, { t: OWN, u: ownerUser });
  await p.goto(S.base + '/admin/', { waitUntil: 'networkidle' });
  // два товари: A 450 ₴ (2 шт), B 99.99 ₴ (1 шт) → кошик 999.99
  const v = await p.evaluate(async ([a, bb, mark]) => {
    const mk = async (id, nm, price) => { await api('/api/admin/products', { method: 'POST', body: JSON.stringify({ id, name: mark + ' ' + nm, category_id: null }) });
      const x = (await api('/api/admin/products/' + id + '/variants', { method: 'POST', body: JSON.stringify({ volume: 'шт', price, wholesale: 1, stock_qty: 10 }) })).variant; return x.id; };
    return [await mk(a, 'шампунь', 450), await mk(bb, 'маска', 99.99)];
  }, [PID1, PID2, MARK]);
  const stock0 = (await q(`SELECT id, stock_qty FROM product_variants WHERE id = ANY($1) ORDER BY id`, [v])).map(r => Number(r.stock_qty));
  await p.evaluate(() => posOpen()); await p.waitForTimeout(400);
  ok(await p.$eval('#posMethod', s => [...s.options].some(o => o.value === 'mixed' && /Змішана/.test(o.textContent))), 'у списку оплат є «Змішана»');
  await p.evaluate(([a, bb]) => { posAdd(a, 'QA-POSMIX шампунь', 450, 10); posAdd(bb, 'QA-POSMIX маска', 99.99, 10); }, v);
  await p.evaluate(() => posSetQty(0, 2));
  ok(await p.$eval('#posMixRow', e => e.style.display === 'none'), 'до вибору «Змішана» поля сум сховані');
  await p.selectOption('#posMethod', 'mixed');
  ok(await p.$eval('#posMixRow', e => e.style.display === 'flex'), 'після вибору «Змішана» видно поля готівка/переказ/картка');
  await p.fill('#posMixCash', '600'); await p.fill('#posMixTransfer', '100');
  const card = await p.$eval('#posMixCard', e => e.value), hint = await p.textContent('#posMixHint');
  ok(card === '299.99' && /збігається/.test(hint), `картка підставилась залишком: ${card} ₴, підказка «${hint}»`);
  // неправильна сума — продаж не проводиться
  await p.fill('#posMixCard', '250'); await p.evaluate(() => posMixCheck());
  ok(/не вистачає 49\.99/.test(await p.textContent('#posMixHint')), 'неповна сума: «не вистачає 49.99 ₴»');
  await p.click('#posGo'); await p.waitForTimeout(800);
  const nBad = Number((await q(`SELECT COUNT(*) n FROM cash_operations WHERE description LIKE $1`, ['%' + MARK + '%']))[0].n);
  ok(nBad === 0 && /не дорівнює/.test(await p.textContent('#posMsg')), 'неповна сума: нічого не проведено, пояснення на екрані');
  await p.screenshot({ path: BK + '../reports/posmix-2810-form.png' });
  // правильна сума → проводимо
  await p.fill('#posMixCard', '299.99'); await p.evaluate(() => posMixCheck());
  await p.click('#posGo'); await p.waitForTimeout(3000);
  const ops = await q(`SELECT method, amount::float a, description, ext_ref FROM cash_operations WHERE description LIKE $1 ORDER BY id`, ['%' + MARK + '%']);
  const by = ops.reduce((m, o) => { m[o.method] = +((m[o.method] || 0) + o.a).toFixed(2); return m; }, {});
  ok(by.cash === 600 && by.transfer === 100 && by.card === 299.99, `у касі по способах: ${JSON.stringify(by)}`);
  ok(ops.every(o => /змішана: готівка 600\.00, переказ 100\.00, картка 299\.99/.test(o.description)), `опис чека: «${(ops[0] || {}).description}»`);
  const stock1 = (await q(`SELECT id, stock_qty FROM product_variants WHERE id = ANY($1) ORDER BY id`, [v])).map(r => Number(r.stock_qty));
  ok(stock1[0] === stock0[0] - 2 && stock1[1] === stock0[1] - 1, `склад списано один раз: ${stock0} → ${stock1}`);
  ok(!(await p.$('#posModal')), 'вікно закрилось після успіху');
  // повтор того ж кошика з тим самим чеком (обрив мережі) — не задвоює
  const refs = ops.map(o => o.ext_ref);
  for (const r of refs) await fetch(S.base + '/api/cashbox/operations', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OWN },
    body: JSON.stringify({ type: 'in', category: 'sale_product', method: 'cash', amount: 1, description: MARK + ' повтор', allow_no_shift: true, ext_ref: r }) });
  const n2 = Number((await q(`SELECT COUNT(*) n FROM cash_operations WHERE description LIKE $1`, ['%' + MARK + '%']))[0].n);
  ok(n2 === ops.length, `повтор з тими ж мітками чека не задвоїв: операцій ${ops.length} → ${n2}`);
  // звичайна оплата не змінилась: «Картка» одним рядком на позицію
  await p.evaluate(() => posOpen()); await p.evaluate((a) => posAdd(a, 'QA-POSMIX шампунь', 450, 10), v[0]);
  await p.selectOption('#posMethod', 'card'); await p.click('#posGo'); await p.waitForTimeout(2000);
  const last = await q(`SELECT method, amount::float a, description FROM cash_operations WHERE description LIKE $1 ORDER BY id DESC LIMIT 1`, ['%' + MARK + '%']);
  ok(last[0]?.method === 'card' && last[0]?.a === 450 && !/змішана/.test(last[0]?.description), `звичайна «Картка» як раніше: ${last[0]?.method} ${last[0]?.a} ₴`);
} catch (e) { out.push('BAD виняток: ' + e.message); }
finally {
  try {
    const cleanup = await import(new URL('./_posmix-cleanup-2810.mjs', import.meta.url));
    await cleanup.default(q, MARK, ownerId);
  } catch (e) { out.push('BAD прибирання: ' + e.message); }
  await b?.close(); await S?.close?.(); await db.end();
}
console.log(out.join('\n')); console.log('ПОМИЛКИ JS:', errs.length ? errs.join(' | ') : 'нема');
const bad = out.filter(x => x.startsWith('BAD')).length; console.log(bad || errs.length ? `ИТОГ: ${bad} провалів` : `ИТОГ: ${out.length}/${out.length} зелено`);
process.exit(bad || errs.length ? 1 : 0);
