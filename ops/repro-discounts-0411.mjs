// [04.11] Каса з трьома знижками (послуги / товари / весь чек) очима адміна, ПК 1280×800.
// ТІЛЬКИ песочниця: піднімає свій QA-сервер поверх QA_DB_URL (порт 3064), прод не чіпає.
// Запуск (з backend/): node -r dotenv/config ../ops/repro-discounts-0411.mjs
// Скріни → reports/discounts-0411/. Фікстури з міткою MARK, прибираються у finally.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/home/client/workspace/svs-beauty-space/backend/');
const pg = require('pg');
const { startQaServer } = require('./test/_qa-server');
const { sign } = require('./lib/tg-initdata');
import { loginIntoPage } from './qa-login.mjs';

const T = '00000000-0000-0000-0000-000000000001', MARK = 'QA-DISC-UI-0411';
const SHOTS = '/home/client/workspace/svs-beauty-space/reports/discounts-0411';
fs.mkdirSync(SHOTS, { recursive: true });
const BOT = '123456:QA-fake-bot-token-discounts';
const db = new pg.Client({ connectionString: process.env.QA_DB_URL, ssl: { rejectUnauthorized: false } }); await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;
const F = { appts: [], shifts: [] };
let fail = 0; const out = [];
const check = (n, ok, i) => { if (!ok) fail++; const l = (ok ? '[OK]  ' : '[FAIL]') + ' ' + n + ' — ' + i; console.log(l); out.push(l); };
const r2 = (n) => Math.round(n * 100) / 100;
const errs = [];
let b, S, p;

async function newAppt(price, qty) {
  const id = (await q(`INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, status, price, tenant_id, source, notes)
    VALUES ($1,$2,$3, NOW() - ($7 * interval '1 minute'), NOW() - ($7 * interval '1 minute') + interval '1 hour', 'confirmed', $4, $5, 'qa-test', $6) RETURNING id`,
    [F.client, F.master, F.service, price, T, MARK, 120 + F.appts.length * 70]))[0].id;
  if (qty) await q(`INSERT INTO appointment_materials (appointment_id, variant_id, qty_used, note, billable, tenant_id) VALUES ($1,$2,$3,$4,true,$5)`,
    [id, F.variant, qty, MARK, T]);
  F.appts.push(id); return id;
}
const cashOf = async (id) => {
  const rows = await q(`SELECT category, method, amount::float a FROM cash_operations WHERE ref_type='appointment' AND ref_id=$1 AND type='in'`, [id]);
  const by = (c) => r2(rows.filter((x) => x.category === c).reduce((s, x) => s + x.a, 0));
  return { svc: by('sale_service'), prod: by('sale_product'), total: r2(rows.reduce((s, x) => s + x.a, 0)), n: rows.length };
};
const apptRow = async (id) => (await q(`SELECT status, real_amount::float real, discount_amount::float disc,
  discount_services_amount::float ds, discount_products_amount::float dp, discount_check_amount::float dc,
  bill_services_total::float bs, bill_products_total::float bp FROM appointments WHERE id=$1`, [id]))[0];
