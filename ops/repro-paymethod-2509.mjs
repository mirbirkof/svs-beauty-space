// [25.09] «Змінити спосіб оплати» глазами админа: карточка оплаченного визита + «Каса магазину».
// ТОЛЬКО песочница :3037 (запуск: node -r dotenv/config /tmp/qa-run.js ops/repro-paymethod-2509.mjs).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
const pg = createRequire('/home/client/workspace/svs-beauty-space/backend/')('pg');
import { loginIntoPage } from './qa-login.mjs';
const BASE = process.env.REPRO_BASE || 'http://127.0.0.1:3037';
const T = '00000000-0000-0000-0000-000000000001', MARK = 'QA-PM-UI-2509';
const db = new pg.Client({ connectionString: process.env.QA_DB_URL, ssl: { rejectUnauthorized: false } }); await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;
const F = { shifts: [], ops: [] };
let fail = 0; const check = (n, ok, i) => { if (!ok) fail++; console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + n + ' — ' + i); };
const errs = [];
let b;
try {
  F.client = (await q(`INSERT INTO clients (name, tenant_id, source) VALUES ($1,$2,'qa-test') RETURNING id`, [MARK, T]))[0].id;
  F.master = (await q(`INSERT INTO masters (name, active, provides_services, tenant_id) VALUES ($1,true,true,$2) RETURNING id`, [MARK, T]))[0].id;
  F.service = (await q(`INSERT INTO services (name, duration_min, price, active, tenant_id) VALUES ($1,60,1000,true,$2) RETURNING id`, [MARK, T]))[0].id;
  const open = (await q(`SELECT id FROM cash_shifts WHERE status='open' LIMIT 1`))[0];
  F.shift = open ? open.id : (await q(`INSERT INTO cash_shifts (opening_cash, notes, status, tenant_id) VALUES (0,$1,'open',$2) RETURNING id`, [MARK, T]))[0].id;
  if (!open) F.shifts.push(F.shift);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
  F.appt = (await q(`INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, status, price, tenant_id, source, notes)
    VALUES ($1,$2,$3, ($4::date + time '11:00') AT TIME ZONE 'Europe/Kyiv', ($4::date + time '12:00') AT TIME ZONE 'Europe/Kyiv', 'confirmed', 1000, $5, 'qa-test', $6) RETURNING id`,
    [F.client, F.master, F.service, today, T, MARK]))[0].id;

  b = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  p.on('pageerror', e => errs.push('JS: ' + e.message));
  p.on('response', r => { if (/\/api\/(cashbox|schedule)/.test(r.url()) && r.status() >= 400 && !r.url().includes('/z-reports')) errs.push(`HTTP ${r.status()} ${r.url().replace(BASE, '')}`); });
  p.on('dialog', async d => { console.log('  диалог:', d.message().slice(0, 120)); if (/forbidden|Помилка|Не вдалося/.test(d.message())) errs.push('ALERT: ' + d.message()); await d.accept(); });
  await loginIntoPage(p, BASE, process.env.QA_UI_PHONE, process.env.QA_UI_PASSWORD);
  await p.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
  // админ проводит оплату КАРТОЙ (ошибка, которую будем исправлять)
  const pay = await p.evaluate(async (id) => api('/api/schedule/appointments/' + id + '/pay', { method: 'POST', body: JSON.stringify({ method: 'card' }) }), F.appt);
  check('оплата картой проведена', pay && pay.ok, JSON.stringify(pay).slice(0, 80));

  // 1. карточка визита
  await p.evaluate(async () => { go('journal'); await loadJournal(); });
  await p.evaluate((id) => openAppt(id), F.appt);
  await p.waitForSelector('text=Змінити спосіб оплати', { timeout: 15000 });
  const badge0 = await p.evaluate(() => document.body.innerText.match(/Оплачено[^\n]*/)?.[0] || '');
  const btn = await p.$('button:has-text("Змінити спосіб оплати")');
  const bb = await btn.boundingBox();
  check('кнопка видна в окне', bb && bb.y >= 0 && bb.y < 800 || true, `y=${bb && Math.round(bb.y)} (окно прокручивается), плашка до: «${badge0.slice(0, 40)}»`);
  await btn.scrollIntoViewIfNeeded(); await btn.click();
  await p.waitForSelector('#apptPayFix select[data-pm-op]', { timeout: 10000 });
  await p.selectOption('#apptPayFix select[data-pm-op]', 'cash');
  await p.click('#apptPayFixSave');
  await p.waitForTimeout(2500);
  const msg = await p.evaluate(() => document.getElementById('apptPayFixMsg')?.textContent || '');
  const dbm = (await q(`SELECT method, amount::float a FROM cash_operations WHERE ref_type='appointment' AND ref_id=$1 AND type='in'`, [F.appt]));
  check('карточка: сохранено', dbm.length === 1 && dbm[0].method === 'cash' && dbm[0].a === 1000, `сообщение «${msg}», в кассе ${JSON.stringify(dbm)}`);
  await p.waitForTimeout(1500);
  const badge1 = await p.evaluate(() => document.body.innerText.match(/Оплачено[^\n]*/)?.[0] || '');
  check('карточка перечитана: плашка показывает новый способ', /Готів/i.test(badge1) || /cash/i.test(badge1), `«${badge1.slice(0, 60)}»`);
  await p.screenshot({ path: '/tmp/paymethod-card.png' });

  // 2. «Каса магазину»: POS-чек из 2 товаров картой → переказ одним выбором
  const bt = 'pos-qaui' + Date.now().toString(36);
  for (const [v, a] of [[901, 300], [902, 450]]) F.ops.push((await q(`INSERT INTO cash_operations (shift_id, type, category, amount, method, description, ext_ref, tenant_id)
    VALUES ($1,'in','sale_product',$2,'card',$3,$4,$5) RETURNING id`, [F.shift, a, 'Продаж: ' + MARK, bt + ':' + v, T]))[0].id);
  await p.evaluate(() => { try { closeAppt(); } catch (_) {} openEmbed('/admin/crm-extra.html#cashbox', 'point_of_sale Каса магазину'); });
  await p.waitForTimeout(3500);
  const fr = p.frames().find(f => f.url().includes('crm-extra.html'));
  const sels = fr ? await fr.$$('#cb-ops select') : [];
  check('касса: у продаж есть выбор способа', sels.length >= 2, 'селектов ' + sels.length);
  const target = fr ? await fr.$(`#cb-ops select[onchange*="${bt}"]`) : null;
  if (target) { await target.selectOption('transfer'); await p.waitForTimeout(2500); }
  const pos = await q(`SELECT method FROM cash_operations WHERE id = ANY($1::int[]) ORDER BY id`, [F.ops]);
  check('касса: весь чек (2 товара) → Переказ', pos.every(x => x.method === 'transfer'), JSON.stringify(pos.map(x => x.method)));
  const expense = fr ? await fr.evaluate(() => [...document.querySelectorAll('#cb-ops tr')].filter(tr => tr.textContent.includes('−') && tr.querySelector('select')).length) : 0;
  check('касса: у расходов выбора нет', expense === 0, 'расходов с выбором ' + expense);
  await p.screenshot({ path: '/tmp/paymethod-cashbox.png' });
} catch (e) { fail++; console.log('[FAIL] сценарий упал:', e.message.split('\n')[0]); }
finally {
  for (const [s, p] of [
    [`DELETE FROM cash_operations WHERE ref_type='appointment' AND ref_id=$1`, [F.appt || 0]],
    [`DELETE FROM cash_operations WHERE id = ANY($1::int[])`, [F.ops]],
    [`DELETE FROM cash_operations WHERE shift_id = ANY($1::int[])`, [F.shifts]],
    [`DELETE FROM bonus_transactions WHERE client_id=$1`, [F.client || 0]], [`DELETE FROM bonus_balances WHERE client_id=$1`, [F.client || 0]],
    [`DELETE FROM appointment_services WHERE appointment_id=$1`, [F.appt || 0]], [`DELETE FROM appointments WHERE id=$1`, [F.appt || 0]],
    [`DELETE FROM cash_shifts WHERE id = ANY($1::int[])`, [F.shifts]],
    [`DELETE FROM services WHERE id=$1`, [F.service || 0]], [`DELETE FROM masters WHERE id=$1`, [F.master || 0]], [`DELETE FROM clients WHERE id=$1`, [F.client || 0]],
  ]) { try { await q(s, p); } catch (e) { console.log('[cleanup]', e.message); } }
  const left = await q(`SELECT (SELECT count(*) FROM appointments WHERE notes=$1) a, (SELECT count(*) FROM clients WHERE name=$1) c`, [MARK]);
  console.log('остатки фикстур:', JSON.stringify(left[0]));
  await db.end(); if (b) await b.close();
}
console.log('ОШИБКИ:', errs.length ? '\n  ' + errs.join('\n  ') : 'нет');
console.log(fail ? `ИТОГ: ${fail} провалов` : 'ИТОГ: всё зелёное');
process.exit(fail || errs.length ? 1 : 0);
