/* AI Regression / Warehouse / Master — целостность данных по модулям.
   Находит «тихие» баги: сироты, отрицательные остатки, битые ссылки, неконсистентные статусы.
   Read-only, безопасно. Сценарии расширяются добавлением правил в RULES. */
const { q } = require('../lib/crm');

// Каждое правило: безопасный SELECT, который ДОЛЖЕН вернуть 0 строк. Иначе — баг.
const RULES = [
  { module: 'masters', role: 'admin', title: 'Записи на несуществующего мастера',
    sql: `SELECT COUNT(*)::int n FROM appointments a WHERE a.master_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM masters m WHERE m.id=a.master_id) AND a.starts_at >= NOW()-INTERVAL '60 days'`,
    severity: 'high' },
  { module: 'warehouse', role: 'warehouse', title: 'Отрицательные остатки на складе',
    sql: `SELECT COUNT(*)::int n FROM product_stock WHERE quantity < 0`, severity: 'high', optional: true },
  { module: 'clients', role: 'admin', title: 'Записи на несуществующего клиента',
    sql: `SELECT COUNT(*)::int n FROM appointments a WHERE a.client_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM clients c WHERE c.id=a.client_id) AND a.starts_at >= NOW()-INTERVAL '60 days'`,
    severity: 'medium' },
  { module: 'beauty', role: 'master', title: 'Формулы окрашивания на несуществующего клиента',
    sql: `SELECT COUNT(*)::int n FROM coloring_formulas f WHERE NOT EXISTS(SELECT 1 FROM clients c WHERE c.id=f.client_id)`, severity: 'medium', optional: true },
  { module: 'tasks', role: 'admin', title: 'Задачи с невалидным статусом (не видны на доске)',
    sql: `SELECT COUNT(*)::int n FROM tasks WHERE status NOT IN ('backlog','todo','in_progress','review','done','cancelled')`, severity: 'high' },
  { module: 'finance', role: 'accountant', title: 'Касса прихода с нулевой/отрицательной суммой',
    sql: `SELECT COUNT(*)::int n FROM cash_operations WHERE type='in' AND amount <= 0 AND created_at >= NOW()-INTERVAL '30 days'`, severity: 'medium' },
];

module.exports = {
  name: 'data-integrity', role: 'regression',
  async run() {
    const bugs = [], scenarios = [], coverage = [];
    for (const r of RULES) {
      scenarios.push(`integrity:${r.module}:${r.title}`);
      let n;
      try { n = (await q(r.sql))[0].n; }
      catch (e) {
        if (r.optional) { coverage.push([r.module, r.title, 'skip']); continue; } // таблицы может не быть
        bugs.push({ severity: 'low', module: r.module, role: r.role, title: `Проверку нельзя выполнить: ${r.title}`,
          needsManual: true, manualReason: 'SQL ошибка: ' + e.message, scenario: r.title });
        continue;
      }
      if (n > 0) {
        bugs.push({ severity: r.severity, module: r.module, role: r.role, title: r.title,
          scenario: 'Проверка целостности (правило ДОЛЖНО давать 0 строк)',
          expected: '0 нарушений', actual: `${n} нарушений`, sql: r.sql, stillBroken: true,
          evidence: { violations: n } });
      }
      coverage.push([r.module, r.title, n === 0]);
    }
    return { scenarios, bugs, coverage };
  },
};
