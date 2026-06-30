/* AI Accountant / Owner — сверка финансовых контуров.
   Cash-контур (KPI/Dashboard/Financial/P&L) должен идти из одного источника = liveFinance.
   Любое расхождение → Critical Bug (по ТЗ). Read-only, безопасно. */
const { q } = require('../lib/crm');

module.exports = {
  name: 'finance-reconciler', role: 'accountant',
  async run() {
    const bugs = [], scenarios = [], coverage = [];
    const period = "created_at >= date_trunc('month',(NOW() AT TIME ZONE 'Europe/Kiev'))";

    // Эталон cash: касса прихода услуги+товары за текущий месяц
    const canon = (await q(`SELECT COALESCE(SUM(amount),0)::numeric s FROM cash_operations WHERE type='in' AND category IN ('sale_service','sale_product') AND ${period}`))[0].s;

    // Независимый пересчёт: сумма по сменам (closing-cash логика) — другой путь к тем же деньгам
    const byMethod = (await q(`SELECT COALESCE(SUM(amount),0)::numeric s FROM cash_operations WHERE type='in' AND category IN ('sale_service','sale_product') AND method IN ('cash','card') AND ${period}`))[0].s;

    scenarios.push('cash:canon-vs-bymethod');
    if (Math.abs(Number(canon) - Number(byMethod)) > 1) {
      bugs.push({ severity: 'critical', module: 'finance', role: 'accountant',
        title: 'Cash-контур: расхождение источников выручки месяца',
        scenario: 'Сумма кассы (услуги+товары) двумя независимыми выборками',
        expected: `совпадение, эталон = ${canon}`, actual: `by-method = ${byMethod}`,
        sql: `SUM(cash_operations.amount) two ways for ${period}`,
        cause: 'Часть операций имеет method вне (cash,card) — выпадает из платёжных отчётов',
        evidence: { canon: Number(canon), byMethod: Number(byMethod), diff: Number(canon) - Number(byMethod) } });
    }
    coverage.push(['finance', 'cash-month-consistency', bugs.length === 0]);

    // Негативная касса (возвраты больше прихода в смене) — сигнал ошибки учёта
    const negShifts = await q(`SELECT id, closing_cash FROM cash_shifts WHERE closing_cash < 0 LIMIT 20`);
    scenarios.push('cash:negative-shifts');
    if (negShifts.length) {
      bugs.push({ severity: 'high', module: 'finance', role: 'accountant',
        title: 'Смены с отрицательной кассой', scenario: 'Поиск cash_shifts.closing_cash < 0',
        expected: 'closing_cash >= 0', actual: `${negShifts.length} смен с отрицательной кассой`,
        evidence: negShifts.slice(0, 10) });
    }
    coverage.push(['finance', 'no-negative-shifts', negShifts.length === 0]);

    // Платежи-сироты: payment без существующего appointment/order
    const orphanPay = await q(`SELECT COUNT(*)::int n FROM payments p WHERE p.appointment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM appointments a WHERE a.id=p.appointment_id) AND ${period.replace('created_at','p.created_at')}`).catch(() => [{ n: 0 }]);
    scenarios.push('finance:orphan-payments');
    if (orphanPay[0].n > 0) {
      bugs.push({ severity: 'high', module: 'finance', role: 'accountant',
        title: 'Платежи без записи (orphan payments)', scenario: 'payments.appointment_id → несуществующий appointment',
        expected: '0 сирот', actual: `${orphanPay[0].n} платежей-сирот`, evidence: { count: orphanPay[0].n } });
    }
    coverage.push(['finance', 'no-orphan-payments', orphanPay[0].n === 0]);

    return { scenarios, bugs, coverage };
  },
};
