/* AI Visual Tester — ловит ВИЗУАЛЬНЫЕ нестыковки через реальный браузер (Playwright).
   Что проверяет: вёрстка вылезает за экран, наложения, пустые кнопки, невидимый/нечитаемый
   текст, битые картинки, мелкие тапы, И — ЭЛЕМЕНТЫ ВИСЯЩИЕ ПОВЕРХ ЭКРАНА ВХОДА (робот-кнопка,
   чат, виджеты, которые должны появляться только после логина).
   Проверяет ПУБЛИЧНЫЕ страницы на ПРОДЕ (логин, онлайн-запись, регистрация) — то, что реально
   видит клиент и владелец. Каждая находка — человеческим языком, для не-технаря. */
const cfg = require('../config');

// Публичные страницы прода — их видно без логина, тут и живут «очевидные» баги.
// login: экран входа (тут ловим лишние плавающие виджеты). book/signup: клиентские страницы.
const PUBLIC_PAGES = [
  { path: '/admin/index.html', key: 'login', kind: 'auth' },
  { path: '/p/book.html',      key: 'booking', kind: 'public' },
  { path: '/p/signup.html',    key: 'signup', kind: 'public' },
];

async function ping(base) {
  try { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 6000);
    const r = await fetch(base.replace(/\/$/, '') + '/health', { signal: ac.signal }); clearTimeout(t); return r.ok; }
  catch (_) { return false; }
}

