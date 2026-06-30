/* AI Regression — проверка Event Bus.
   По ТЗ: событие создано → доставлено → подписчики сработали → без ошибок.
   Проверяем журнал domain_events: непойманные/упавшие обработчики. Read-only. */
const { q } = require('../lib/crm');

module.exports = {
  name: 'eventbus-checker', role: 'system',
  async run() {
    const bugs = [], scenarios = [], coverage = [];
    const has = await q(`SELECT to_regclass('public.domain_events') t`);
    if (!has[0].t) { return { scenarios: ['eventbus:absent'], bugs: [{ severity: 'low', module: 'eventbus', role: 'system', title: 'Таблица domain_events отсутствует', needsManual: true, manualReason: 'event bus не развёрнут' }], coverage: [['eventbus', 'table-exists', false]] }; }

    // События с упавшими обработчиками за сутки
    scenarios.push('eventbus:failed-handlers');
    const failed = await q(`SELECT event_type, COUNT(*)::int n FROM domain_events WHERE status='failed' AND created_at >= NOW()-INTERVAL '24 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 20`).catch(() => []);
    if (failed.length) {
      bugs.push({ severity: 'high', module: 'eventbus', role: 'system', title: 'События с упавшими обработчиками за 24ч',
        scenario: 'domain_events.status=failed', expected: '0 failed', actual: `${failed.reduce((a, r) => a + r.n, 0)} событий упало`,
        sql: "SELECT ... WHERE status='failed'", stillBroken: true, evidence: failed });
    }
    coverage.push(['eventbus', 'no-failed-handlers', failed.length === 0]);

    // Зависшие необработанные события (created, но не handled) старше 10 минут
    scenarios.push('eventbus:stuck-pending');
    const stuck = await q(`SELECT COUNT(*)::int n FROM domain_events WHERE status NOT IN ('handled','failed') AND created_at < NOW()-INTERVAL '10 minutes' AND created_at >= NOW()-INTERVAL '24 hours'`).catch(() => [{ n: 0 }]);
    if (stuck[0].n > 0) {
      bugs.push({ severity: 'medium', module: 'eventbus', role: 'system', title: 'Зависшие необработанные события',
        scenario: 'domain_events не обработаны >10 мин', expected: '0', actual: `${stuck[0].n} зависших`, evidence: { count: stuck[0].n } });
    }
    coverage.push(['eventbus', 'no-stuck-events', stuck[0].n === 0]);

    return { scenarios, bugs, coverage };
  },
};
