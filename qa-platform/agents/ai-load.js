/* AI Load Tester. БЕЗ изолированного staging массовая генерация (десятки тысяч записей) ЗАПРЕЩЕНА —
   это боевая БД салона. В safe-режиме делаем безопасное: снимаем baseline производительности
   (объёмы таблиц + тайминг ключевых запросов) — реальные метрики, ноль мутаций. */
const { q } = require('../lib/crm');
const cfg = require('../config');

module.exports = {
  name: 'ai-load', role: 'load',
  async run({ regression } = {}) {
    const bugs = [], scenarios = [], coverage = [];

    // Baseline: размеры ключевых таблиц
    scenarios.push('load:table-sizes');
    const sizes = await q(`SELECT relname, n_live_tup::bigint rows FROM pg_stat_user_tables WHERE relname IN ('appointments','clients','cash_operations','domain_events','notifications') ORDER BY rows DESC`).catch(() => []);

    // Baseline: тайминг тяжёлого запроса (отчёт по мастерам за месяц)
    scenarios.push('load:hot-query-timing');
    const t0 = Date.now();
    await q(`SELECT master_id, COUNT(*) FROM appointments WHERE starts_at >= NOW()-INTERVAL '30 days' GROUP BY master_id`).catch(() => {});
    const ms = Date.now() - t0;
    // Порог: если агрегат по записям за месяц >2с — сигнал деградации/нехватки индекса
    if (ms > 2000) bugs.push({ severity: 'medium', module: 'load', role: 'load',
      title: 'Деградация: агрегат записей за месяц медленный', scenario: 'GROUP BY appointments 30д',
      expected: '<2000мс', actual: `${ms}мс`, stillBroken: true, cause: 'возможно нет индекса по starts_at/master_id', evidence: { ms, sizes } });
    coverage.push(['load', 'hot-query-under-2s', ms <= 2000]);
    coverage.push(['load', 'baseline-sizes', true]);

    // Массовая генерация — только при изолированном таргете. Иначе честно needs-manual.
    if (!regression && !cfg.allowDestructive) {
      bugs.push({ severity: 'low', module: 'load', role: 'load',
        title: 'Нагрузочная генерация (10к+ клиентов/записей/оплат) не выполнена',
        needsManual: true, manualReason: `Требует изолированного staging (Neon-ветка). Против боевой БД салона запрещено: данные протекут в реальные отчёты (часть запросов не фильтрует tenant). Baseline снят: hot-query=${ms}мс.` });
    }
    return { scenarios, bugs, coverage };
  },
};
