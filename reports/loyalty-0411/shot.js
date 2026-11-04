// loyalty-0411 скріни: мініап (мок Telegram + мок /api/miniapp) на проді :3011 і адмінка 1280 на QA-сервері
process.chdir('/home/client/workspace/svs-beauty-space/backend');
require('/home/client/workspace/svs-beauty-space/backend/node_modules/dotenv').config({path:'/home/client/workspace/svs-beauty-space/backend/.env'});
if (process.env.QA_DB_URL) { process.env.DATABASE_URL = process.env.QA_DB_URL; process.env.DATABASE_URL_APP = process.env.QA_DB_URL; }
const { chromium } = require('/home/client/workspace/node_modules/playwright/index.js');
const { startQaServer } = require('/home/client/workspace/svs-beauty-space/backend/test/_qa-server.js');
const out = '/home/client/workspace/svs-beauty-space/reports/loyalty-0411';
const res = {};
(async () => {
  const b = await chromium.launch();
  // ── 1. Мініап: кабінет без сум, картка «Оцініть візит», клік 5⭐
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  let rated = null, myRaw = null;
  const hist = [
    { id: 901, date: '2026-11-04', date_label: 'Сьогодні, 4 листопада', time: '11:00–12:30', service: 'Фарбування в один тон', master: 'Анжела', paid: true, bonus_accrued: 36, rating: null, can_rate: true, bill: { paid: true, can_pay: false } },
    { id: 880, date: '2026-10-20', date_label: '20 жовтня', time: '14:00–15:00', service: 'Манікюр з покриттям', master: 'Ксюша', paid: true, bonus_accrued: 14, rating: 5, can_rate: false },
    { id: 850, date: '2026-09-28', date_label: '28 вересня', time: '10:00–11:00', service: 'Стрижка кінчиків', master: 'Анжела', paid: true, bonus_accrued: 0, rating: null, can_rate: false },
  ];
  await p.route('**/telegram-web-app.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
  await p.route('**/api/miniapp/**', r => {
    const u = r.request().url();
    if (u.includes('/me')) return r.fulfill({ json: { user: { first_name: 'Олена' }, client: { name: 'Олена', has_phone: true, phone: '+380 99 000 00 00' }, master: { is_master: false } } });
    if (/\/rate$/.test(u)) { rated = JSON.parse(r.request().postData() || '{}'); return r.fulfill({ json: { ok: true, stars: rated.stars } }); }
    if (u.endsWith('/my')) { myRaw = { client: { name: 'Олена', phone: '+380 99 000 00 00', points: 236, visits: 12 }, upcoming: [], history: hist }; return r.fulfill({ json: myRaw }); }
    return r.fulfill({ json: {} });
  });
  await p.addInitScript(() => {
    try { localStorage.setItem('svs_phone_ask', String(Date.now())); localStorage.setItem('svs_hs_offered', '1'); } catch (_) {}
    const noop = () => {};
    const base = { initData: 'qa', initDataUnsafe: { user: { id: 1, first_name: 'Олена' } }, version: '8.0', platform: 'android', colorScheme: 'light', themeParams: {},
      isVersionAtLeast: () => true, checkHomeScreenStatus: (cb) => cb('added'), HapticFeedback: { selectionChanged: noop, notificationOccurred: noop, impactOccurred: noop } };
    const mk = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && /^[A-Z]/.test(k) ? mk({}) : noop)) });
    window.Telegram = { WebApp: mk(base) };
  });
  await p.goto('http://127.0.0.1:3011/p/app.html', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  await p.click('#mi-cab'); await p.waitForSelector('.rate', { timeout: 8000 }); await p.waitForTimeout(500);
  await p.screenshot({ path: out + '/01-cabinet-rate-card.png', fullPage: true });
  const txt = await p.evaluate(() => document.body.innerText);
  res.cabinet_has_grn = /грн|₴|витрачено|всього/i.test(txt);
  res.cabinet_has_bonus_line = txt.includes('+36 бонусів за візит');
  res.rate_card = await p.$eval('.rate .rt', e => e.textContent);
  await p.click('.rate .star[data-n="5"]'); await p.waitForTimeout(700);
  res.rated_sent = rated; res.rate_title_after = await p.$eval('.rate .rt', e => e.textContent);
  res.stars_on = await p.$$eval('.rate .star.on', a => a.length);
  await p.screenshot({ path: out + '/02-cabinet-rated-5.png', fullPage: true });
  await ctx.close();

  // ── 2. Справжня відповідь /api/miniapp/my з проду без підпису → 401 (суми не віддаються анонімно)
  res.prod_my_unsigned = (await fetch('http://127.0.0.1:3011/api/miniapp/my')).status;

  // ── 3. Адмінка 1280 на QA-сервері: ставки бонусів майстру + вкладка «Бонуси від клієнтів»
  const S = await startQaServer({ port: 3068 });
  try {
    const cfg = await (await fetch(S.base + '/api/bonus/master-loyalty', { headers: { 'X-Admin-Token': S.token } })).json();
    res.qa_master_loyalty_cfg = cfg;
    const ms = await (await fetch(S.base + '/api/masters', { headers: { 'X-Admin-Token': S.token } })).json().catch(() => null);
    const list = Array.isArray(ms) ? ms : (ms && (ms.items || ms.masters)) || [];
    const mid = Number(process.env.QA_MID) || (list.find(m => m.active !== false) || list[0] || {}).id;
    res.qa_master_id = mid;
    const a = await b.newContext({ viewport: { width: 1280, height: 860 } });
    const ap = await a.newPage();
    await ap.addInitScript((t) => { localStorage.setItem('svs_admin_token', t); localStorage.setItem('svs_user', JSON.stringify({ id: 1, role: 'owner', name: 'QA' })); }, S.token);
    // історію нарахувань підставляю демо-рядками (у QA нарахувань нема), сам UI — справжній
    await ap.route('**/api/bonus/master-rewards**', r => r.fulfill({ json: { balance: 47.5, total: 47.5, total_reversed: 9, master_client_id: 1,
      items: [
        { visit_date: '04.11.2026', client_name: 'Олена К.', condition: 'rating', label: 'Хороша оцінка (5⭐)', percent: 0.5, check_amount: 1800, amount: 9, status: 'accrued' },
        { visit_date: '04.11.2026', client_name: 'Олена К.', condition: 'rebook', label: 'Перезапис у день візиту', percent: 0.5, check_amount: 1800, amount: 9, status: 'accrued' },
        { visit_date: '04.11.2026', client_name: 'Олена К.', condition: 'return', label: 'Повернення клієнта', percent: 0.5, check_amount: 1800, amount: 9, status: 'accrued' },
        { visit_date: '03.11.2026', client_name: 'Ірина С.', condition: 'return', label: 'Повернення клієнта', percent: 0.5, check_amount: 4100, amount: 20.5, status: 'accrued' },
        { visit_date: '02.11.2026', client_name: 'Марія П.', condition: 'return', label: 'Повернення клієнта', percent: 0.5, check_amount: 1800, amount: 9, status: 'reversed', reverse_reason: 'скасовано оплату візиту' },
      ] } }));
    await ap.goto(S.base + '/admin/bonus.html?standalone=1', { waitUntil: 'networkidle' }); await ap.waitForTimeout(1500);
    await ap.waitForFunction(() => (document.getElementById('ml_return')||{}).value !== '', null, { timeout: 15000 }).catch(()=>{});
    res.ml_fields = await ap.evaluate(() => ['ml_enabled','ml_return','ml_rebook','ml_rating','ml_min'].map(i => (document.getElementById(i)||{}).value));
    res.rule2_text = (await ap.evaluate(() => document.body.innerText)).match(/Кешбек за візит \d+%/g);
    await ap.$eval('#mlCard', e => e.scrollIntoView({ block: 'center' })); await ap.waitForTimeout(400);
    await ap.screenshot({ path: out + '/03-admin-bonus-rates-1280.png' });
    await ap.goto(S.base + '/admin/index.html', { waitUntil: 'networkidle' }); await ap.waitForTimeout(2000);
    if (mid) {
      await ap.evaluate((id) => openMasterCard(id), mid); await ap.waitForTimeout(1500);
      await ap.evaluate(() => mcTab('bonus')); await ap.waitForTimeout(1200);
      res.master_tab = (await ap.evaluate(() => (document.getElementById('mcBonusBody') || {}).innerText || '')).slice(0, 300);
      await ap.screenshot({ path: out + '/04-admin-master-bonus-tab-1280.png' });
    }
    await a.close();
  } finally { try { await S.stop(); } catch (_) {} }
  await b.close();
  console.log(JSON.stringify(res, null, 1));
  process.exit(0);
})().catch(e => { console.error('ERR', e.stack); console.log(JSON.stringify(res)); process.exit(1); });
