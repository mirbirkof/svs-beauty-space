// Браузерна перевірка 02.10 «окремий % майстра за послугу» — ПК 1280×800, власник, пісочниця (QA_DB_URL), свій сервер :3037.
// Сценарій: Зарплата → Схеми → «Нова / змінити схему» → майстер (поля схеми підставились) → «+ Додати послугу» → % → Зберегти
// → правило в БД, схема НЕ задвоїлась, у таблиці «+1 послуга з окремим %» → перезавантаження → правило на місці →
// 🗑 → Зберегти → правила немає. Фікс-схема → підказка. Фікстури QA-SVCPCT-UI прибираються.
// Запуск: PLAYWRIGHT_BROWSERS_PATH=/home/client/workspace/.ms-playwright node ops/repro-svcpct-0210.mjs
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url + '/../../backend/');
const BK = new URL('../backend/', import.meta.url).pathname;
require(BK + 'node_modules/dotenv').config({ path: BK + '.env' });
const { startQaServer } = require(BK + 'test/_qa-server.js');
const { Client } = require(BK + 'node_modules/pg');

const PORT = Number(process.env.REPRO_PORT || 3037);
const MARK = 'QA-SVCPCT-UI';
const TENANT = '00000000-0000-0000-0000-000000000001';
const SHOTS = new URL('../reports/svcpct-0210/', import.meta.url).pathname; mkdirSync(SHOTS, { recursive: true });
const db = new Client({ connectionString: process.env.QA_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;
let S, b, ownerId, masterId, svcId;
const out = { checks: [], errs: [] };
const check = (name, ok, extra = '') => { out.checks.push(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };
try {
  masterId = (await q(`INSERT INTO masters (name, active, tenant_id) VALUES ($1,true,$2) RETURNING id`, [MARK + ' майстер', TENANT]))[0].id;
  svcId = (await q(`INSERT INTO services (name, duration_min, price, tenant_id) VALUES ($1,60,1000,$2) RETURNING id`, [MARK + ' стрижка', TENANT]))[0].id;
  S = await startQaServer({ port: PORT });
  const api = async (m, u, body) => (await fetch(S.base + u, { method: m, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': S.token }, body: body ? JSON.stringify(body) : undefined })).json();
  await api('POST', '/api/payroll/schemes', { master_id: String(masterId), master_name: MARK + ' майстер', scheme_type: 'percent', percent: 40, percent_base: 'net' });
  const schemesBefore = (await q(`SELECT count(*)::int n FROM payroll_schemes WHERE master_id=$1`, [String(masterId)]))[0].n;

  const ownRole = (await q(`SELECT id FROM roles WHERE code='owner' ORDER BY id LIMIT 1`))[0];
  ownerId = (await q(`INSERT INTO users (display_name, role_id, is_active, tenant_id) VALUES ($1,$2,true,$3) RETURNING id`, [MARK + ' власник', ownRole.id, TENANT]))[0].id;
  const OWN = crypto.randomBytes(32).toString('hex');
  await q(`INSERT INTO user_tokens (user_id, token_hash, label, expires_at, tenant_id) VALUES ($1,$2,$3,NOW()+INTERVAL '1 hour',$4)`, [ownerId, crypto.createHash('sha256').update(OWN).digest('hex'), MARK, TENANT]);
  const ownerUser = (await (await fetch(S.base + '/api/auth/staff/me', { headers: { Authorization: 'Bearer ' + OWN } })).json()).user;

  b = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => out.errs.push('JS: ' + e.message));
  await p.goto(S.base + '/admin/', { waitUntil: 'domcontentloaded' });
  await p.evaluate(({ t, u }) => { localStorage.setItem('svs_admin_token', t); localStorage.setItem('svs_user', JSON.stringify(u)); }, { t: OWN, u: ownerUser });
  const openSchemes = async () => {
    await p.goto(S.base + '/admin/', { waitUntil: 'networkidle' });
    await p.evaluate(() => go('payroll'));
    await p.evaluate(() => payrollTab('schemes'));
    await p.waitForSelector('#payrollList table', { timeout: 20000 });
  };
  const openForm = async () => {
    await p.click('#pypane-schemes button:has-text("Нова / змінити схему")');
    await p.waitForSelector('#sfMaster');
    await p.selectOption('#sfMaster', String(masterId));
  };
  check('viewport = width=1280', (await p.evaluate(() => document.querySelector('meta[name=viewport]').content)) === 'width=1280');
  await openSchemes();
  await openForm();
  check('поля схеми підставились (40%)', (await p.inputValue('#sfPercent')) === '40', await p.inputValue('#sfPercent'));
  check('блок «Окремий % на послуги» видно', await p.isVisible('#sfSvcSec >> text=Окремий % на послуги'));
  await p.click('#sfAddRuleBtn');
  await p.fill('#sfRules .sf-rule:last-child .sf-rule-svc', `${MARK} стрижка`);
  // datalist: обираємо повну мітку «назва · категорія #id»
  const label = await p.evaluate((id) => [...document.querySelectorAll('#sfSvcList option')].map(o => o.value).find(v => v.endsWith('#' + id)), svcId);
  check('послуга є в пошуку (datalist)', !!label, label || '');
  await p.fill('#sfRules .sf-rule:last-child .sf-rule-svc', label || '');
  await p.fill('#sfRules .sf-rule:last-child .sf-rule-pct', '50');
  await p.screenshot({ path: SHOTS + '1-form-rule.png' });
  await p.click('#genModalOk');
  await p.waitForSelector('#genModal', { state: 'detached', timeout: 15000 });
  await p.waitForTimeout(800);
  const rules1 = await q(`SELECT scope, scope_ref, percentage::float pct, rule_type, is_active FROM payroll_rules WHERE master_id=$1`, [masterId]);
  check('правило збережено в БД', rules1.length === 1 && rules1[0].scope === 'service' && rules1[0].scope_ref === String(svcId) && rules1[0].pct === 50 && rules1[0].rule_type === 'percent_service', JSON.stringify(rules1));
  const schemesAfter = (await q(`SELECT count(*)::int n FROM payroll_schemes WHERE master_id=$1`, [String(masterId)]))[0].n;
  check('схема не задвоїлась (не змінювали — не перезаписали)', schemesAfter === schemesBefore, `${schemesBefore} → ${schemesAfter}`);
  const markTxt = await p.evaluate((n) => [...document.querySelectorAll('#payrollList tr')].find(tr => tr.textContent.includes(n))?.querySelector('.py-svc-mark')?.textContent || '', MARK);
  check('у таблиці позначка «+1 послуга з окремим %»', /\+1 послуга з окремим %/.test(markTxt), markTxt);
  // перезавантаження → правило на місці
  await openSchemes();
  const markTxt2 = await p.evaluate((n) => [...document.querySelectorAll('#payrollList tr')].find(tr => tr.textContent.includes(n))?.querySelector('.py-svc-mark')?.textContent || '', MARK);
  check('після перезавантаження позначка лишилась', /\+1 послуга/.test(markTxt2));
  await p.screenshot({ path: SHOTS + '2-table-mark.png' });
  await openForm();
  const row = await p.evaluate(() => [...document.querySelectorAll('#sfRules .sf-rule')].map(r => [r.querySelector('.sf-rule-svc').value, r.querySelector('.sf-rule-pct').value]));
  check('після перезавантаження правило у формі', row.length === 1 && row[0][0].endsWith('#' + svcId) && row[0][1] === '50', JSON.stringify(row));
  // фікс-схема → підказка
  await p.selectOption('#sfType', 'fixed');
  check('фікс-схема: підказка «не діють»', await p.isVisible('.sf-fixed-hint'));
  await p.screenshot({ path: SHOTS + '3-fixed-hint.png' });
  await p.selectOption('#sfType', 'percent');
  // видалити правило
  await p.click('#sfRules .sf-rule .sf-rule-del');
  await p.click('#genModalOk');
  await p.waitForSelector('#genModal', { state: 'detached', timeout: 15000 });
  await p.waitForTimeout(800);
  const rules2 = await q(`SELECT id FROM payroll_rules WHERE master_id=$1`, [masterId]);
  check('правило видалено', rules2.length === 0);
  await openSchemes();
  const markTxt3 = await p.evaluate((n) => [...document.querySelectorAll('#payrollList tr')].find(tr => tr.textContent.includes(n))?.querySelector('.py-svc-mark')?.textContent || '', MARK);
  check('позначка зникла', markTxt3 === '');
  check('схема так і не задвоїлась', (await q(`SELECT count(*)::int n FROM payroll_schemes WHERE master_id=$1`, [String(masterId)]))[0].n === schemesBefore);
  check('JS-помилок 0', out.errs.length === 0, out.errs.join(' | '));
} catch (e) { out.checks.push('✗ ВПАЛО: ' + e.message); }
finally {
  if (b) await b.close();
  if (S) S.stop();
  if (masterId) {
    await q(`DELETE FROM payroll_rules WHERE master_id=$1`, [masterId]);
    await q(`DELETE FROM payroll_schemes WHERE master_id=$1`, [String(masterId)]);
    await q(`DELETE FROM masters WHERE id=$1`, [masterId]);
  }
  if (svcId) await q(`DELETE FROM services WHERE id=$1`, [svcId]);
  if (ownerId) { await q(`DELETE FROM user_tokens WHERE user_id=$1`, [ownerId]); await q(`DELETE FROM audit_log WHERE user_id=$1`, [ownerId]).catch(() => {}); await q(`DELETE FROM users WHERE id=$1`, [ownerId]); }
  const left = (await q(`SELECT (SELECT count(*) FROM masters WHERE name LIKE $1)::int m, (SELECT count(*) FROM services WHERE name LIKE $1)::int s, (SELECT count(*) FROM users WHERE display_name LIKE $1)::int u`, [MARK + '%']))[0];
  await db.end();
  console.log(out.checks.join('\n'));
  console.log('залишки фікстур:', JSON.stringify(left));
  const bad = out.checks.filter(c => c.startsWith('✗')).length;
  console.log(bad ? `ИТОГ: ${bad} провалено` : `ИТОГ: ${out.checks.length}/${out.checks.length} OK`);
  process.exit(bad ? 1 : 0);
}
