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

    // 4) АКТИВНЫЕ проверки в изолированной ветке (qaQ). Без ветки — честно needs-manual.
    if (!regression && cfg.allowDestructive) {
      const { qaQ } = require('../lib/crm');
      const tag = 'QASEC_' + Date.now();
      try {
        // 4a) SQL-инъекция: вредоносная строка через параметр НЕ должна навредить (параметризация).
        scenarios.push('sec:sql-injection-resilience');
        const payload = `${tag}'; DROP TABLE clients; --`;
        await qaQ(`INSERT INTO clients (name, phone) VALUES ($1,$2)`, [payload, '+38000' + (Date.now() % 1000000)]);
        const tableOk = (await qaQ(`SELECT to_regclass('public.clients') t`))[0].t;
        const stored = (await qaQ(`SELECT name FROM clients WHERE name=$1`, [payload]))[0];
        if (!tableOk) bugs.push({ severity: 'critical', module: 'security', role: 'security', title: 'SQL-инъекция: таблица clients уничтожена payload-ом',
          scenario: 'INSERT с "; DROP TABLE --', expected: 'таблица цела', actual: 'таблицы нет', stillBroken: true });
        else if (!stored) bugs.push({ severity: 'high', module: 'security', role: 'security', title: 'Инъекционный payload не сохранён как литерал',
          scenario: 'payload должен лежать как обычный текст', expected: 'строка сохранена', actual: 'нет строки', stillBroken: true });
        coverage.push(['security', 'sql-injection-safe', !!tableOk && !!stored]);

        // 4b) Двойной платёж/списание: один ext_ref дважды → не должно задвоиться (идемпотентность).
        scenarios.push('sec:double-payment');
        await qaQ(`INSERT INTO cash_operations (type,category,amount,method,ref_type,ext_ref,created_at) VALUES ('in','sale_service',100,'cash','qa_sec',$1,NOW())
                   ON CONFLICT (ext_ref) WHERE ext_ref IS NOT NULL DO NOTHING`, [tag]);
        await qaQ(`INSERT INTO cash_operations (type,category,amount,method,ref_type,ext_ref,created_at) VALUES ('in','sale_service',100,'cash','qa_sec',$1,NOW())
                   ON CONFLICT (ext_ref) WHERE ext_ref IS NOT NULL DO NOTHING`, [tag]);
        const dupCount = (await qaQ(`SELECT COUNT(*)::int n FROM cash_operations WHERE ext_ref=$1`, [tag]))[0].n;
        if (dupCount > 1) bugs.push({ severity: 'critical', module: 'security', role: 'security', title: 'Двойной платёж: один ext_ref задвоился в кассе',
          scenario: 'двойной INSERT cash с тем же ext_ref', expected: '1 запись', actual: `${dupCount} записей`, stillBroken: true, evidence: { dupCount } });
        coverage.push(['security', 'no-double-payment', dupCount <= 1]);
      } catch (e) {
        bugs.push({ severity: 'high', module: 'security', role: 'security', title: 'Активная security-проверка упала', scenario: 'sql-injection/double-payment в ветке', actual: e.message, errorStack: e.stack, stillBroken: true });
      } finally {
        try { await qaQ(`DELETE FROM clients WHERE name LIKE $1`, [tag + '%']); await qaQ(`DELETE FROM cash_operations WHERE ext_ref=$1`, [tag]); } catch (_) {}
      }
      // XSS/CSRF/IDOR через HTTP — нужен достижимый API (прод за CF). Остаётся needs-manual.
      bugs.push({ severity: 'low', module: 'security', role: 'security', title: 'HTTP-атаки (XSS/CSRF/IDOR) не автоматизированы',
        needsManual: true, manualReason: 'Нужен достижимый API-таргет. SQL-инъекция и двойной платёж проверены в ветке.' });
    } else if (!regression && !cfg.allowDestructive) {
      bugs.push({ severity: 'low', module: 'security', role: 'security', title: 'Активные атаки не выполнены (нет QA-ветки)',
        needsManual: true, manualReason: 'Требует QA_DB_URL. Против боевой БД салона деструктив запрещён.' });
    }
    return { scenarios, bugs, coverage };
  },
};
