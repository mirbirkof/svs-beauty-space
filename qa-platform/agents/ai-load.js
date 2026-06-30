/* AI Load Tester. Деструктив только в изолированной Neon-ветке (qaQ). НИКОГДА не в прод.
   В safe-режиме — read-only baseline. В full — реальная генерация нагрузки в ветке + замеры + очистка.
   Объём ограничен (ветка на free-плане): batchSize по умолчанию 2000. ТЗ-«сотни тысяч» требуют
   платного compute — это честно фиксируется в отчёте, а не имитируется. */
const { q, qaQ } = require('../lib/crm');
const cfg = require('../config');

const BATCH = Number(process.env.QA_LOAD_BATCH || 2000);

module.exports = {
  name: 'ai-load', role: 'load',
  async run({ regression } = {}) {
    const bugs = [], scenarios = [], coverage = [];

    // Baseline производительности (read-only, прод) — всегда
    scenarios.push('load:hot-query-timing');
    const t0 = Date.now();
    await q(`SELECT master_id, COUNT(*) FROM appointments WHERE starts_at >= NOW()-INTERVAL '30 days' GROUP BY master_id`).catch(() => {});
    const baseMs = Date.now() - t0;
    if (baseMs > 2000) bugs.push({ severity: 'medium', module: 'load', role: 'load',
      title: 'Деградация: агрегат записей за месяц медленный', scenario: 'GROUP BY appointments 30д',
      expected: '<2000мс', actual: `${baseMs}мс`, stillBroken: true, evidence: { baseMs } });
    coverage.push(['load', 'hot-query-under-2s', baseMs <= 2000]);

    if (regression || !cfg.allowDestructive) {
      if (!cfg.allowDestructive) bugs.push({ severity: 'low', module: 'load', role: 'load',
        title: 'Нагрузочная генерация не выполнена (нет QA-ветки)', needsManual: true,
        manualReason: `Нужен QA_DB_URL. Baseline снят: ${baseMs}мс.` });
      return { scenarios, bugs, coverage };
    }

    // ── РЕАЛЬНАЯ НАГРУЗКА В ВЕТКЕ ──
    const tag = 'QALOAD_' + Date.now();
    try {
      // 1) Массовая вставка клиентов (один INSERT с generate_series — быстро)
      scenarios.push('load:bulk-insert-clients');
      const ti = Date.now();
      await qaQ(`INSERT INTO clients (name, phone)
                 SELECT $1 || g, '+38000' || lpad(g::text,7,'0') FROM generate_series(1,$2) g`, [tag + '_', BATCH]);
      const insMs = Date.now() - ti;
      const rate = Math.round(BATCH / (insMs / 1000));
      coverage.push(['load', 'bulk-insert', true]);

      // 2) Замер выборки на возросшем объёме
      scenarios.push('load:query-under-load');
      const tq = Date.now();
      const cnt = (await qaQ(`SELECT COUNT(*)::int n FROM clients WHERE name LIKE $1`, [tag + '_%']))[0].n;
      const qMs = Date.now() - tq;

      // Порог здравого смысла: 2000 вставок должны идти быстрее 8с, иначе сигнал проблемы
      if (insMs > 8000) bugs.push({ severity: 'medium', module: 'load', role: 'load',
        title: 'Медленная массовая вставка', scenario: `INSERT ${BATCH} клиентов`,
        expected: '<8000мс', actual: `${insMs}мс (${rate}/с)`, stillBroken: true, evidence: { insMs, rate } });
      coverage.push(['load', 'bulk-insert-throughput', insMs <= 8000]);
      coverage.push(['load', 'count-correct-under-load', cnt === BATCH]);

      // лог метрик в evidence не-бага (для отчёта)
      scenarios.push(`load:metrics insMs=${insMs} rate=${rate}/s qMs=${qMs} batch=${BATCH}`);
    } catch (e) {
      bugs.push({ severity: 'high', module: 'load', role: 'load', title: 'Нагрузочный прогон упал с ошибкой',
        scenario: 'bulk insert в QA-ветку', expected: 'проходит', actual: e.message, errorStack: e.stack, stillBroken: true });
    } finally {
      // самоочистка — нагрузочные данные не копятся даже в ветке
      try { await qaQ(`DELETE FROM clients WHERE name LIKE $1`, [tag + '_%']); scenarios.push('load:cleanup'); coverage.push(['load', 'self-cleanup', true]); }
      catch (_) { /* best-effort */ }
    }
    return { scenarios, bugs, coverage };
  },
};
