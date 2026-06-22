/* UI smoke-тест админки «как пользователь» — десктоп + мобильный.
   Заходит в прод-админку с ADMIN_TOKEN, реально кликает/тапает ключевые
   функции и проверяет что они открылись (а не просто «код на месте»).
   Гоняет ДВА профиля: desktop (1366×900) и mobile (iPhone 13, touch),
   потому что Босс пользуется и телефоном — вёрстка админки не адаптивная.
   Запуск:
     PLAYWRIGHT_BROWSERS_PATH=~/workspace/.pw-browsers \
       node backend/scripts/ui-smoke.mjs [https://svs-shop-api.onrender.com]
   Выход: код 0 если всё PASS, 1 если хоть один FAIL.
*/
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { chromium, devices } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || 'https://svs-shop-api.onrender.com';

function readToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  const env = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  const m = env.match(/^ADMIN_TOKEN=(.*)$/m);
  if (!m) throw new Error('ADMIN_TOKEN not found');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

const results = [];

async function runProfile(browser, TOK, profile) {
  const { name, touch } = profile;
  const T = async (label, fn) => {
    const full = `[${name}] ${label}`;
    try { await fn(); results.push([true, full]); console.log('✓ ' + full); }
    catch (e) { results.push([false, full + ' — ' + e.message.split('\n')[0]]); console.log('✗ ' + full + ' — ' + e.message.split('\n')[0]); }
  };

  const ctx = touch
    ? await browser.newContext({ ...devices['iPhone 13'], hasTouch: true })
    : await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const p = await ctx.newPage();
  const jsErrors = [];
  p.on('pageerror', e => jsErrors.push(e.message));
  // универсальный «нажать»: tap на тач-устройстве, иначе click
  const press = async (loc, opts = {}) => touch ? loc.tap({ timeout: 6000, ...opts }) : loc.click({ timeout: 6000, ...opts });

  await p.goto(BASE + '/admin/', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await p.evaluate(t => localStorage.setItem('svs_admin_token', t), TOK);
  await p.goto(BASE + '/admin/', { waitUntil: 'networkidle', timeout: 60000 });
  await p.waitForTimeout(3000);

  await T('Логин прошёл (экран входа исчез)', async () => {
    if (await p.locator('.login-card').isVisible().catch(() => false)) throw new Error('login-card всё ещё видна');
  });

  await T('Основные функции меню определены в JS', async () => {
    const d = await p.evaluate(() => ({ e: typeof openEmbed, dr: typeof openDrill, g: typeof go }));
    if (d.e !== 'function' || d.dr !== 'function' || d.g !== 'function') throw new Error('функции не определены: ' + JSON.stringify(d));
  });

  await T('Нет JS-ошибок на загрузке', async () => {
    if (jsErrors.length) throw new Error(jsErrors.length + ' ошибок: ' + jsErrors[0]);
  });

  await T('Нет оверлея, перехватывающего клики по центру', async () => {
    const cover = await p.evaluate(() => {
      for (const el of document.querySelectorAll('body *')) {
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        if ((s.position === 'fixed' || s.position === 'absolute') &&
            r.width > innerWidth * 0.5 && r.height > innerHeight * 0.5 &&
            s.display !== 'none' && s.visibility !== 'hidden' &&
            s.pointerEvents !== 'none' && parseFloat(s.opacity) > 0.01)
          return el.tagName + '#' + el.id + '.' + ('' + el.className).slice(0, 30);
      }
      return null;
    });
    if (cover) throw new Error('экран перекрыт: ' + cover);
  });

  await T('Дашборд → «Відтік клієнтів» открывает модалку розбору', async () => {
    await p.evaluate(() => { try { go('dashboard'); } catch {} });
    await p.waitForTimeout(1200);
    const btn = p.locator('button:has-text("Відтік клієнтів")').first();
    await btn.scrollIntoViewIfNeeded({ timeout: 5000 });
    await press(btn);
    await p.waitForTimeout(1500);
    if (!await p.locator('#drillModal').isVisible()) throw new Error('drillModal не открылась');
    await press(p.locator('#drillModal [onclick*="closeDrill"]').first()).catch(() => {});
  });

  await T('План роботи адміністратора виден на дашборде', async () => {
    if (!await p.locator('#planCard').isVisible().catch(() => false)) throw new Error('planCard скрыта');
  });

  await T('Маркетинг → AI Відеостудія открывается (iframe грузится)', async () => {
    const header = p.locator('.sidebar-group-header:has-text("Маркетинг")').first();
    if (await header.count()) {
      const open = await header.evaluate(h => h.closest('.sidebar-group')?.classList.contains('open'));
      if (!open) { await press(header, { timeout: 5000 }); await p.waitForTimeout(600); }
    }
    const item = p.locator('.sidebar-item:has-text("AI Відеостудія")').first();
    await item.scrollIntoViewIfNeeded({ timeout: 5000 });
    await press(item);
    await p.waitForTimeout(2000);
    if (!await p.locator('iframe').count()) throw new Error('iframe видеостудии не появился');
  });

  await ctx.close();
}

async function run() {
  const TOK = readToken();
  console.log(`\n═══ UI SMOKE «как пользователь» @ ${BASE} ═══\n`);
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  await runProfile(b, TOK, { name: 'desktop', touch: false });
  await runProfile(b, TOK, { name: 'mobile', touch: true });
  await b.close();

  const fail = results.filter(r => !r[0]).length;
  console.log(`\n═══ ИТОГ: ${results.length - fail}/${results.length} PASS ═══`);
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
