/* AI Product Owner — мета-агент. Не ищет баги напрямую, а УПРАВЛЯЕТ покрытием:
   анализирует что протестировано, находит непокрытые модули CRM, генерирует новые сценарии
   и предложения по росту сложности. Это «мозг» loop-режима из ТЗ. Выход → data/coverage-analysis.json. */
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const { q } = require('../lib/crm');
const reg = require('../lib/registry');

// Список всех бизнес-модулей CRM (эталон полноты). Что НЕ покрыто — становится TODO для новых агентов.
const ALL_MODULES = ['schedule', 'clients', 'masters', 'finance', 'cash', 'payouts', 'warehouse', 'certificates',
  'loyalty', 'beauty', 'documents', 'kb', 'surveys', 'tasks', 'incidents', 'eventbus', 'workflow', 'marketing',
  'security', 'api', 'load', 'ux', 'subscriptions', 'reviews'];

module.exports = {
  name: 'product-owner', role: 'product-owner',
  async run({ regression } = {}) {
    const scenarios = ['po:coverage-analysis'];
    const coverage = [];
    if (regression) return { scenarios: [], bugs: [], coverage: [] };

    const cov = reg.coverage();
    const tested = Object.keys(cov);
    const untested = ALL_MODULES.filter((m) => !tested.includes(m));

    // Подсчёт реальных таблиц в БД — индикатор размера непокрытой поверхности
    const tableCount = (await q(`SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public'`).catch(() => [{ n: 0 }]))[0].n;
    const checksTotal = Object.values(cov).reduce((a, m) => a + Object.keys(m.items || {}).length, 0);

    // Генерация новых сценариев для непокрытых модулей (TODO-лист для будущих агентов).
    const newScenarios = untested.map((m) => ({ module: m, suggestion: `Создать read-only правила целостности для модуля «${m}»`, priority: 'medium' }));

    const analysis = {
      at: new Date().toISOString(),
      modulesTested: tested.length, modulesTotal: ALL_MODULES.length,
      coveragePct: Math.round(tested.length / ALL_MODULES.length * 100),
      checksTotal, dbTables: tableCount,
      untestedModules: untested,
      openBugs: reg.openBugs().length, manualBugs: reg.manualBugs().length,
      newScenariosProposed: newScenarios,
      note: 'Покрытие растёт добавлением правил/агентов. Деструктивная половина (load/security-active/role-write/UI) ждёт изолированный staging.',
    };
    fs.writeFileSync(path.join(cfg.dataDir, 'coverage-analysis.json'), JSON.stringify(analysis, null, 2));

    coverage.push(['meta', 'coverage-analysis', true]);
    // PO не плодит баги — выдаёт непокрытые зоны как needs-manual TODO (видно в отчёте, не шумит как дефект).
    const bugs = untested.slice(0, 5).map((m) => ({ severity: 'low', module: m, role: 'product-owner',
      title: `Модуль «${m}» ещё не покрыт автотестами`, needsManual: true,
      manualReason: 'Product Owner: предложено создать правила целостности для этого модуля (см. coverage-analysis.json)' }));

    return { scenarios, bugs, coverage };
  },
};
