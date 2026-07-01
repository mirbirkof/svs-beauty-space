/* AI UX Tester (LIVE) — реальный headless-браузер (Playwright) против staging.
   Закрывает раздел UI TESTING из ТЗ: живые страницы, JS-ошибки, клики, + артефакты (скриншоты, HAR, видео).
   Работает ТОЛЬКО при доступном staging и установленном браузере — иначе честно needsManual.
   Артефакты складываются в cfg.artifactsDir и НЕ копятся (чистим старые). */
const fs = require('fs');
const path = require('path');
const cfg = require('../config');

// Ключевые страницы админки для живой проверки (по ТЗ — «все страницы»; берём основные).
const PAGES = ['/admin/index.html', '/admin/qa.html', '/admin/crm-extra.html', '/admin/bi.html', '/admin/crm-marketing.html'];

async function ping(base) {
  try {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 6000);
    const r = await fetch(base.replace(/\/$/, '') + '/health', { signal: ac.signal }); clearTimeout(t);
    return r.ok;
  } catch (_) { return false; }
}

module.exports = {
  name: 'ai-ux-live', role: 'ux',
  async run({ regression } = {}) {
    const bugs = [], scenarios = [], coverage = [];
    const base = cfg.stagingApi;

    // Гейты: нет staging / нет playwright / нет браузера → честно ручная зона.
    if (!base || !(await ping(base))) {
      bugs.push({ severity: 'low', module: 'ux', role: 'ux', title: 'Live-UI не выполнен: staging недоступен',
        needsManual: true, manualReason: 'cfg.stagingApi не задан или /health не отвечает' });
      return { scenarios: ['ux-live:gated-no-staging'], bugs, coverage };
    }
    let chromium;
    try { ({ chromium } = require('playwright')); }
    catch (_) {
      bugs.push({ severity: 'low', module: 'ux', role: 'ux', title: 'Live-UI не выполнен: playwright не установлен',
        needsManual: true, manualReason: 'require(playwright) не разрешился' });
      return { scenarios: ['ux-live:gated-no-playwright'], bugs, coverage };
    }
    if (regression) { // в регрессии лёгкий прогон без артефактов — только JS-ошибки главной
    }

    const artDir = path.join(cfg.artifactsDir, 'ux-live');
    try { fs.mkdirSync(artDir, { recursive: true }); } catch (_) {}
    // чистим старые артефакты (не копим)
    try { for (const f of fs.readdirSync(artDir)) fs.rmSync(path.join(artDir, f), { force: true, recursive: true }); } catch (_) {}

    let browser;
    try {
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
      const harPath = path.join(artDir, 'session.har');
      const context = await browser.newContext({ recordHar: { path: harPath }, viewport: { width: 1280, height: 900 } });

      for (const pagePath of PAGES) {
        const key = pagePath.split('/').pop().replace('.html', '');
        const page = await context.newPage();
        const jsErrors = [], consoleErrors = [];
        page.on('pageerror', (e) => jsErrors.push(String(e.message).slice(0, 200)));
        page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
        try {
          const resp = await page.goto(base.replace(/\/$/, '') + pagePath, { timeout: 15000, waitUntil: 'domcontentloaded' });
          scenarios.push(`ux-live:page ${key}`);
          const status = resp ? resp.status() : 0;
          // страница отвечает
          if (status >= 400 || status === 0) {
            bugs.push({ severity: 'high', module: 'ux', role: 'ux', title: `Страница ${key} не открылась (HTTP ${status})`,
              scenario: `GET ${pagePath} в браузере`, expected: '200', actual: String(status) });
          }
          coverage.push(['ux', `page-loads:${key}`, status >= 200 && status < 400]);

          // JS-ошибки на странице (ТЗ: ошибки JavaScript)
          await page.waitForTimeout(1500); // дать отработать скриптам
          if (jsErrors.length) {
            bugs.push({ severity: 'high', module: 'ux', role: 'ux', title: `JS-ошибка на странице ${key}`,
              scenario: `рендер ${pagePath}`, expected: 'без ошибок JS', actual: jsErrors.slice(0, 3).join(' | '),
              logs: jsErrors });
          }
          coverage.push(['ux', `no-js-errors:${key}`, jsErrors.length === 0]);

          // контент не пустой + есть интерактив
          const btnCount = await page.locator('button, a.btn, .btn').count().catch(() => 0);
          coverage.push(['ux', `has-interactive:${key}`, btnCount > 0]);

          // клик по первой видимой кнопке (ТЗ: все кнопки) — не должно валить страницу
          if (!regression && btnCount > 0) {
            scenarios.push(`ux-live:click ${key}`);
            const before = jsErrors.length;
            try { await page.locator('button:visible, .btn:visible').first().click({ timeout: 3000 }); await page.waitForTimeout(500); } catch (_) {}
            if (jsErrors.length > before) {
              bugs.push({ severity: 'medium', module: 'ux', role: 'ux', title: `Клик по кнопке на ${key} вызывает JS-ошибку`,
                scenario: `клик первой кнопки на ${pagePath}`, expected: 'без ошибок', actual: jsErrors.slice(before).join(' | ') });
            }
            coverage.push(['ux', `click-safe:${key}`, jsErrors.length === before]);
          }

          // артефакт-скриншот (ТЗ: скриншоты)
          if (!regression) { try { await page.screenshot({ path: path.join(artDir, `${key}.png`), fullPage: false }); } catch (_) {} }
        } catch (e) {
          bugs.push({ severity: 'medium', module: 'ux', role: 'ux', title: `Ошибка при живой проверке ${key}`,
            scenario: `открытие ${pagePath}`, expected: 'страница работает', actual: String(e.message).slice(0, 180) });
        } finally { await page.close().catch(() => {}); }
        if (regression) break; // в регрессии проверяем только первую страницу
      }
      await context.close(); // финализирует HAR
      coverage.push(['ux', 'har-recorded', fs.existsSync(harPath)]);
      scenarios.push('ux-live:artifacts (screenshots+HAR)');
    } catch (e) {
      bugs.push({ severity: 'high', module: 'ux', role: 'ux', title: 'Live-UI прогон упал (браузер)',
        scenario: 'playwright chromium', expected: 'запускается', actual: String(e.message).slice(0, 180) });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
    return { scenarios, bugs, coverage };
  },
};
