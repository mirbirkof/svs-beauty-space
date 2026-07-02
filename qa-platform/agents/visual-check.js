/* AI Visual Tester — ловит ВИЗУАЛЬНЫЕ нестыковки через реальный браузер (Playwright):
   элементы вылезают за экран, наложения, пустые кнопки, невидимый текст, битые картинки.
   Работает против staging. Каждая находка — человеческим языком (для не-технаря). */
const cfg = require('../config');

const PAGES = ['/admin/index.html', '/admin/qa.html', '/admin/crm-extra.html', '/admin/bi.html', '/admin/crm-marketing.html'];

async function ping(base) {
  try { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 6000);
    const r = await fetch(base.replace(/\/$/, '') + '/health', { signal: ac.signal }); clearTimeout(t); return r.ok; }
  catch (_) { return false; }
}

module.exports = {
  name: 'visual-check', role: 'ux',
  async run({ regression } = {}) {
    const bugs = [], scenarios = [], coverage = [];
    const base = cfg.stagingApi;
    if (!base || !(await ping(base))) {
      return { scenarios: ['visual:gated'], bugs: [{ severity: 'low', module: 'ux', role: 'ux',
        title: 'Визуальная проверка не выполнена: нет staging', needsManual: true, manualReason: 'staging недоступен' }], coverage: [] };
    }
    let chromium; try { ({ chromium } = require('playwright')); }
    catch (_) { return { scenarios: ['visual:no-playwright'], bugs: [], coverage: [] }; }

    let browser;
    try {
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
      // проверяем на десктопе и на телефоне (адаптивность)
      const viewports = [{ name: 'десктоп', width: 1280, height: 900 }, { name: 'телефон', width: 390, height: 844 }];
      for (const vp of viewports) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        for (const pagePath of PAGES) {
          const key = pagePath.split('/').pop().replace('.html', '');
          const page = await context.newPage();
          try {
            await page.goto(base.replace(/\/$/, '') + pagePath, { timeout: 15000, waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1200);
            scenarios.push(`visual:${key}@${vp.name}`);

            // собираем визуальные проблемы прямо в браузере
            const issues = await page.evaluate((vpw) => {
              const out = { overflow: 0, emptyBtns: 0, brokenImgs: 0, invisibleText: 0, tinyTap: 0,
                            where: { emptyBtns: [], brokenImgs: [], invisibleText: [] } };
              const vw = vpw;
              // «адрес» элемента для фиксера: tag#id.классы + кусок текста
              const addr = (el) => {
                const id = el.id ? '#' + el.id : '';
                const cls = el.className && typeof el.className === 'string'
                  ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
                const txt = (el.innerText || el.getAttribute?.('src') || '').trim().slice(0, 40);
                return `${el.tagName.toLowerCase()}${id}${cls}${txt ? ' «' + txt + '»' : ''}`;
              };
              // 1) горизонтальный скролл = вёрстка вылезает за экран (одна дешёвая проверка, без перебора всех)
              if (document.documentElement.scrollWidth > vw + 4) out.overflow = document.documentElement.scrollWidth - vw;
              // 2) пустые кнопки/ссылки (нет текста и нет иконки)
              document.querySelectorAll('button, a.btn, .btn').forEach((b) => {
                const txt = (b.innerText || '').trim();
                const hasIcon = b.querySelector('img,svg,.material-icons-round,.material-icons,[class*=icon]');
                if (!txt && !hasIcon) { out.emptyBtns++; if (out.where.emptyBtns.length < 3) out.where.emptyBtns.push(addr(b)); }
              });
              // 3) битые картинки
              document.querySelectorAll('img').forEach((im) => {
                if (im.complete && im.naturalWidth === 0) { out.brokenImgs++; if (out.where.brokenImgs.length < 3) out.where.brokenImgs.push(addr(im)); }
              });
              // 4) невидимый текст (цвет совпадает с фоном).
              // ВАЖНО (02.07): проверяем только СОБСТВЕННЫЙ текст элемента (прямые текстовые узлы),
              // не текст детей — иначе контейнер с тёмным фоном ложно флагается, хотя видимый
              // текст рисуют дочерние элементы своим цветом (было: экран входа div#login).
              // 'div' убран — почти всегда контейнер. Прозрачный фон (rgba…,0) не считаем.
              document.querySelectorAll('p,span,td,label,h1,h2,h3,a,button').forEach((el) => {
                const ownText = Array.from(el.childNodes)
                  .filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
                if (!ownText) return; // текст только у детей → это контейнер, пропускаем
                const s = getComputedStyle(el);
                const transparent = !s.backgroundColor || /rgba?\([^)]*,\s*0\s*\)$/.test(s.backgroundColor);
                if (s.color && s.backgroundColor && s.color === s.backgroundColor && !transparent) {
                  out.invisibleText++;
                  if (out.where.invisibleText.length < 3) out.where.invisibleText.push(`${addr(el)} [цвет=${s.color}]`);
                }
              });
              // 5) слишком мелкие кнопки для пальца (на телефоне < 32px)
              if (vw < 500) document.querySelectorAll('button, a.btn, .btn').forEach((b) => {
                const r = b.getBoundingClientRect(); if (r.height > 0 && r.height < 32) out.tinyTap++;
              });
              return out;
            }, vp.width);
            const loc = (k) => issues.where[k]?.length ? ` ГДЕ: ${issues.where[k].join(' | ')}` : '';

            const push = (cond, sev, title, human) => {
              coverage.push(['ux', `${title}:${key}@${vp.name}`, !cond]);
              if (cond) bugs.push({ severity: sev, module: 'ux', role: 'ux',
                title: `${title} — ${key} (${vp.name})`, scenario: `визуальный осмотр ${pagePath} на ${vp.name}`,
                expected: 'вёрстка ровная', actual: human, stillBroken: true });
            };
            push(issues.overflow > 20, 'medium', 'Вёрстка вылезает за край экрана',
              `страница шире экрана на ${issues.overflow}px — на ${vp.name} появляется кривой горизонтальный скролл, вёрстка "разъезжается"`);
            push(issues.emptyBtns > 0, 'medium', 'Пустые кнопки без подписи',
              `${issues.emptyBtns} кнопок без текста и без иконки — человек не поймёт, что они делают.${loc('emptyBtns')}`);
            push(issues.brokenImgs > 0, 'high', 'Битые картинки',
              `${issues.brokenImgs} картинок не загрузились — вместо них пустые квадраты.${loc('brokenImgs')}`);
            push(issues.invisibleText > 0, 'high', 'Невидимый текст',
              `${issues.invisibleText} мест, где текст того же цвета что и фон — его не видно.${loc('invisibleText')}`);
            push(issues.tinyTap > 3, 'low', 'Слишком мелкие кнопки на телефоне',
              `${issues.tinyTap} кнопок меньше 32px — на телефоне тяжело попасть пальцем`);
          } catch (e) {
            coverage.push(['ux', `visual-load:${key}@${vp.name}`, false]);
          } finally { await page.close().catch(() => {}); }
          if (regression) break;
        }
        await context.close();
        if (regression) break;
      }
    } catch (e) {
      bugs.push({ severity: 'medium', module: 'ux', role: 'ux', title: 'Визуальная проверка упала (браузер)',
        scenario: 'playwright visual', expected: 'работает', actual: String(e.message).slice(0, 150) });
    } finally { if (browser) await browser.close().catch(() => {}); }
    return { scenarios, bugs, coverage };
  },
};
