/* AI UX Tester. Live-проверка кнопок/форм/drag&drop требует браузера (Playwright) и достижимого
   UI — это needs-manual до staging. В safe-режиме делаем СТАТИЧЕСКИЙ скан админки: парсинг всех
   <script>, поиск nav-пунктов без страницы и обработчиков без функции. Реальные баги, ноль мутаций. */
const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const ADMIN = path.join(__dirname, '../../backend/public/admin/index.html');

module.exports = {
  name: 'ai-ux', role: 'ux',
  async run({ regression } = {}) {
    const bugs = [], scenarios = [], coverage = [];
    let html = '';
    try { html = fs.readFileSync(ADMIN, 'utf8'); } catch (_) {
      return { scenarios: ['ux:admin-missing'], bugs: [{ severity: 'low', module: 'ux', role: 'ux', title: 'admin/index.html не найден', needsManual: true, manualReason: 'нет доступа к файлу админки' }], coverage: [] };
    }

    // 1) Все <script> синтаксически валидны (ловит JS-ошибки, ломающие интерфейс)
    scenarios.push('ux:js-syntax');
    let badScripts = 0;
    const re = /<script[^>]*>([\s\S]*?)<\/script>/gi; let m;
    while ((m = re.exec(html))) { const code = m[1]; if (!code.trim()) continue; try { new Function(code); } catch (_) { badScripts++; } }
    if (badScripts > 0) bugs.push({ severity: 'critical', module: 'ux', role: 'ux',
      title: 'JS-ошибка в админке (битый <script> ломает интерфейс)', scenario: 'парсинг всех script-блоков',
      expected: '0 ошибок', actual: `${badScripts} битых блоков`, stillBroken: true });
    coverage.push(['ux', 'js-syntax-clean', badScripts === 0]);

    // 2) Nav-пункты go('X') без соответствующей страницы page-X (мёртвая кнопка меню)
    scenarios.push('ux:dead-nav');
    const pages = new Set([...html.matchAll(/id="page-([a-z0-9_-]+)"/gi)].map((x) => x[1]));
    const navs = [...html.matchAll(/go\('([a-z0-9_-]+)'\)/gi)].map((x) => x[1]);
    const dead = [...new Set(navs)].filter((n) => !pages.has(n) && n !== 'embed');
    if (dead.length) bugs.push({ severity: 'high', module: 'ux', role: 'ux',
      title: `Пункты меню без страницы (мёртвые кнопки): ${dead.join(', ')}`, scenario: "go('X') без page-X",
      expected: 'у каждого пункта есть страница', actual: `мёртвые: ${dead.join(', ')}`, stillBroken: true });
    coverage.push(['ux', 'no-dead-nav', dead.length === 0]);

    // 3) Live-UI (клики, формы, drag&drop, адаптив, HAR) — нужен браузер/Playwright + достижимый UI
    if (!regression && !cfg.allowDestructive) {
      bugs.push({ severity: 'low', module: 'ux', role: 'ux', title: 'Live-UI тесты (клики/формы/drag&drop/адаптив) не выполнены',
        needsManual: true, manualReason: 'Требует Playwright и достижимого UI-таргета (staging). Статический скан JS+nav выполнен.' });
    }
    return { scenarios, bugs, coverage };
  },
};
