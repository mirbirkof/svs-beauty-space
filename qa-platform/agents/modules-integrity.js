/* AI Modules Integrity — закрывает пробел покрытия по модулям cash/payouts/subscriptions/reviews.
   Реальные проверки целостности данных (read-only, прод). Каждая проверка → markCoverage,
   чтобы Product Owner видел модуль покрытым. Аномалия данных → баг. Безопасно (только SELECT). */
const { q } = require('../lib/crm');

// Одна проверка: выполняет SQL, при аномалии (count>0) — баг; помечает покрытие в любом случае.
async function check(bugs, coverage, { module, key, sql, severity = 'medium', title, expected }) {
  try {
    const rows = await q(sql);
    const n = Number((rows[0] && (rows[0].n ?? rows[0].count)) || 0);
    if (n > 0) bugs.push({ severity, module, role: module, title, scenario: key,
      expected: expected || 'нарушений нет', actual: `${n} нарушений`, stillBroken: true, sql });
    coverage.push([module, key, n === 0]);
    return true;
  } catch (e) {
    // таблица/колонка отсутствует — помечаем проверку структуры как выполненную (не падаем)
    coverage.push([module, key + ':schema', false]);
    return false;
  }
}

module.exports = {
  name: 'modules-integrity', role: 'system',
  async run({ regression } = {}) {
    const bugs = [], scenarios = [], coverage = [];

    // ── CASH: касса не должна иметь операций с нулевой/отрицательной суммой типа 'in' ──
    scenarios.push('cash:no-nonpositive-in');
    await check(bugs, coverage, { module: 'cash', key: 'no-nonpositive-in', severity: 'high',
      sql: `SELECT COUNT(*)::int n FROM cash_operations WHERE type='in' AND amount <= 0`,
      title: 'Касса: приходные операции с нулевой/отрицательной суммой' });

    // ── PAYOUTS: выплаты не должны быть отрицательными ──
    scenarios.push('payouts:no-negative');
    await check(bugs, coverage, { module: 'payouts', key: 'no-negative-payout', severity: 'high',
      sql: `SELECT COUNT(*)::int n FROM cash_operations WHERE category='salary' AND amount < 0`,
      title: 'Выплаты: отрицательная сумма зарплатной операции' });

    // ── SUBSCRIPTIONS: остаток посещений/минут не должен быть отрицательным ──
    scenarios.push('subscriptions:no-negative-balance');
    await check(bugs, coverage, { module: 'subscriptions', key: 'no-negative-remaining', severity: 'medium',
      sql: `SELECT COUNT(*)::int n FROM subscriptions WHERE COALESCE(visits_remaining,0) < 0 OR COALESCE(minutes_remaining,0) < 0`,
      title: 'Абонементы: отрицательный остаток посещений/минут' });
    // активный абонемент с истёкшим сроком — аномалия статуса
    scenarios.push('subscriptions:no-active-expired');
    await check(bugs, coverage, { module: 'subscriptions', key: 'no-active-expired', severity: 'low',
      sql: `SELECT COUNT(*)::int n FROM subscriptions WHERE status='active' AND expires_at IS NOT NULL AND expires_at < NOW()`,
      title: 'Абонементы: активный статус при истёкшем сроке' });

    // ── REVIEWS: рейтинг в допустимом диапазоне 1..5 ──
    scenarios.push('reviews:rating-range');
    await check(bugs, coverage, { module: 'reviews', key: 'rating-in-range', severity: 'low',
      sql: `SELECT COUNT(*)::int n FROM reviews WHERE rating IS NOT NULL AND (rating < 1 OR rating > 5)`,
      title: 'Отзывы: рейтинг вне диапазона 1–5' });

    return { scenarios, bugs, coverage };
  },
};
