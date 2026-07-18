/* ops/ui-explore.mjs — ИССЛЕДОВАТЕЛЬСКИЙ робо-кликер (Босс, 18.07.2026).
 * Идея Босса: не гонять одно и то же по 100 раз — ПРЕОБЛАДАЮТ НОВЫЕ комбинации,
 * старые перепроверяются реже (coverage-guided: вес выбора = давность проверки).
 * БЕЗОПАСНОСТЬ: только чтение и открытие/закрытие окон. НИКАКИХ мутаций данных.
 * Находит: JS-краши страниц, 500-ки API, пустые списки, сломанные модалки.
 * Журнал покрытия: /tmp/ui-explore-coverage.json (комбинация → last_checked, fails).
 * Токенов НЕ тратит — чистый Playwright. */
import pkg from '/home/client/workspace/node_modules/playwright/index.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
const { chromium } = pkg;
const BASE = process.env.SMOKE_BASE || 'https://svs-shop-api.onrender.com';
const TOKEN = process.env.ADMIN_TOKEN;
const COV_FILE = '/tmp/ui-explore-coverage.json';
const PICKS = Number(process.env.EXPLORE_PICKS || 8);   // комбинаций за прогон

// Матрица исследования: страницы (рендер без ошибок) + безопасные действия
const PAGES = ['dashboard','journal','pipeline','shifts','services','svccats','clients','waitlist',
  'repeat','blacklist','orders','giftcerts','subscriptions','finance','fincenter','cashflow',
  'budgets','contractors','reminders','promos','reviews','payroll','plan','products','stock',
  'purchasing','suppliers','qcontrol','callcenter','viber','branding','mobileapp','mysub',
  'settings','wsched','formulas','online','tasks','documents','incidents','surveys','kb'];
const ACTIONS = [
  { key: 'appt-open',    run: async (p) => p.evaluate(async () => { // открыть первую запись дня и закрыть
      const t = new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Kiev'});
      const j = await api('/api/schedule/appointments?from='+t+'&to='+t);
      const a = ((j&&(j.appointments||j.items))||[])[0];
      if (!a) return 'skip';
      openAppt(a.id); await new Promise(r=>setTimeout(r,1200));
      const ok = !!document.getElementById('apptModal') || !!document.querySelector('.modal-overlay');
      try { closeAppt(); } catch(e) {}
      return ok ? 'ok' : 'fail'; }) },
  { key: 'svc-modal',    run: async (p) => p.evaluate(async () => { // карточка услуги открывается и закрывается
      const r = await api('/api/services?limit=1'); const s=(r.items||[])[0];
      if (!s) return 'fail';
      svcEdit(s.id); await new Promise(r2=>setTimeout(r2,1200));
      const ok = !!document.getElementById('svcf_price');
      document.getElementById('svcModal')?.remove();
      return ok ? 'ok' : 'fail'; }) },
  { key: 'client-search',run: async (p) => p.evaluate(async () => {
      const r = await api('/api/admin/clients?limit=3&search=а');
      return (r && (r.items||r.clients)) ? 'ok' : 'fail'; }) },
  { key: 'cash-today',   run: async (p) => p.evaluate(async () => {
      const r = await api('/api/cashbox/today'); return r && r.total !== undefined ? 'ok' : 'fail'; }) },
  { key: 'master-links', run: async (p) => p.evaluate(async () => {
      const m = await api('/api/schedule/masters'); const id=(Array.isArray(m)?m:(m.items||m.masters||[]))[0]?.id;
      if (!id) return 'skip';
      const r = await api('/api/master-services/by-master/'+id);
      return Array.isArray(r.items) ? 'ok' : 'fail'; }) },
];

// coverage: ключ → { last: ts, fails: n }
let cov = {};
try { if (existsSync(COV_FILE)) cov = JSON.parse(readFileSync(COV_FILE, 'utf8')); } catch (_) {}
const allKeys = [...PAGES.map(x => 'page:' + x), ...ACTIONS.map(a => 'act:' + a.key)];
// вес = давность (никогда не проверяли = максимум) + бонус за прошлые фейлы
function weight(k) {
  const c = cov[k];
  if (!c) return 1e9;                       // новое — наивысший приоритет
  return (Date.now() - c.last) + (c.fails || 0) * 3600e3;
}
const picked = allKeys.map(k => ({ k, w: weight(k) * (0.5 + Math.random()) }))
  .sort((a, b) => b.w - a.w).slice(0, PICKS).map(x => x.k);

const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage();
const jsErrors = [];
p.on('pageerror', e => jsErrors.push(e.message.slice(0, 150)));
const bad = [];
try {
  await p.goto(BASE + '/admin/', { waitUntil: 'domcontentloaded' });
  await p.evaluate(t => localStorage.setItem('svs_admin_token', t), TOKEN);
  await p.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);

  for (const key of picked) {
    const before = jsErrors.length;
    let res = 'ok';
    try {
      if (key.startsWith('page:')) {
        const pg = key.slice(5);
        res = await p.evaluate(async (pg2) => {
          try { go(pg2); } catch (e) { return 'fail:' + e.message.slice(0, 60); }
          await new Promise(r => setTimeout(r, 1500));
          const el = document.getElementById('page-' + pg2);
          return el && el.style.display !== 'none' ? 'ok' : 'no-render';
        }, pg);
      } else {
        const act = ACTIONS.find(a => 'act:' + a.key === key);
        res = await act.run(p);
      }
    } catch (e) { res = 'err:' + e.message.slice(0, 80); }
    const newJs = jsErrors.length - before;
    const failed = !(res === 'ok' || res === 'skip') || newJs > 0;
    cov[key] = { last: Date.now(), fails: failed ? ((cov[key]?.fails || 0) + 1) : 0 };
    console.log((failed ? '[-] ' : '[+] ') + key + ' → ' + res + (newJs ? ` (+${newJs} JS-err)` : ''));
    if (failed) bad.push(key + '=' + res + (newJs ? ' jsErr:' + jsErrors.slice(-newJs).join(';') : ''));
  }
} finally { await b.close(); }
writeFileSync(COV_FILE, JSON.stringify(cov));
const total = allKeys.length, checked = allKeys.filter(k => cov[k]).length;
console.log(`\nПокрытие: ${checked}/${total} комбинаций хоть раз проверено`);
console.log(bad.length ? `=== EXPLORE: ПРОБЛЕМЫ (${bad.length}): ${bad.join(' | ')}` : '=== EXPLORE: чисто ===');
process.exit(bad.length ? 1 : 0);