const miniBill = async (id) => {
  const init = sign({ auth_date: Math.floor(Date.now() / 1000), user: { id: F.tg, first_name: 'QA' } }, BOT);
  const r = await fetch(`${S.base}/api/miniapp/appointments/${id}/bill`, { headers: { 'X-Telegram-Init-Data': init } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
async function openPay(id) {
  await p.evaluate(async () => { try { closeAppt(); } catch (_) {} go('journal'); await loadJournal(); });
  await p.evaluate((x) => openAppt(x), id);
  await p.waitForSelector('#payDisc_svc', { timeout: 15000 });
  await p.waitForTimeout(2500); // loadPayOptions: товари, рахунок, бонуси
}
async function setDisc(k, val, type) {
  if (type) await p.selectOption('#payDiscT_' + k, type);
  await p.fill('#payDisc_' + k, String(val));
}
const flat = (t) => String(t).replace(/\n/g, ' | ');
const noteText = () => p.evaluate(() => document.getElementById('payCalcNote')?.innerText || '');
const labelText = (k) => p.evaluate((x) => document.getElementById('payDiscL_' + x)?.innerText || '', k);
async function doPay() {
  await p.click('#apptPayBtn');
  await p.waitForTimeout(3000);
  return p.evaluate(() => document.getElementById('apptMsg')?.innerText || '');
}
const finalFromNote = (t) => { const m = t.match(/до сплати[^:]*:\s*([\d\s  ,.]+)/); return m ? Number(m[1].replace(/[\s  ]/g, '').replace(',', '.')) : NaN; };

try {
  F.tg = 910000000 + Math.floor(Math.random() * 80000000);
  F.client = (await q(`INSERT INTO clients (name, tenant_id, source, telegram_id) VALUES ($1,$2,'qa-test',$3) RETURNING id`, [MARK, T, F.tg]))[0].id;
  F.master = (await q(`INSERT INTO masters (name, active, provides_services, tenant_id) VALUES ($1,true,true,$2) RETURNING id`, [MARK, T]))[0].id;
  F.service = (await q(`INSERT INTO services (name, duration_min, price, active, tenant_id) VALUES ($1,60,1000,true,$2) RETURNING id`, [MARK, T]))[0].id;
  F.product = 'qa-disc-ui-' + Date.now().toString(36);
  await q(`INSERT INTO products (id, name, tenant_id) VALUES ($1,$2,$3)`, [F.product, MARK + ' крем', T]);
  F.variant = (await q(`INSERT INTO product_variants (product_id, price, stock_qty, tenant_id) VALUES ($1,250,50,$2) RETURNING id`, [F.product, T]))[0].id;
  F.certCode = 'QADISC' + Date.now().toString(36).toUpperCase();
  F.cert = (await q(`INSERT INTO gift_certificates (code, type, original_amount, remaining_amount, status, valid_until, tenant_id, notes)
     VALUES ($1,'amount',300,300,'active', (CURRENT_DATE + 365), $2, $3) RETURNING id`, [F.certCode, T, MARK]))[0].id;
  await q(`INSERT INTO bonus_balances (tenant_id, client_id, balance, total_accrued) VALUES ($1,$2,100,100)
           ON CONFLICT (tenant_id, client_id) DO UPDATE SET balance=100, total_accrued=100`, [T, F.client]);
  await q(`INSERT INTO bonus_transactions (tenant_id, client_id, type, amount, balance_after, remaining, source_type, description, available_at)
           VALUES ($1,$2,'manual_add',100,100,100,'manual',$3, NOW() - interval '1 day')`, [T, F.client, MARK]);
  const open = (await q(`SELECT id FROM cash_shifts WHERE status='open' LIMIT 1`))[0];
  F.shift = open ? open.id : (await q(`INSERT INTO cash_shifts (opening_cash, notes, status, tenant_id) VALUES (0,$1,'open',$2) RETURNING id`, [MARK, T]))[0].id;
  if (!open) F.shifts.push(F.shift);

  S = await startQaServer({ port: 3064, extraEnv: { TELEGRAM_BOT_TOKEN: BOT } });
  b = await chromium.launch({ args: ['--no-sandbox'] });
  p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  p.on('pageerror', (e) => errs.push('JS: ' + e.message));
  p.on('response', (r) => { if (/\/api\/(schedule|consumables)/.test(r.url()) && r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url().replace(S.base, '')}`); });
  p.on('dialog', async (d) => { console.log('  діалог:', d.message()); await d.accept(); });
  await loginIntoPage(p, S.base, process.env.QA_UI_PHONE, process.env.QA_UI_PASSWORD);
  await p.goto(S.base + '/admin/', { waitUntil: 'networkidle' });

  // ── A. лише послуги 1000, знижка на послуги 10% → 900
  { const id = await newAppt(1000, 0); await openPay(id); await setDisc('svc', 10, 'percent');
    const n = await noteText(); await p.screenshot({ path: SHOTS + '/A-only-services-10pct.png' });
    check('A: превʼю «до сплати» = 900', finalFromNote(n) === 900, flat(n));
    const m = await doPay(); const c = await cashOf(id), a = await apptRow(id);
    check('A: каса 900 (послуги), знижка на послуги 100, ЗП-база 900', c.total === 900 && c.svc === 900 && a.ds === 100 && a.real === 900 && a.disc === 100, `${m} | каса ${JSON.stringify(c)} | візит ${JSON.stringify(a)}`);
    F.A = id; }

  // ── B. лише товари 2×250, ціна послуги 0, знижка на товари 20 грн → 480
  { const id = await newAppt(0, 2); await openPay(id); await setDisc('prod', 20, 'fixed');
    const n = await noteText(); await p.screenshot({ path: SHOTS + '/B-only-products-20uah.png' });
    check('B: превʼю = 480', finalFromNote(n) === 480, flat(n));
    const m = await doPay(); const c = await cashOf(id), a = await apptRow(id);
    check('B: каса 480 (товари), знижка на товари 20, ЗП-база 0', c.total === 480 && c.prod === 480 && c.svc === 0 && a.dp === 20 && a.real === 0, `${m} | каса ${JSON.stringify(c)} | візит ${JSON.stringify(a)}`);
    F.B = id; }

  // ── C. мікс 1000 + 2×250: послуги −100 грн, товари −10%, чек −5% → 1282.50
  { const id = await newAppt(1000, 2); await openPay(id);
    await setDisc('svc', 100, 'fixed'); await setDisc('prod', 10, 'percent'); await setDisc('check', 5, 'percent');
    const n = await noteText(); await p.screenshot({ path: SHOTS + '/C-mix-three-discounts.png' });
    check('C: живий перерахунок 1282.50', finalFromNote(n) === 1282.5, flat(n));
    const L = [await labelText('svc'), await labelText('prod'), await labelText('check')];
    check('C: підписи під трьома полями', L.every((x) => x.length > 0), L.join(' / '));
    // «Зберегти рахунок» → сервер, застосунок клієнта бачить ту саму суму
    await p.click('button:has-text("Зберегти рахунок")'); await p.waitForTimeout(2000);
    const bill = await p.evaluate(async (x) => api('/api/schedule/appointments/' + x + '/bill'), id);
    const mb = await miniBill(id);
    check('C: каса = /bill = застосунок (до оплати)', bill.final === 1282.5 && mb.status === 200 && mb.body.bill && Number(mb.body.bill.amount) === 1282.5 && mb.body.bill.can_pay === true,
      `/bill ${bill.final}, застосунок ${mb.status} ${JSON.stringify(mb.body.bill)}`);
    const m = await doPay(); const c = await cashOf(id), a = await apptRow(id);
    check('C: каса 1282.50 = послуги 855 + товари 427.50; ЗП-база 855', c.total === 1282.5 && c.svc === 855 && c.prod === 427.5 && a.real === 855 && a.ds === 100 && a.dp === 50 && a.dc === 67.5 && a.disc === 217.5,
      `${m} | каса ${JSON.stringify(c)} | візит ${JSON.stringify(a)}`);
    F.C = id; }

  // ── D. 100% на весь чек → 0, візит закрито без грошей
  { const id = await newAppt(1000, 2); await openPay(id); await setDisc('check', 100, 'percent');
    const n = await noteText(); await p.screenshot({ path: SHOTS + '/D-check-100pct.png' });
    check('D: превʼю = 0', finalFromNote(n) === 0, flat(n));
    const m = await doPay(); const c = await cashOf(id), a = await apptRow(id);
    check('D: оплачено 0, каса порожня, ЗП-база 0', a.status === 'done' && c.total === 0 && a.real === 0 && a.dc === 1500, `${m} | каса ${JSON.stringify(c)} | візит ${JSON.stringify(a)}`);
    F.D = id; }

  // ── E. знижка більша за частину: товари −9999 грн → обрізано до 500
  { const id = await newAppt(1000, 2); await openPay(id); await setDisc('prod', 9999, 'fixed');
    const n = await noteText(); const lp = await labelText('prod');
    await p.screenshot({ path: SHOTS + '/E-discount-over-part.png' });
    check('E: знижка на товари обрізана до 500, мінуса нема → 1000', finalFromNote(n) === 1000 && /обрізано/.test(lp), `${lp} | ${flat(n)}`);
    const m = await doPay(); const c = await cashOf(id), a = await apptRow(id);
    check('E: каса 1000 лише послуги, товари 0, ЗП-база 1000', c.total === 1000 && c.svc === 1000 && c.prod === 0 && a.dp === 500 && a.real === 1000, `${m} | каса ${JSON.stringify(c)} | візит ${JSON.stringify(a)}`);
    F.E = id; }

  // ── F. сертифікат + бонуси + знижки: послуги −10%, чек −50 грн, серт 300, бонуси 100
  { const id = await newAppt(1000, 2); await openPay(id);
    await setDisc('svc', 10, 'percent'); await setDisc('check', 50, 'fixed');
    await p.fill('#payCertCode', F.certCode);
    const bonusVisible = await p.evaluate(() => getComputedStyle(document.getElementById('payBonusRow')).display !== 'none');
    if (bonusVisible) await p.check('#payBonusUse');
    const n = await noteText(); await p.screenshot({ path: SHOTS + '/F-cert-bonus-discounts.png' });
    const m = await doPay(); const c = await cashOf(id), a = await apptRow(id);
    const cert = (await q(`SELECT remaining_amount::float r FROM gift_certificates WHERE id=$1`, [F.cert]))[0].r;
    // 1000−100=900; товари 500; чек −50 → 1350; серт −300 → 1050; бонуси −B → каса 1050−B
    const B = r2(1050 - c.total);
    const expReal = r2(900 - (50 + 300 + B) * (900 / 1400));
    check('F: рядок бонусів видно', bonusVisible, flat(n));
    check('F: серт списано 300, каса = 1050 − бонуси, бонуси 0..100', cert === 0 && B > 0 && B <= 100 && c.total === r2(1050 - B), `${m} | серт залишок ${cert}, бонуси ${B}, каса ${JSON.stringify(c)}`);
    check('F: ЗП-база = послуги після знижки мінус їх частка (чек+серт+бонуси)', Math.abs(a.real - expReal) <= 0.01 && a.ds === 100 && a.dc === 50, `real ${a.real}, очікував ${expReal}, візит ${JSON.stringify(a)}`);
    F.F = id; }

  // ── G. зміна товарів ПІСЛЯ оплати (C): 2 → 4 шт → каса перераховується зі збереженими знижками
  { const r = await p.evaluate(async (x) => api('/api/consumables/appointment/' + x.id, { method: 'POST', body: JSON.stringify({ variant_id: x.v, qty_used: 4, billable: true }) }), { id: F.C, v: F.variant });
    const c = await cashOf(F.C), a = await apptRow(F.C);
    // S3=900, P=1000 → −10% = 900; чек 5% від 1800 = 90 → 1710; ЗП 900 − 45 = 855
    check('G: після +2 шт товару каса 1710 (послуги 855 + товари 855), ЗП-база 855', r && r.ok && c.total === 1710 && c.svc === 855 && c.prod === 855 && a.real === 855 && a.dp === 100 && a.dc === 90,
      `синхр ${JSON.stringify(r && r.cash_synced)} | каса ${JSON.stringify(c)} | візит ${JSON.stringify(a)}`); }

  // ── H. повторне відкриття закритого візиту + застосунок «оплачено» на ту ж суму
  { await p.evaluate(async () => { try { closeAppt(); } catch (_) {} go('journal'); await loadJournal(); });
    await p.evaluate((x) => openAppt(x), F.C); await p.waitForTimeout(2500);
    const txt = await p.evaluate(() => document.body.innerText);
    await p.screenshot({ path: SHOTS + '/H-reopen-paid.png' });
    const mb = await miniBill(F.C);
    check('H: картка закритого візиту — «Оплачено», полів знижок нема', /Оплачено/.test(txt) && !(await p.$('#payDisc_svc')), (txt.match(/Оплачено[^\n]*/) || [''])[0]);
    check('H: застосунок — «Оплачено», кнопки оплати нема (суми по оплаченому клієнту не показуємо — рішення Боса)', mb.status === 200 && mb.body.bill && mb.body.bill.paid === true && mb.body.bill.can_pay === false, JSON.stringify(mb.body.bill || mb.body)); }

  // ── Звіти/ЗП: відомість майстра = сума real_amount; каса = сума оплат
  { const sum = (await q(`SELECT COALESCE(SUM(real_amount),0)::float s FROM appointments WHERE id = ANY($1::int[]) AND status='done'`, [F.appts]))[0].s;
    const per = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit' }).format(new Date());
    // відомість — тим самим API, що бачить власник (адмін-токен QA-сервера; у браузерного QA-логіна немає payroll.read)
    const sh = await (await fetch(`${S.base}/api/payouts/sheet?period=${per}&master_id=${F.master}`, { headers: { 'X-Admin-Token': S.token } })).json();
    const row = (sh.rows || []).find((r) => String(r.master_id) === String(F.master));
    check('ЗП: відомість майстра = Σ real_amount візитів', row && Math.abs(row.services_revenue - sum) <= 0.01, `період ${per}, відповідь ${row ? '' : JSON.stringify(sh)} відомість ${row && row.services_revenue}, Σ real ${sum}, візитів ${row && row.services_count}`);
    const cashAll = (await q(`SELECT COALESCE(SUM(amount),0)::float s FROM cash_operations WHERE ref_type='appointment' AND ref_id = ANY($1::int[]) AND type='in'`, [F.appts]))[0].s;
    const exp = r2(900 + 480 + 1710 + 0 + 1000 + (await cashOf(F.F)).total);
    check('Каса: Σ надходжень = Σ «до сплати» усіх сценаріїв', cashAll === exp, `каса ${cashAll}, очікував ${exp}`); }
} catch (e) { fail++; console.log('[FAIL] сценарій упав:', e.message.split('\n')[0]); try { await p.screenshot({ path: SHOTS + '/ERROR.png' }); } catch (_) {} }
finally {
  const ids = F.appts;
  for (const [s, a] of [
    [`DELETE FROM cash_operations WHERE ref_type='appointment' AND ref_id = ANY($1::int[])`, [ids]],
    [`DELETE FROM payments WHERE appointment_id = ANY($1::int[])`, [ids]],
    [`DELETE FROM gift_certificate_transactions WHERE gc_id=$1`, [F.cert || 0]],
    [`DELETE FROM gift_certificates WHERE id=$1`, [F.cert || 0]],
    [`DELETE FROM bonus_transactions WHERE client_id=$1`, [F.client || 0]], [`DELETE FROM bonus_balances WHERE client_id=$1`, [F.client || 0]],
    [`DELETE FROM stock_movements WHERE variant_id=$1`, [F.variant || 0]],
    [`DELETE FROM appointment_materials WHERE appointment_id = ANY($1::int[])`, [ids]],
    [`DELETE FROM appointment_services WHERE appointment_id = ANY($1::int[])`, [ids]],
    [`DELETE FROM appointments WHERE id = ANY($1::int[])`, [ids]],
    [`DELETE FROM cash_shifts WHERE id = ANY($1::int[])`, [F.shifts]],
    [`DELETE FROM product_variants WHERE id=$1`, [F.variant || 0]], [`DELETE FROM products WHERE id=$1`, [F.product || '']],
    [`DELETE FROM services WHERE id=$1`, [F.service || 0]], [`DELETE FROM masters WHERE id=$1`, [F.master || 0]], [`DELETE FROM clients WHERE id=$1`, [F.client || 0]],
  ]) { try { await q(s, a); } catch (e) { console.log('[cleanup]', s, e.message); } }
  const left = await q(`SELECT (SELECT count(*) FROM appointments WHERE notes=$1) a, (SELECT count(*) FROM clients WHERE name=$1) c`, [MARK]);
  console.log('залишки фікстур:', JSON.stringify(left[0]));
  await db.end(); if (b) await b.close(); if (S) S.stop();
}
console.log('ПОМИЛКИ UI:', errs.length ? '\n  ' + errs.join('\n  ') : 'нема');
const summary = fail ? `ПІДСУМОК: ${fail} провалів` : 'ПІДСУМОК: усе зелене';
console.log(summary);
fs.writeFileSync(SHOTS + '/ui-run.txt', out.concat(['ПОМИЛКИ UI: ' + (errs.join('; ') || 'нема'), summary]).join('\n') + '\n');
process.exit(fail || errs.length ? 1 : 0);
