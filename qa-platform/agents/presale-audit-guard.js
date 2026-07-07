/* Predsale Audit Guard — регрессионный страж фиксов предпродажного аудита (Jarvis, 07.07.2026).
   Кодирует ключевые находки аудита 20 экспертов как постоянные SQL-инварианты.
   Каждое правило — безопасный SELECT, который ДОЛЖЕН вернуть 0. Иначе фикс откатился/регрессия.
   Read-only, безопасно. Ловит: утечки изоляции тенантов, двойное бронирование, дыры в деньгах. */
const { q } = require('../lib/crm');

const RULES = [
  // ── Изоляция тенантов (regression миграций 226/227/229) ──
  { module: 'tenant-isolation', role: 'admin', severity: 'high',
    title: 'Таблица данных салона без tenant_id (утечка между салонами)',
    sql: `SELECT COUNT(*)::int n FROM (VALUES ('client_notes'),('client_preferences'),('financial_snapshots'),
            ('pnl_reports'),('pnl_line_items'),('material_consumption_log'),('payroll_partial_payments'),
            ('dunning_attempts'),('gift_certificate_series'),('room_schedules'),('ai_insights'),
            ('stock_import_docs'),('dwh_dim_clients')) AS t(name)
          WHERE to_regclass('public.'||t.name) IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                            WHERE c.table_name=t.name AND c.column_name='tenant_id')` },
  { module: 'tenant-isolation', role: 'admin', severity: 'high', optional: true,
    title: 'Таблица с tenant_id, но RLS выключен (изоляция не применяется)',
    sql: `SELECT COUNT(*)::int n FROM pg_class cl
           WHERE cl.relname IN ('client_notes','financial_snapshots','material_consumption_log','stock_import_docs')
             AND cl.relkind='r' AND cl.relrowsecurity=false` },

  // ── Двойное бронирование (regression EXCLUDE-констрейнта 228) ──
  { module: 'booking', role: 'admin', severity: 'high', optional: true,
    title: 'Двойное онлайн-бронирование: пересечение confirmed у одного мастера',
    sql: `SELECT COUNT(*)::int n FROM online_bookings a JOIN online_bookings b
            ON a.tenant_id=b.tenant_id AND a.master_id=b.master_id AND a.id<b.id
           AND a.status='confirmed' AND b.status='confirmed'
           AND a.master_id IS NOT NULL AND a.date_to IS NOT NULL AND b.date_to IS NOT NULL
           AND tstzrange(a.date_from,a.date_to) && tstzrange(b.date_from,b.date_to)` },

  // ── Деньги: сертификаты (regression double-spend) ──
  { module: 'certificates', role: 'accountant', severity: 'high', optional: true,
    title: 'Сертификат ушёл в минус (double-spend)',
    sql: `SELECT COUNT(*)::int n FROM gift_certificates WHERE remaining_amount < 0` },

  // ── Деньги: абонементы (regression double-use) ──
  { module: 'loyalty', role: 'accountant', severity: 'high', optional: true,
    title: 'Абонемент ушёл в минус (double-use visits/minutes)',
    sql: `SELECT COUNT(*)::int n FROM subscriptions
           WHERE COALESCE(visits_remaining,0) < 0 OR COALESCE(minutes_remaining,0) < 0` },

  // ── Деньги: зарплата (regression двойного расхода) ──
  { module: 'payroll', role: 'accountant', severity: 'high', optional: true,
    title: 'Двойной расход ЗП: касса salary по расчёту больше начисленного total',
    sql: `SELECT COUNT(*)::int n FROM payroll_records pr
           WHERE pr.status='paid' AND pr.total > 0
             AND (SELECT COALESCE(SUM(amount),0) FROM cash_operations
                  WHERE ref_type IN ('payroll','payroll_partial') AND ref_id=pr.id AND type='out') > pr.total + 0.01` },

  // ── Онлайн-оплата: prepaid без движения кассы (res E2E-рассинхрон) ──
  { module: 'finance', role: 'accountant', severity: 'medium', optional: true,
    title: 'Предоплата отмечена, но нет прихода в кассе (визит «оплачен», денег нет)',
    sql: `SELECT COUNT(*)::int n FROM online_bookings b
           WHERE b.prepaid_at IS NOT NULL AND b.prepaid_amount > 0
             AND NOT EXISTS (SELECT 1 FROM cash_operations o
                             WHERE o.ref_type='online_booking' AND o.ref_id=b.id AND o.type='in')
             AND b.prepaid_at > NOW()-INTERVAL '30 days'` },
];

module.exports = {
  name: 'presale-audit-guard', role: 'regression',
  async run() {
    const bugs = [], scenarios = [], coverage = [];
    for (const r of RULES) {
      scenarios.push(`audit-guard:${r.module}:${r.title}`);
      let n;
      try { n = (await q(r.sql))[0].n; }
      catch (e) {
        if (r.optional) { coverage.push([r.module, r.title, 'skip']); continue; }
        bugs.push({ severity: 'low', module: r.module, role: r.role, title: `Проверку нельзя выполнить: ${r.title}`,
          needsManual: true, manualReason: 'SQL: ' + e.message, scenario: r.title });
        continue;
      }
      if (n > 0) {
        bugs.push({ severity: r.severity, module: r.module, role: r.role, title: r.title,
          scenario: 'Регрессия предпродажного аудита (инвариант ДОЛЖЕН давать 0)',
          expected: '0 нарушений', actual: `${n} нарушений`, sql: r.sql, stillBroken: true,
          evidence: { violations: n } });
      }
      coverage.push([r.module, r.title, n === 0]);
    }
    return { scenarios, bugs, coverage };
  },
};
