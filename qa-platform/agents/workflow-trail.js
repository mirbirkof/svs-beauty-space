/* AI Regression (workflow + event bus) — проверка, что бизнес-действия порождают события.
   По ТЗ: «после каждого действия автоматически запускаются все необходимые события».
   Берём реальные завершённые/неявки визиты и убеждаемся, что событие в domain_events есть.
   Read-only, безопасно. Не мутирует — только сверяет факты постфактум. */
const { q } = require('../lib/crm');
// ПРИЧИНА: раньше сбой SQL подменялся нулём (.catch(() => [{ n: 0 }])), а отсутствие таблицы
// domain_events вообще обрывало агент молча — в обоих случаях отчёт показывал, что события
// эмитятся исправно. Непроверенное больше не считается пройденным.
const { counted, record, skipped } = require('../lib/check');

module.exports = {
  name: 'workflow-trail', role: 'regression',
  async run() {
    const bugs = [], scenarios = [], coverage = [];
    const has = await q(`SELECT to_regclass('public.domain_events') t`);
    if (!has[0].t) {
      // Без таблицы событий ни одна из трёх проверок ниже не выполняется. Раньше агент
      // возвращал пустоту, и эти ключи просто исчезали из отчёта — выглядело как «претензий нет».
      // Теперь каждый пропущенный ключ виден отдельной строкой покрытия и находкой.
      const reason = 'таблица domain_events отсутствует — шина событий не проверена';
      skipped(coverage, bugs, 'workflow', 'completed-emits-event', reason, { role: 'system' });
      skipped(coverage, bugs, 'workflow', 'noshow-emits-event', reason, { role: 'system' });
      skipped(coverage, bugs, 'beauty', 'consent-expiry-consistency', reason, { role: 'master' });
      coverage.push(['eventbus', 'present', false]);
      return { scenarios: ['workflow:no-eventbus'], bugs, coverage };
    }

    // 1) Завершённые визиты за 24ч → должно быть событие appointment.completed
    scenarios.push('workflow:completed-emits-event');
    // ВАЖНО: исключаем визиты, закрытые синком BeautyPro (real_synced_at/legacy_state) — они исторические
    // и НЕ должны эмитить наши события. Флагаем только закрытые через наш UI/endpoint.
    const compGap = await counted(q(`
      SELECT COUNT(*)::int n FROM appointments a
      WHERE a.status IN ('done','completed') AND a.updated_at >= NOW()-INTERVAL '24 hours'
        AND a.real_synced_at IS NULL AND a.legacy_state IS NULL
        AND NOT EXISTS (SELECT 1 FROM domain_events e WHERE e.event_type='appointment.completed' AND e.entity_id = a.id::text)
    `));
    if (record(coverage, bugs, 'workflow', 'completed-emits-event', compGap, { role: 'system' }) && compGap.n > 0) {
      bugs.push({ severity: 'high', module: 'workflow', role: 'system',
        title: 'Завершённые визиты без события appointment.completed',
        scenario: 'Закрытие визита должно эмитить appointment.completed',
        expected: 'у каждого done-визита есть событие', actual: `${compGap.n} визитов без события`,
        cause: 'Закрытие визита не проходит через event-bus → подписчики (начисления, лояльность) не сработали',
        sql: 'appointments done без domain_events appointment.completed', stillBroken: true, evidence: { gap: compGap.n } });
    }

    // 2) Неявки за 48ч → должно быть событие appointment.noshow (база для авто-задачи админу)
    scenarios.push('workflow:noshow-emits-event');
    const nsGap = await counted(q(`
      SELECT COUNT(*)::int n FROM appointments a
      WHERE a.status='noshow' AND a.updated_at >= NOW()-INTERVAL '48 hours'
        AND a.real_synced_at IS NULL AND a.legacy_state IS NULL
        AND NOT EXISTS (SELECT 1 FROM domain_events e WHERE e.event_type='appointment.noshow' AND e.entity_id = a.id::text)
    `));
    if (record(coverage, bugs, 'workflow', 'noshow-emits-event', nsGap, { role: 'system' }) && nsGap.n > 0) {
      bugs.push({ severity: 'medium', module: 'workflow', role: 'system',
        title: 'Неявки без события appointment.noshow',
        scenario: 'Неявка должна эмитить событие → авто-задача администратору',
        expected: 'у каждой noshow есть событие', actual: `${nsGap.n} неявок без события`, stillBroken: true, evidence: { gap: nsGap.n } });
    }

    // 3) Beauty: активные согласия с истёкшим сроком (статус не пересчитан)
    scenarios.push('workflow:consent-expiry');
    const consentStale = await counted(q(`SELECT COUNT(*)::int n FROM procedure_consents WHERE status='active' AND valid_until IS NOT NULL AND valid_until < NOW()`));
    if (record(coverage, bugs, 'beauty', 'consent-expiry-consistency', consentStale, { role: 'master' }) && consentStale.n > 0) {
      bugs.push({ severity: 'low', module: 'beauty', role: 'master',
        title: 'Согласия активны, но срок истёк (статус не обновлён)',
        scenario: 'procedure_consents.status=active при valid_until в прошлом',
        expected: 'просроченные → expired', actual: `${consentStale.n} просроченных активных`, stillBroken: true, evidence: { count: consentStale.n } });
    }

    return { scenarios, bugs, coverage };
  },
};
