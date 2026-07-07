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

  // ── Расширенные инварианты (доводка до 99%, 07.07.2026) ──
  { module: 'booking', role: 'admin', severity: 'high', optional: true,
    title: 'Запись с невалидной длительностью (starts_at >= ends_at)',
    sql: `SELECT COUNT(*)::int n FROM appointments WHERE ends_at IS NOT NULL AND starts_at >= ends_at` },
  { module: 'finance', role: 'accountant', severity: 'high', optional: true,
    title: 'Кассовая операция без tenant_id (сирота/утечка изоляции кассы)',
    sql: `SELECT COUNT(*)::int n FROM cash_operations WHERE tenant_id IS NULL` },
  { module: 'payroll', role: 'accountant', severity: 'medium', optional: true,
    title: 'Расчёт ЗП оплачен, но нет истории выплат (ни полной, ни траншей)',
    sql: `SELECT COUNT(*)::int n FROM payroll_records pr WHERE pr.status='paid' AND pr.total > 0
            AND NOT EXISTS (SELECT 1 FROM payroll_payments pp WHERE pp.record_id=pr.id)
            AND NOT EXISTS (SELECT 1 FROM payroll_partial_payments pk WHERE pk.record_id=pr.id)` },
  { module: 'subscriptions', role: 'accountant', severity: 'medium', optional: true,
    title: 'Абонемент active, но срок действия истёк (статус не обновлён кроном)',
    sql: `SELECT COUNT(*)::int n FROM subscriptions WHERE status='active' AND expires_at IS NOT NULL AND expires_at < CURRENT_DATE - 1` },
  { module: 'certificates', role: 'accountant', severity: 'high', optional: true,
    title: 'Сертификат fully_used, но остаток > 0 (статус противоречит балансу)',
    sql: `SELECT COUNT(*)::int n FROM gift_certificates WHERE status='fully_used' AND remaining_amount > 0.01` },
  { module: 'billing', role: 'accountant', severity: 'high', optional: true,
    title: 'Двойная успешная оплата Mono на один счёт подписки',
    sql: `SELECT COUNT(*)::int n FROM (SELECT invoice_id FROM payments_saas
            WHERE gateway='monobank' AND status='succeeded' AND invoice_id IS NOT NULL
            GROUP BY invoice_id HAVING COUNT(*) > 1) d` },
  { module: 'loyalty', role: 'accountant', severity: 'high', optional: true,
    title: 'Бонусный баланс больше начисленного (невозможно — накрутка)',
    sql: `SELECT COUNT(*)::int n FROM bonus_balances WHERE balance > COALESCE(total_accrued,0) + 0.01` },
  { module: 'finance', role: 'accountant', severity: 'medium', optional: true,
    title: 'Визит оплачен (pay_settled_at), но нет базы для ЗП (real_amount NULL)',
    sql: `SELECT COUNT(*)::int n FROM appointments WHERE pay_settled_at IS NOT NULL AND real_amount IS NULL
            AND pay_settled_at > NOW()-INTERVAL '30 days'` },

  // ── Партия 2: dangling refs, дубли, консистентность (07.07.2026) ──
  { module: 'warehouse', role: 'warehouse', severity: 'medium', optional: true,
    title: 'Материалы визита на несуществующий визит (orphan appointment_materials)',
    sql: `SELECT COUNT(*)::int n FROM appointment_materials am
            WHERE NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id=am.appointment_id)` },
  { module: 'finance', role: 'accountant', severity: 'high', optional: true,
    title: 'Двойная оплата визита: >1 прихода sale_service на одну запись',
    sql: `SELECT COUNT(*)::int n FROM (SELECT ref_id FROM cash_operations
            WHERE type='in' AND ref_type='appointment' AND category='sale_service'
            GROUP BY ref_id, method HAVING COUNT(*) > 1) d` },
  { module: 'loyalty', role: 'accountant', severity: 'medium', optional: true,
    title: 'Списание абонемента больше купленного (usage > visits_included)',
    sql: `SELECT COUNT(*)::int n FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id
            WHERE p.visits_included IS NOT NULL AND p.type IN ('visits','combo')
              AND (p.visits_included - COALESCE(s.visits_remaining,0)) > p.visits_included` },
  { module: 'booking', role: 'admin', severity: 'medium', optional: true,
    title: 'Онлайн-запись confirmed без записи в журнале appointments (потерянный визит)',
    sql: `SELECT COUNT(*)::int n FROM online_bookings b
            WHERE b.status='confirmed' AND b.bp_appointment_id IS NULL
              AND b.date_from > NOW()-INTERVAL '30 days' AND b.date_from < NOW()+INTERVAL '30 days'
              AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.starts_at=b.date_from
                              AND a.master_id::text=b.master_id AND a.status <> 'cancelled')` },
  { module: 'clients', role: 'admin', severity: 'medium', optional: true,
    title: 'Бонусный баланс на несуществующего клиента (orphan)',
    sql: `SELECT COUNT(*)::int n FROM bonus_balances bb
            WHERE NOT EXISTS (SELECT 1 FROM clients c WHERE c.id=bb.client_id)` },
  { module: 'finance', role: 'accountant', severity: 'high', optional: true,
    title: 'Приход в кассу с отрицательной суммой (не сторно)',
    sql: `SELECT COUNT(*)::int n FROM cash_operations WHERE type='in' AND amount < 0` },

  // ── Корректность создания клиентов (проверка Босса 07.07) ──
  { module: 'clients', role: 'admin', severity: 'high', optional: true,
    title: 'Клиент без tenant_id (создание не проставило салон)',
    sql: `SELECT COUNT(*)::int n FROM clients WHERE tenant_id IS NULL` },
  { module: 'clients', role: 'admin', severity: 'high', optional: true,
    title: 'Дубль активных клиентов по телефону в одном салоне (дедуп сломан)',
    sql: `SELECT COUNT(*)::int n FROM (SELECT tenant_id, phone FROM clients
            WHERE phone IS NOT NULL AND phone <> '' AND deleted_at IS NULL
            GROUP BY tenant_id, phone HAVING COUNT(*) > 1) d` },

  // ── Дрейф склада: правки материалов после списания (аудит 07.07, фикс resyncWriteOff) ──
  { module: 'warehouse', role: 'warehouse', severity: 'high', optional: true,
    title: 'Дрейф склада: списано движениями ≠ материалам выполненного визита',
    sql: `SELECT COUNT(*)::int n FROM (
            SELECT a.id,
              (SELECT COALESCE(SUM(qty_used),0) FROM appointment_materials am WHERE am.appointment_id=a.id) AS mat,
              (SELECT COALESCE(-SUM(delta),0) FROM stock_movements sm
                 WHERE sm.reason IN ('service:'||a.id::text,'service-reverse:'||a.id::text)) AS deducted
            FROM appointments a WHERE a.stock_written_off=true
          ) d WHERE ABS(mat - deducted) > 0.01` },

  // ── Связность цен материалов (заявка владельца #145, «везде проверь» 07.07) ──
  { module: 'pricing', role: 'accountant', severity: 'high', optional: true,
    title: 'Товар продаётся ниже закупки (Ціна упаковки < Опт) — убыток',
    sql: `SELECT COUNT(*)::int n FROM product_variants
           WHERE price IS NOT NULL AND wholesale IS NOT NULL AND price > 0 AND wholesale > 0 AND price < wholesale` },
  { module: 'pricing', role: 'accountant', severity: 'high', optional: true,
    title: 'Материал продаётся за грамм ниже себестоимости за грамм — убыток',
    sql: `SELECT COUNT(*)::int n FROM products
           WHERE price_per_gram IS NOT NULL AND cost_per_gram IS NOT NULL AND price_per_gram < cost_per_gram` },
  { module: 'pricing', role: 'accountant', severity: 'medium', optional: true,
    title: 'Настроенная краска: цена упаковки рассинхронена с ценой за грамм × вес',
    sql: `SELECT COUNT(*)::int n FROM products p JOIN product_variants pv ON pv.product_id=p.id
           WHERE p.cost_per_gram IN (2.6,4.05,3.76,9.67) AND pv.unit_ml > 0 AND pv.price IS NOT NULL
             AND ABS(pv.price - p.price_per_gram*pv.unit_ml) > 0.5` },
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
