/* AI Client — путь клиента: онлайн-запись, подтверждение, история. Read-only целостность. */
const { q } = require('../lib/crm');

module.exports = {
  name: 'ai-client', role: 'client',
  async run() {
    const bugs = [], scenarios = [], coverage = [];

    // 1) Подтверждённые визиты, которые давно в прошлом и не закрыты (зависли)
    // BeautyPro штатно держит визиты в 'confirmed' даже после оплаты (оплата отдельно в /sales) —
    // система учитывает 'confirmed+synced' как проведённый. Поэтому BP-синканные НЕ флагуем,
    // только закрытые-через-наш-UI зависшие confirmed (real_synced_at IS NULL).
    scenarios.push('client:stuck-confirmed');
    const stuck = await q(`SELECT COUNT(*)::int n FROM appointments WHERE status='confirmed' AND starts_at < NOW()-INTERVAL '2 days' AND real_synced_at IS NULL AND bp_state IS NULL`).catch(() => [{ n: 0 }]);
    if (stuck[0].n > 0) bugs.push({ severity: 'low', module: 'client', role: 'client',
      title: 'Подтверждённые визиты «зависли» в прошлом (не закрыты и не отменены)',
      scenario: 'status=confirmed, starts_at >2 дней назад', expected: 'визит закрыт/отменён', actual: `${stuck[0].n} зависших`, stillBroken: true, evidence: { count: stuck[0].n } });
    coverage.push(['client', 'no-stuck-confirmed', stuck[0].n === 0]);

    // 2) Будущие визиты на удалённого/неактивного клиента
    scenarios.push('client:future-on-deleted');
    const ghost = await q(`SELECT COUNT(*)::int n FROM appointments a WHERE a.starts_at >= NOW() AND a.status NOT IN ('cancelled','noshow') AND a.client_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM clients c WHERE c.id=a.client_id)`).catch(() => [{ n: 0 }]);
    if (ghost[0].n > 0) bugs.push({ severity: 'medium', module: 'client', role: 'client',
      title: 'Будущие записи на несуществующего клиента', scenario: 'future appt → client_id отсутствует',
      expected: '0', actual: `${ghost[0].n}`, stillBroken: true, evidence: { count: ghost[0].n } });
    coverage.push(['client', 'future-client-exists', ghost[0].n === 0]);

    // 3) Дубли телефонов клиентов (один человек — две карточки, ломает историю)
    scenarios.push('client:dup-phones');
    const dup = await q(`SELECT COUNT(*)::int n FROM (SELECT phone FROM clients WHERE phone IS NOT NULL AND phone<>'' GROUP BY phone HAVING COUNT(*)>1) x`).catch(() => [{ n: 0 }]);
    if (dup[0].n > 0) bugs.push({ severity: 'low', module: 'client', role: 'client',
      title: 'Дублирующиеся клиенты по телефону (история визитов раздваивается)',
      scenario: 'один телефон → несколько карточек', expected: '0 дублей', actual: `${dup[0].n} телефонов с дублями`, stillBroken: true, evidence: { count: dup[0].n } });
    coverage.push(['client', 'no-duplicate-phones', dup[0].n === 0]);

    return { scenarios, bugs, coverage };
  },
};
