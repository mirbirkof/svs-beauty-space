/* AI Security Tester (безопасный DB-уровень).
   Активные атаки (SQLi/XSS/CSRF/IDOR через HTTP, race conditions, повторные платежи) ТРЕБУЮТ
   изолированного QA-таргета — против боевой БД салона они запрещены. Здесь — пассивные проверки
   защитных инвариантов на уровне БД + честная пометка needs-manual для активных атак. */
const { q } = require('../lib/crm');
const cfg = require('../config');

module.exports = {
  name: 'security-probe', role: 'security',
  async run({ regression } = {}) {
    const bugs = [], scenarios = [], coverage = [];

    // 1) Tenant-изоляция: функция current_tenant_id должна существовать (основа RLS).
    scenarios.push('sec:tenant-fn');
    const fn = await q(`SELECT proname FROM pg_proc WHERE proname='current_tenant_id' LIMIT 1`).catch(() => []);
    if (!fn.length) bugs.push({ severity: 'critical', module: 'security', role: 'security', title: 'Функция tenant-изоляции current_tenant_id отсутствует',
      scenario: 'RLS foundation', expected: 'функция есть', actual: 'нет функции', stillBroken: true });
    coverage.push(['security', 'tenant-isolation-fn', fn.length > 0]);

    // 2) Роли с wildcard '*' — их должно быть мало и осознанно (owner). Аномалия = риск.
    scenarios.push('sec:wildcard-roles');
    const wild = await q(`SELECT code FROM roles WHERE permissions @> '["*"]'::jsonb`).catch(() => []);
    if (wild.length > 2) bugs.push({ severity: 'high', module: 'security', role: 'security', title: `Слишком много ролей с полным доступом '*' (${wild.length})`,
      scenario: 'privilege audit', expected: '<=2 (owner/admin)', actual: wild.map((r) => r.code).join(', '), stillBroken: true });
    coverage.push(['security', 'wildcard-roles-bounded', wild.length <= 2]);

    // 3) Админ-токен не должен быть пустым/дефолтным (иначе любой обойдёт авторизацию).
    scenarios.push('sec:admin-token-set');
    const tokenWeak = !cfg.adminToken || cfg.adminToken.length < 16;
    if (tokenWeak) bugs.push({ severity: 'critical', module: 'security', role: 'security', title: 'ADMIN_TOKEN пустой или слишком короткий',
      scenario: 'auth strength', expected: 'токен >= 16 символов', actual: 'слабый/пустой токен', stillBroken: true });
    coverage.push(['security', 'admin-token-strength', !tokenWeak]);

    // 4) Активные атаки — нужен изолированный таргет. Честно помечаем (по ТЗ: needs-manual + причина).
    if (!regression && !cfg.allowDestructive) {
      for (const attack of ['SQL Injection', 'XSS', 'CSRF', 'IDOR', 'race conditions', 'повторные платежи', 'двойное списание', 'обход RBAC через HTTP', 'выход за пределы tenant через API']) {
        bugs.push({ severity: 'low', module: 'security', role: 'security', title: `Активная проверка «${attack}» не выполнена автоматически`,
          needsManual: true, manualReason: 'Требует изолированного QA-таргета (QA_TENANT_ID/staging). Против боевой БД салона деструктивные атаки запрещены — риск порчи реальных данных.' });
      }
    }
    return { scenarios, bugs, coverage };
  },
};