module.exports = {
  name: 'visual-check', role: 'ux',
  async run({ regression } = {}) {
    const bugs = [], scenarios = [], coverage = [];
    // Прод — приоритет: там сидит владелец и клиенты. staging только как запасной.
    const base = (cfg.prodApiBase && (await ping(cfg.prodApiBase))) ? cfg.prodApiBase
               : (cfg.stagingApi && (await ping(cfg.stagingApi))) ? cfg.stagingApi : null;
    if (!base) {
      return { scenarios: ['visual:gated'], bugs: [{ severity: 'low', module: 'ux', role: 'ux',
        title: 'Визуальная проверка не выполнена: сервер недоступен', needsManual: true, manualReason: 'ни prod ни staging не отвечают' }], coverage: [] };
    }
    let chromium; try { ({ chromium } = require('playwright')); }
    catch (_) { return { scenarios: ['visual:no-playwright'], bugs: [], coverage: [] }; }

    let browser;
    try {
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
      const viewports = [{ name: 'десктоп', width: 1280, height: 900 }, { name: 'телефон', width: 390, height: 844 }];
      for (const vp of viewports) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, locale: 'uk-UA' });
        for (const pg of PUBLIC_PAGES) {
          const key = pg.key;
          const page = await context.newPage();
          try {
            await page.goto(base.replace(/\/$/, '') + pg.path, { timeout: 20000, waitUntil: 'networkidle' });
            await page.waitForTimeout(2500);
            scenarios.push(`visual:${key}@${vp.name}`);

            const issues = await page.evaluate(({ vw, kind }) => {
              const out = { overflow: 0, emptyBtns: 0, brokenImgs: 0, invisibleText: 0, lowContrast: 0,
                            tinyTap: 0, offscreen: 0, floatingOnAuth: 0,
                            where: { emptyBtns: [], brokenImgs: [], invisibleText: [], lowContrast: [], offscreen: [], floatingOnAuth: [] } };
              const addr = (el) => {
                const id = el.id ? '#' + el.id : '';
                const cls = el.className && typeof el.className === 'string'
                  ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
                const txt = (el.innerText || el.getAttribute?.('title') || el.getAttribute?.('src') || '').trim().slice(0, 40);
                return `${el.tagName.toLowerCase()}${id}${cls}${txt ? ' «' + txt + '»' : ''}`;
              };
              const isVisible = (el) => {
                const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) return false;
                const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4;
              };
              // яркость цвета для контраста
              const lum = (c) => { const m = (c || '').match(/\d+/g); if (!m) return null;
                const [r, g, b] = m.map(Number); return 0.299 * r + 0.587 * g + 0.114 * b; };

              // 1) горизонтальный скролл = вёрстка вылезает за экран
              if (document.documentElement.scrollWidth > vw + 4) out.overflow = document.documentElement.scrollWidth - vw;

              // 2) пустые кнопки/ссылки (нет текста и нет иконки)
              document.querySelectorAll('button, a.btn, .btn').forEach((b) => {
                if (!isVisible(b)) return;
                const txt = (b.innerText || '').trim();
                const hasIcon = b.querySelector('img,svg,.material-icons-round,.material-icons,[class*=icon]') || /[\u{1F000}-\u{1FAFF}☀-➿]/u.test(b.textContent || '');
                if (!txt && !hasIcon) { out.emptyBtns++; if (out.where.emptyBtns.length < 3) out.where.emptyBtns.push(addr(b)); }
              });

              // 3) битые картинки
              document.querySelectorAll('img').forEach((im) => {
                if (im.complete && im.naturalWidth === 0) { out.brokenImgs++; if (out.where.brokenImgs.length < 3) out.where.brokenImgs.push(addr(im)); }
              });

              // 4) невидимый / нечитаемый текст (совпадение или почти совпадение с фоном)
              const bgOf = (el) => { let n = el; while (n) { const s = getComputedStyle(n);
                if (s.backgroundColor && !/rgba?\([^)]*,\s*0\s*\)$/.test(s.backgroundColor) && s.backgroundColor !== 'transparent') return s.backgroundColor;
                n = n.parentElement; } return 'rgb(255,255,255)'; };
              document.querySelectorAll('p,span,td,label,h1,h2,h3,a,button,small,li,div').forEach((el) => {
                const ownText = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
                if (!ownText || !isVisible(el)) return;
                const s = getComputedStyle(el);
                if (s.color === s.backgroundColor && !/rgba?\([^)]*,\s*0\s*\)$/.test(s.backgroundColor)) {
                  out.invisibleText++; if (out.where.invisibleText.length < 3) out.where.invisibleText.push(`${addr(el)} [цвет=${s.color}]`); return;
                }
                const lc = lum(s.color), lb = lum(bgOf(el));
                if (lc != null && lb != null && Math.abs(lc - lb) < 40) {
                  out.lowContrast++; if (out.where.lowContrast.length < 3) out.where.lowContrast.push(`${addr(el)} [текст≈фон]`);
                }
              });

              // 5) мелкие тап-цели на телефоне
              if (vw < 500) document.querySelectorAll('button, a.btn, .btn').forEach((b) => {
                if (!isVisible(b)) return; const r = b.getBoundingClientRect(); if (r.height > 0 && r.height < 32) out.tinyTap++;
              });

              // 6) видимые элементы, вылезающие за правый край или ушедшие за левый (обрезка контента)
              document.querySelectorAll('button,a,input,img,.card,.btn,h1,h2,h3').forEach((el) => {
                if (!isVisible(el)) return; const r = el.getBoundingClientRect();
                if (r.width < vw && (r.right > vw + 6 || r.left < -6)) {
                  out.offscreen++; if (out.where.offscreen.length < 3) out.where.offscreen.push(addr(el));
                }
              });

              // 7) КЛЮЧЕВОЕ: на экране входа не должно быть плавающих интерактивных виджетов
              //    (робот-помощник, чат, кнопки-пузыри) — они для залогиненного кабинета.
              if (kind === 'auth') {
                const login = document.getElementById('login');
                const loginShown = login && getComputedStyle(login).display !== 'none';
                if (loginShown) {
                  document.querySelectorAll('button, a, [onclick], [role=button]').forEach((el) => {
                    if (!isVisible(el)) return;
                    const s = getComputedStyle(el);
                    if (s.position !== 'fixed' && s.position !== 'sticky') return;
                    const z = parseInt(s.zIndex, 10) || 0;
                    if (z < 50) return;
                    // элемент внутри формы входа — это нормально
                    if (login.contains(el)) return;
                    out.floatingOnAuth++;
                    if (out.where.floatingOnAuth.length < 4) out.where.floatingOnAuth.push(addr(el));
                  });
                }
              }
              return out;
            }, { vw: vp.width, kind: pg.kind });

            const loc = (k) => issues.where[k]?.length ? ` ГДЕ: ${issues.where[k].join(' | ')}` : '';
            const push = (cond, sev, title, human) => {
              coverage.push(['ux', `${title}:${key}@${vp.name}`, !cond]);
              if (cond) bugs.push({ severity: sev, module: 'ux', role: 'ux',
                title: `${title} — ${key} (${vp.name})`, scenario: `визуальный осмотр ${pg.path} на ${vp.name}`,
                expected: 'вёрстка ровная, ничего лишнего', actual: human, stillBroken: true });
            };

            push(issues.floatingOnAuth > 0, 'high', 'Лишний плавающий элемент поверх экрана входа',
              `${issues.floatingOnAuth} интерактивных элемент(ов) висят поверх формы входа ещё ДО авторизации — робот-помощник/чат/кнопка должны показываться только внутри кабинета, а не на логине.${loc('floatingOnAuth')}`);
            push(issues.overflow > 20, 'medium', 'Вёрстка вылезает за край экрана',
              `страница шире экрана на ${issues.overflow}px — на ${vp.name} появляется кривой горизонтальный скролл, вёрстка "разъезжается"`);
            push(issues.offscreen > 0, 'medium', 'Элементы обрезаны краем экрана',
              `${issues.offscreen} видимых элемента(ов) вылезают за границу экрана и обрезаются.${loc('offscreen')}`);
            push(issues.emptyBtns > 0, 'medium', 'Пустые кнопки без подписи',
              `${issues.emptyBtns} кнопок без текста и без иконки — человек не поймёт, что они делают.${loc('emptyBtns')}`);
            push(issues.brokenImgs > 0, 'high', 'Битые картинки',
              `${issues.brokenImgs} картинок не загрузились — вместо них пустые квадраты.${loc('brokenImgs')}`);
            push(issues.invisibleText > 0, 'high', 'Невидимый текст',
              `${issues.invisibleText} мест, где текст того же цвета что и фон — его не видно.${loc('invisibleText')}`);
            push(issues.lowContrast > 2, 'low', 'Плохо читаемый текст (низкий контраст)',
              `${issues.lowContrast} мест, где текст почти сливается с фоном — тяжело прочитать.${loc('lowContrast')}`);
            push(issues.tinyTap > 3, 'low', 'Слишком мелкие кнопки на телефоне',
              `${issues.tinyTap} кнопок меньше 32px — на телефоне тяжело попасть пальцем`);
          } catch (e) {
            coverage.push(['ux', `visual-load:${key}@${vp.name}`, false]);
          } finally { await page.close().catch(() => {}); }
          if (regression && key === 'login') break; // в regression-режиме хватает экрана входа
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
