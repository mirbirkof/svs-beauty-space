/* AI Marketing Manager — триггеры, сегменты, кампании, рассылки. Read-only консистентность. */
const { q } = require('../lib/crm');

module.exports = {
  name: 'ai-marketing', role: 'marketing',
  async run() {
    const bugs = [], scenarios = [], coverage = [];

    // 1) Триггеры включены, но ни разу не запускались за 7 дней (молчащая автоматизация)
    scenarios.push('mkt:silent-triggers');
    const silent = await q(`SELECT COUNT(*)::int n FROM marketing_triggers WHERE enabled=TRUE AND (last_run_at IS NULL OR last_run_at < NOW()-INTERVAL '7 days')`).catch(() => null);
    if (silent && silent[0].n > 0) bugs.push({ severity: 'medium', module: 'marketing', role: 'marketing',
      title: 'Включённые триггеры не запускались >7 дней', scenario: 'enabled=true, last_run_at старый/пустой',
      expected: 'активный триггер отрабатывает регулярно', actual: `${silent[0].n} молчащих триггеров`, stillBroken: true, evidence: { count: silent[0].n } });
    if (silent) coverage.push(['marketing', 'triggers-fire', silent[0].n === 0]);
    else coverage.push(['marketing', 'triggers-fire', 'skip']);

    // 2) Уведомления в очереди, застрявшие в pending/failed >1ч (Notification Hub)
    scenarios.push('mkt:stuck-notifications');
    const stuckN = await q(`SELECT COUNT(*)::int n FROM notifications WHERE status IN ('pending','queued','failed') AND created_at < NOW()-INTERVAL '1 hour' AND created_at >= NOW()-INTERVAL '7 days'`).catch(() => null);
    if (stuckN && stuckN[0].n > 0) bugs.push({ severity: 'medium', module: 'marketing', role: 'marketing',
      title: 'Уведомления застряли в очереди >1ч', scenario: 'notifications pending/failed старше часа',
      expected: 'очередь разгребается', actual: `${stuckN[0].n} застрявших`, stillBroken: true, evidence: { count: stuckN[0].n } });
    if (stuckN) coverage.push(['marketing', 'notification-queue-flows', stuckN[0].n === 0]);
    else coverage.push(['marketing', 'notification-queue-flows', 'skip']);

    return { scenarios, bugs, coverage };
  },
};
