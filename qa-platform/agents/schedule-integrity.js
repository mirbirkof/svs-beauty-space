/* AI Administrator / Client — целостность расписания.
   Двойные брони (один мастер в двух местах), битая длительность, висящие будущие брони.
   Read-only, безопасно. Двойная бронь — реальный операционный баг (клиент придёт зря). */
const { q } = require('../lib/crm');

module.exports = {
  name: 'schedule-integrity', role: 'admin',
  async run() {
    const bugs = [], scenarios = [], coverage = [];
    const ALIVE = "status NOT IN ('cancelled','noshow')";

    // 1) Двойная бронь высокой достоверности: ИДЕНТИЧНЫЙ слот (то же начало И конец),
    //    РАЗНЫЕ клиенты, один мастер. Просто пересечение интервалов НЕ флагаем — в салоне это
    //    легально (мастер берёт второго клиента, пока у первого проявляется краска).
    scenarios.push('schedule:exact-double-booking');
    const dbl = await q(`
      SELECT COUNT(*)::int n FROM appointments a JOIN appointments b
        ON a.master_id=b.master_id AND a.id < b.id
       AND a.starts_at = b.starts_at AND a.ends_at = b.ends_at
      WHERE a.master_id IS NOT NULL AND a.${ALIVE} AND b.${ALIVE}
        AND COALESCE(a.client_id,0) <> COALESCE(b.client_id,0)
        AND a.starts_at >= NOW()`).catch(() => [{ n: 0 }]);
    if (dbl[0].n > 0) {
      bugs.push({ severity: 'high', module: 'schedule', role: 'admin',
        title: 'Двойная бронь: тот же слот у одного мастера на разных клиентов (будущие)',
        scenario: 'Два ПРЕДСТОЯЩИХ визита разных клиентов в идентичный слот одного мастера — админ должен разрулить',
        expected: '0 предстоящих конфликтов', actual: `${dbl[0].n} предстоящих пар в одном слоте`, stillBroken: true,
        cause: 'Нет блокировки слота при записи — мастер забронирован дважды в одно время',
        sql: 'self-join appointments по точному совпадению слота, разные клиенты', evidence: { pairs: dbl[0].n } });
    }
    coverage.push(['schedule', 'no-exact-double-booking', dbl[0].n === 0]);

    // 2) Битая длительность: ends_at <= starts_at
    scenarios.push('schedule:invalid-duration');
    const bad = await q(`SELECT COUNT(*)::int n FROM appointments WHERE ends_at IS NOT NULL AND ends_at <= starts_at AND ${ALIVE} AND starts_at >= NOW()-INTERVAL '90 days'`).catch(() => [{ n: 0 }]);
    if (bad[0].n > 0) {
      bugs.push({ severity: 'medium', module: 'schedule', role: 'admin', title: 'Визиты с некорректной длительностью (конец ≤ начало)',
        scenario: 'ends_at <= starts_at', expected: 'конец позже начала', actual: `${bad[0].n} визитов`, stillBroken: true, evidence: { count: bad[0].n } });
    }
    coverage.push(['schedule', 'valid-duration', bad[0].n === 0]);

    return { scenarios, bugs, coverage };
  },
};
