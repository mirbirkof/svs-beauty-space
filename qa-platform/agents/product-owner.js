/* AI Product Owner — мета-агент. Не ищет баги напрямую, а УПРАВЛЯЕТ покрытием:
   анализирует что протестировано, находит непокрытые модули CRM, генерирует новые сценарии
   и предложения по росту сложности. Это «мозг» loop-режима из ТЗ. Выход → data/coverage-analysis.json. */
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const { q } = require('../lib/crm');
const reg = require('../lib/registry');
const { counted, skipped } = require('../lib/check');

// Список всех бизнес-модулей CRM (эталон полноты). Что НЕ покрыто — становится TODO для новых агентов.
const ALL_MODULES = ['schedule', 'clients', 'masters', 'finance', 'cash', 'payouts', 'warehouse', 'certificates',
  'loyalty', 'beauty', 'documents', 'kb', 'surveys', 'tasks', 'incidents', 'eventbus', 'workflow', 'marketing',
  'security', 'api', 'load', 'ux', 'subscriptions', 'reviews'];

module.exports = {
  name: 'product-owner', role: 'product-owner',
  async run({ regression } = {}) {
    const scenarios = ['po:coverage-analysis'];
    const coverage = [];
    const bugs = [];

    const cov = reg.coverage();
    // ПРИЧИНА (13.08). Модуль считался покрытым по одному факту НАЛИЧИЯ ключа в coverage.json —
    // даже если все его проверки стоят ok:false или 'skip' («не выполнились»). Получалось, что
    // процент покрытия РОС от неудачных проверок: чем больше проверок падало, тем «лучше» отчёт.
    // Покрытым считается только модуль, где хотя бы одна проверка реально прошла (ok === true).
    const tested = Object.keys(cov).filter((m) =>
      Object.values((cov[m] && cov[m].items) || {}).some((it) => it && it.ok === true));
    const untested = ALL_MODULES.filter((m) => !tested.includes(m));

    // PO не плодит баги — выдаёт непокрытые зоны как needs-manual TODO (видно в отчёте, не шумит как дефект).
    const todos = untested.slice(0, 5).map((m) => ({ severity: 'low', module: m, role: 'product-owner',
      title: `Модуль «${m}» ещё не покрыт автотестами`, needsManual: true,
      manualReason: 'Product Owner: предложено создать правила целостности для этого модуля (см. coverage-analysis.json)' }));

    // ПРИЧИНА: на регресс-прогоне PO возвращал ПУСТОЙ результат. Оркестратор трактовал это как
    // «детектор отработал и своих находок больше не видит», и через серию циклов закрывал
    // needs-manual TODO как «исправленные» — хотя модули как были непокрыты, так и остались.
    // Возвращаем те же отметки: пока модуль не покрыт, его долг обязан воспроизводиться.
    if (regression) return { scenarios, bugs: todos, coverage: [] };

    // Подсчёт реальных таблиц в БД — индикатор размера непокрытой поверхности.
    // ПРИЧИНА: было `.catch(() => [{ n: 0 }])` — недоступная БД записывалась в отчёт как ФАКТ
    // «в схеме 0 таблиц», то есть выдумка выдавалась за измерение. Теперь неизвестное = null.
    const tables = await counted(q(`SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public'`));
    if (!tables.ok) skipped(coverage, bugs, 'meta', 'db-tables-count',
      'не удалось посчитать таблицы схемы: ' + tables.err, { role: 'product-owner' });
    const tableCount = tables.ok ? tables.n : null;
    const checksTotal = Object.values(cov).reduce((a, m) => a + Object.keys(m.items || {}).length, 0);

    // Генерация новых сценариев для непокрытых модулей (TODO-лист для будущих агентов).
    const newScenarios = untested.map((m) => ({ module: m, suggestion: `Создать read-only правила целостности для модуля «${m}»`, priority: 'medium' }));

    const analysis = {
      at: new Date().toISOString(),
      modulesTested: tested.length, modulesTotal: ALL_MODULES.length,
      coveragePct: Math.round(tested.length / ALL_MODULES.length * 100),
      checksTotal, dbTables: tableCount, dbTablesError: tables.ok ? null : tables.err,
      untestedModules: untested,
      openBugs: reg.openBugs().length, manualBugs: reg.manualBugs().length,
      newScenariosProposed: newScenarios,
      note: 'Покрытие растёт добавлением правил/агентов. Деструктивная половина (load/security-active/role-write/UI) ждёт изолированный staging.',
    };
    fs.writeFileSync(path.join(cfg.dataDir, 'coverage-analysis.json'), JSON.stringify(analysis, null, 2));

    // ПРИЧИНА: отметка ставилась безусловным true — анализ считался выполненным даже когда
    // считать было нечего: БД недоступна, реестр покрытия пуст. Пустые входные данные давали
    // зелёный пункт в отчёте. Теперь анализ засчитывается, только если он на чём-то основан.
    const analysisOk = tables.ok && tested.length > 0;
    coverage.push(['meta', 'coverage-analysis', analysisOk]);
    if (!analysisOk) skipped(coverage, bugs, 'meta', 'coverage-analysis',
      tables.ok ? 'реестр покрытия пуст — ни один модуль не имеет успешно выполненных проверок, анализировать нечего'
                : 'БД недоступна — размер непокрытой поверхности неизвестен, анализ неполон',
      { role: 'product-owner' });

    return { scenarios, bugs: [...todos, ...bugs], coverage };
  },
};
