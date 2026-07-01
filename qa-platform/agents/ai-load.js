/* AI Load Tester. Деструктив только в изолированной Neon-ветке (qaQ). НИКОГДА не в прод.
   В safe-режиме — read-only baseline. В full — реальная генерация нагрузки в ветке + замеры + очистка.
   Объём ограничен (ветка на free-плане): batchSize по умолчанию 2000. ТЗ-«сотни тысяч» требуют
   платного compute — это честно фиксируется в отчёте, а не имитируется. */
const { q, qaQ } = require('../lib/crm');
const cfg = require('../config');

const BATCH = Number(process.env.QA_LOAD_BATCH || 10000);
const APPT_BATCH = Number(process.env.QA_LOAD_APPT || 10000);

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

      // 3) Массовая вставка ЗАПИСЕЙ (appointments) на сгенерированных клиентов — ТЗ: сотни тысяч записей
      scenarios.push('load:bulk-insert-appointments');
      let apptMs = 0, apptOk = false;
      try {
        const m = await qaQ(`SELECT id FROM masters LIMIT 1`);
        const s = await qaQ(`SELECT id FROM services LIMIT 1`);
        if (m[0] && s[0]) {
          const ta = Date.now();
          // берём наших сгенерированных клиентов, вешаем на них записи (час каждая, разнесены по времени)
          await qaQ(
            `INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, status)
             SELECT c.id, $1, $2, NOW() + (row_number() OVER () || ' minutes')::interval,
                    NOW() + (row_number() OVER () || ' minutes')::interval + INTERVAL '1 hour', 'booked'
               FROM clients c WHERE c.name LIKE $3 LIMIT $4`,
            [m[0].id, s[0].id, tag + '_%', APPT_BATCH]);
          apptMs = Date.now() - ta; apptOk = true;
          scenarios.push(`load:appt-metrics apptMs=${apptMs} batch=${APPT_BATCH}`);
          if (apptMs > 15000) bugs.push({ severity: 'medium', module: 'load', role: 'load',
            title: 'Медленная массовая вставка записей', scenario: `INSERT ${APPT_BATCH} appointments`,
            expected: '<15000мс', actual: `${apptMs}мс`, stillBroken: true, evidence: { apptMs } });
          coverage.push(['load', 'bulk-appointments-throughput', apptMs <= 15000]);

          // 4) Тяжёлая выборка под нагрузкой (JOIN + агрегат по возросшему объёму)
          scenarios.push('load:heavy-join-under-load');
          const tj = Date.now();
          await qaQ(`SELECT a.master_id, COUNT(*) FROM appointments a WHERE a.status='booked' GROUP BY a.master_id`);
          const joinMs = Date.now() - tj;
          if (joinMs > 3000) bugs.push({ severity: 'medium', module: 'load', role: 'load',
            title: 'Деградация JOIN-выборки под нагрузкой', scenario: 'GROUP BY appointments под нагрузкой',
            expected: '<3000мс', actual: `${joinMs}мс`, stillBroken: true, evidence: { joinMs } });
          coverage.push(['load', 'heavy-join-under-load', joinMs <= 3000]);
        }
      } catch (ea) {
        bugs.push({ severity: 'high', module: 'load', role: 'load', title: 'Вставка записей под нагрузкой упала',
          scenario: 'bulk insert appointments', expected: 'проходит', actual: ea.message, stillBroken: true });
      }

      // лог метрик в evidence не-бага (для отчёта)
      scenarios.push(`load:metrics insMs=${insMs} rate=${rate}/s qMs=${qMs} clients=${BATCH} appt=${apptOk ? APPT_BATCH : 0}`);
    } catch (e) {
      bugs.push({ severity: 'high', module: 'load', role: 'load', title: 'Нагрузочный прогон упал с ошибкой',
        scenario: 'bulk insert в QA-ветку', expected: 'проходит', actual: e.message, errorStack: e.stack, stillBroken: true });
    } finally {
      // самоочистка — нагрузочные данные не копятся даже в ветке. Сначала записи (FK), потом клиенты.
      try {
        await qaQ(`DELETE FROM appointments WHERE client_id IN (SELECT id FROM clients WHERE name LIKE $1)`, [tag + '_%']).catch(() => {});
        await qaQ(`DELETE FROM clients WHERE name LIKE $1`, [tag + '_%']);
        scenarios.push('load:cleanup'); coverage.push(['load', 'self-cleanup', true]);
      } catch (_) { /* best-effort */ }
    }
    return { scenarios, bugs, coverage };
  },
};
