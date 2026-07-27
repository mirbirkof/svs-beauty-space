/* Перевірка входу в CRM ззовні — очима Боса (десктоп + телефон). */
const { chromium, devices } = require('playwright');
const URL = process.argv[2] || 'https://zvetlacrm.serveousercontent.com/';

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const out = {};
  for (const [name, ctxOpts, shot] of [
    ['desktop', { viewport: { width: 1440, height: 900 } }, '/tmp/login-desktop.png'],
    ['mobile', { ...devices['iPhone 13'] }, '/tmp/login-mobile.png'],
  ]) {
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => errs.push('GOTO ' + e.message.slice(0, 80)));
    await page.waitForTimeout(3000);
    const hasLoginForm = await page.locator('#login input, input[type=password]').count();
    const btn = await page.locator('button:has-text("Увійти"), button:has-text("Вхід")').count();
    const bodyText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140);
    await page.screenshot({ path: shot, fullPage: false });
    out[name] = { url: page.url(), inputs: hasLoginForm, login_button: btn, text: bodyText, errors: errs.slice(0, 4) };
    await ctx.close();
  }
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
