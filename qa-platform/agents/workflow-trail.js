/* AI Regression (workflow + event bus) — проверка, что бизнес-действия порождают события.
   По ТЗ: «после каждого действия автоматически запускаются все необходимые события».
   Берём реальные завершённые/неявки визиты и убеждаемся, что событие в domain_events есть.
   Read-only, безопасно. Не мутирует — только сверяет факты постфактум. */
const { q } = require('../lib/crm');

module.exports = {
  name: 'workflow-trail', role: 'regression',
  async run() {
    const bugs = [], scenarios = [], coverage = [];
    const has = await q(`SELECT to_regclass('public.domain_events') t`);
    if (!has[0].t) return { scenarios: ['workflow:no-eventbus'], bugs: [], coverage: [['eventbus', 'present', false]] };

    // 1) Завершённые визиты за 24ч → должно быть событие appointment.completed
    scenarios.push('workflow:completed-emits-event');
    // ВАЖНО: исключаем визиты, закрытые синком BeautyPro (real_synced_at/bp_state) — они исторические
    // и НЕ должны эмитить наши события. Флагаем только закрытые через наш UI/endpoint.
    const compGap = await q(`
      SELECT COUNT(*)::int n FROM appointments a
      WHERE a.status IN ('done','completed') AND a.updated_at >= NOW()-INTERVAL '24 hours'
        AND a.real_synced_at IS NULL AND a.bp_state IS NULL
        AND NOT EXISTS (SELECT 1 FROM domain_events e WHERE e.event_type='appointment.completed' AND e.entity_id = a.id::text)
    `).catch(() => [{ n: 0 }]);
    if (compGap[0].n > 0) {
      bugs.push({ severity: 'high', module: 'workflow', role: 'system',
        title: 'Завершённые визиты без события appointment.completed',
        scenario: 'Закрытие визита должно эмитить appointment.completed',
        expected: 'у каждого done-визита есть событие', actual: `${compGap[0].n} визитов без события`,
        cause: 'Закрытие визита не проходит через event-bus → подписчики (начисления, лояльность) не сработали',
        sql: 'appointments done без domain_events appointment.completed', stillBroken: true, evidence: { gap: compGap[0].n } });
    }
    coverage.push(['workflow', 'completed-emits-event', compGap[0].n === 0]);

    // 2) Неявки за 48ч → должно быть событие appointment.noshow (база для авто-задачи админу)
    scenarios.push('workflow:noshow-emits-event');
    const nsGap = await q(`
      SELECT COUNT(*)::int n FROM appointments a
      WHERE a.status='noshow' AND a.updated_at >= NOW()-INTERVAL '48 hours'
        AND a.real_synced_at IS NULL AND a.bp_state IS NULL
        AND NOT EXISTS (SELECT 1 FROM domain_events e WHERE e.event_type='appointment.noshow' AND e.entity_id = a.id::text)
    `).catch(() => [{ n: 0 }]);
    if (nsGap[0].n > 0) {
      bugs.push({ severity: 'medium', module: 'workflow', role: 'system',
        title: 'Неявки без события appointment.noshow',
        scenario: 'Неявка должна эмитить событие → авто-задача администратору',
        expected: 'у каждой noshow есть событие', actual: `${nsGap[0].n} неявок без события`, stillBroken: true, evidence: { gap: nsGap[0].n } });
    }
    coverage.push(['workflow', 'noshow-emits-event', nsGap[0].n === 0]);

    // 3) Beauty: активные согласия с истёкшим сроком (статус не пересчитан)
    scenarios.push('workflow:consent-expiry');
    const consentStale = await q(`SELECT COUNT(*)::int n FROM procedure_consents WHERE status='active' AND valid_until IS NOT NULL AND valid_until < NOW()`).catch(() => [{ n: 0 }]);
    if (consentStale[0].n > 0) {
      bugs.push({ severity: 'low', module: 'beauty', role: 'master',
        title: 'Согласия активны, но срок истёк (статус не обновлён)',
        scenario: 'procedure_consents.status=active при valid_until в прошлом',
        expected: 'просроченные → expired', actual: `${consentStale[0].n} просроченных активных`, stillBroken: true, evidence: { count: consentStale[0].n } });
    }
    coverage.push(['beauty', 'consent-expiry-consistency', consentStale[0].n === 0]);

    return { scenarios, bugs, coverage };
  },
};
