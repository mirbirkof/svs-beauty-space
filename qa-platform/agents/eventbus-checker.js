/* AI Regression — проверка Event Bus.
   По ТЗ: событие создано → доставлено → подписчики сработали → без ошибок.
   Проверяем журнал domain_events: непойманные/упавшие обработчики. Read-only. */
const { q } = require('../lib/crm');
// ПРИЧИНА: раньше сбой запроса подменялся пустым списком / нулём — упавшая шина событий
// выглядела в отчёте как «ошибок нет, зависших нет». Теперь несостоявшаяся проверка
// помечается «не проверено» и требует ручного разбора.
const { counted, attempt, record } = require('../lib/check');

module.exports = {
  name: 'eventbus-checker', role: 'system',
  async run() {
    const bugs = [], scenarios = [], coverage = [];
    const has = await q(`SELECT to_regclass('public.domain_events') t`);
    if (!has[0].t) { return { scenarios: ['eventbus:absent'], bugs: [{ severity: 'low', module: 'eventbus', role: 'system', title: 'Таблица domain_events отсутствует', needsManual: true, manualReason: 'event bus не развёрнут' }], coverage: [['eventbus', 'table-exists', false]] }; }

    // События с упавшими обработчиками за сутки
    scenarios.push('eventbus:failed-handlers');
    // Здесь результат — список строк, а не счётчик: успехом считаем пустой список,
    // но только если запрос реально отработал (пустота из-за сбоя больше не «ок»).
    const failedRes = await attempt(() => q(`SELECT event_type, COUNT(*)::int n FROM domain_events WHERE status='failed' AND created_at >= NOW()-INTERVAL '24 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 20`));
    const failed = failedRes.value || [];
    if (record(coverage, bugs, 'eventbus', 'no-failed-handlers', failedRes, { role: 'system', passed: failed.length === 0 }) && failed.length) {
      bugs.push({ severity: 'high', module: 'eventbus', role: 'system', title: 'События с упавшими обработчиками за 24ч',
        scenario: 'domain_events.status=failed', expected: '0 failed', actual: `${failed.reduce((a, r) => a + r.n, 0)} событий упало`,
        sql: "SELECT ... WHERE status='failed'", stillBroken: true, evidence: failed });
    }

    // Зависшие необработанные события (created, но не handled) старше 10 минут
    scenarios.push('eventbus:stuck-pending');
    const stuck = await counted(q(`SELECT COUNT(*)::int n FROM domain_events WHERE status NOT IN ('handled','failed') AND created_at < NOW()-INTERVAL '10 minutes' AND created_at >= NOW()-INTERVAL '24 hours'`));
    if (record(coverage, bugs, 'eventbus', 'no-stuck-events', stuck, { role: 'system' }) && stuck.n > 0) {
      bugs.push({ severity: 'medium', module: 'eventbus', role: 'system', title: 'Зависшие необработанные события',
        scenario: 'domain_events не обработаны >10 мин', expected: '0', actual: `${stuck.n} зависших`, evidence: { count: stuck.n } });
    }

    return { scenarios, bugs, coverage };
  },
};
