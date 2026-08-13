/* AI Security Tester.
   DB-уровень: пассивные проверки защитных инвариантов (RLS-функция, роли, сила токена).
   HTTP-уровень: РЕАЛЬНЫЕ атаки против staging-API (cfg.stagingApi) — это ПЕСОЧНИЦА
   (backend CRM на Neon-ветке), атаковать безопасно. Проверяем обход авторизации (RBAC),
   IDOR, SQL-инъекцию, некорректный токен и заголовки безопасности.
   Если staging не задан/недоступен — HTTP-атаки честно помечаются needs-manual (прод за CF). */
const { q } = require('../lib/crm');
const cfg = require('../config');
// ЗАКОН (lib/check.js): проверка, которая не выполнилась, НЕ считается пройденной.
// Раньше здесь по всему файлу стоял `.catch(() => [])` и `if (!r.ok) continue` —
// сбой БД/сети молча превращался в зелёный отчёт («ролей с '*' в норме», «инъекции безопасны»).
const { attempt, record, skipped } = require('../lib/check');

// fetch с жёстким таймаутом (Node 22). AbortController рвёт зависший запрос за 8с.
async function httpProbe(url, { method = 'GET', headers = {}, timeoutMs = 8000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, signal: ac.signal, redirect: 'manual' });
    const text = await res.text().catch(() => '');
    return { ok: true, status: res.status, headers: res.headers, body: text };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `timeout>${timeoutMs}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  name: 'security-probe', role: 'security',
  async run({ regression } = {}) {
    const bugs = [], scenarios = [], coverage = [];

    // 1) Tenant-изоляция: функция current_tenant_id должна существовать (основа RLS).
    // ПРИЧИНА ПРАВКИ: раньше `.catch(() => [])` давал ОБРАТНУЮ ложь — при сбое запроса
    // (нет коннекта, таймаут пула) писался критический баг «функция tenant-изоляции
    // отсутствует», хотя запрос просто не выполнился. Сбой = «не проверено», не тревога.
    scenarios.push('sec:tenant-fn');
    const fnRes = await attempt(() => q(`SELECT proname FROM pg_proc WHERE proname='current_tenant_id' LIMIT 1`));
    const fnFound = fnRes.ok && fnRes.value.length > 0;
    if (record(coverage, bugs, 'security', 'tenant-isolation-fn', fnRes, { role: 'security', severity: 'high', passed: fnFound }) && !fnFound) {
      bugs.push({ severity: 'critical', module: 'security', role: 'security', title: 'Функция tenant-изоляции current_tenant_id отсутствует',
        scenario: 'RLS foundation', expected: 'функция есть', actual: 'нет функции', stillBroken: true });
    }

    // 2) Роли с wildcard '*' — их должно быть мало и осознанно (owner). Аномалия = риск.
    // ПРИЧИНА ПРАВКИ: `.catch(() => [])` → wild=[] → `wild.length <= 2` → покрытие
    // «роли с полным доступом в норме» становилось ЗЕЛЁНЫМ ровно при отказе БД.
    scenarios.push('sec:wildcard-roles');
    const wildRes = await attempt(() => q(`SELECT code FROM roles WHERE permissions @> '["*"]'::jsonb`));
    const wild = wildRes.ok ? wildRes.value : [];
    if (record(coverage, bugs, 'security', 'wildcard-roles-bounded', wildRes, { role: 'security', passed: wild.length <= 2 }) && wild.length > 2) {
      bugs.push({ severity: 'high', module: 'security', role: 'security', title: `Слишком много ролей с полным доступом '*' (${wild.length})`,
        scenario: 'privilege audit', expected: '<=2 (owner/admin)', actual: wild.map((r) => r.code).join(', '), stillBroken: true });
    }

    // 3) Админ-токен не должен быть пустым/дефолтным (иначе любой обойдёт авторизацию).
    scenarios.push('sec:admin-token-set');
    const tokenWeak = !cfg.adminToken || cfg.adminToken.length < 16;
    if (tokenWeak) bugs.push({ severity: 'critical', module: 'security', role: 'security', title: 'ADMIN_TOKEN пустой или слишком короткий',
      scenario: 'auth strength', expected: 'токен >= 16 символов', actual: 'слабый/пустой токен', stillBroken: true });
    coverage.push(['security', 'admin-token-strength', !tokenWeak]);

    // ── HTTP-АТАКИ против staging-API (песочница). Реальные проверки, не needs-manual. ──
    // Запускаем ТОЛЬКО если задан cfg.stagingApi и /health отвечает 200 — иначе прод за CF,
    // и HTTP-атаки помечаются needs-manual (см. ветку ниже).
    // ПРИЧИНА ПРАВКИ: весь блок был спрятан за `if (cfg.stagingApi)` + httpLive. Когда staging
    // не задан или лежит — не писалось НИЧЕГО, и в data/coverage.json оставались старые «ок»
    // с прошлых прогонов. Теперь каждый http-ключ явно перезаписывается на «пропущено».
    const HTTP_KEYS = ['http-rbac-requires-token', 'http-bad-token-401', 'http-idor-protected', 'http-sql-injection-safe', 'http-security-headers'];
    const skipAllHttp = (reason) => { for (const k of HTTP_KEYS) skipped(coverage, bugs, 'security', k, reason, { role: 'security' }); };

    let httpLive = false;
    if (!cfg.stagingApi) {
      skipAllHttp('staging-API не задан (QA_STAGING_API) — HTTP-атаки не выполнялись, прошлый результат недействителен');
    } else {
      const base = cfg.stagingApi.replace(/\/$/, '');
      const health = await httpProbe(`${base}/health`);
      httpLive = health.ok && health.status === 200;

      if (!httpLive) {
        skipAllHttp(`staging-API (${base}) недоступен: ${health.ok ? 'GET /health → HTTP ' + health.status : health.error} — HTTP-атаки не выполнялись`);
      } else {
        // Защищённый endpoint для проверок авторизации/IDOR: детали чужой записи (RBAC schedule.read).
        const protectedPath = '/api/schedule/appointments/1/details';

        // H1) RBAC / обход авторизации: защищённый endpoint БЕЗ токена → должен быть 401/403.
        //     Если 200 — критическая дыра: любой без токена читает защищённые данные.
        scenarios.push('sec:http-rbac-no-token');
        const noTok = await httpProbe(`${base}${protectedPath}`);
        if (!noTok.ok) {
          // Сетевой сбой/таймаут: мы НЕ доказали, что авторизация требуется — это «не проверено».
          skipped(coverage, bugs, 'security', 'http-rbac-requires-token',
            `запрос к staging не выполнился (${noTok.error}) — RBAC без токена не проверен`, { role: 'security' });
        } else {
          if (noTok.status === 200) {
            bugs.push({ severity: 'critical', module: 'security', role: 'security',
              title: 'Обход авторизации: защищённый endpoint отдаёт 200 без токена',
              scenario: `GET ${protectedPath} без Authorization/X-Admin-Token`,
              steps: `curl ${base}${protectedPath} (без токена)`,
              expected: '401 или 403 (unauthorized)', actual: `200 OK — данные отданы без авторизации`,
              cause: 'Отсутствует/не отрабатывает requirePerm на роуте — доступ открыт анониму',
              stillBroken: true, evidence: { status: noTok.status, bodySample: (noTok.body || '').slice(0, 200) } });
          }
          coverage.push(['security', 'http-rbac-requires-token', noTok.status === 401 || noTok.status === 403]);
        }

        // H2) Некорректный токен → должен быть 401 (а не 200 и не 500).
        scenarios.push('sec:http-bad-token');
        const badTok = await httpProbe(`${base}${protectedPath}`, { headers: { 'X-Admin-Token': 'invalid-token-' + Date.now() } });
        if (!badTok.ok) {
          // Раньше при сетевом сбое просто писалось coverage=false БЕЗ находки — никто бы не узнал,
          // что проверка «мусорный токен → 401» вообще не выполнялась.
          skipped(coverage, bugs, 'security', 'http-bad-token-401',
            `запрос к staging не выполнился (${badTok.error}) — реакция на невалидный токен не проверена`, { role: 'security' });
        } else {
          if (badTok.status === 200) {
            bugs.push({ severity: 'critical', module: 'security', role: 'security',
              title: 'Обход авторизации: невалидный токен принят (200)',
              scenario: `GET ${protectedPath} с мусорным X-Admin-Token`,
              steps: `curl -H "X-Admin-Token: invalid-..." ${base}${protectedPath}`,
              expected: '401 unauthorized', actual: '200 OK — мусорный токен пропущен',
              cause: 'Токен не валидируется на сервере', stillBroken: true, evidence: { status: badTok.status } });
          } else if (badTok.status >= 500) {
            bugs.push({ severity: 'high', module: 'security', role: 'security',
              title: 'Невалидный токен приводит к 500 (падение вместо 401)',
              scenario: `GET ${protectedPath} с мусорным токеном`,
              expected: '401 unauthorized', actual: `${badTok.status} server error`,
              cause: 'Необработанное исключение в auth-слое', stillBroken: true, evidence: { status: badTok.status } });
          }
          coverage.push(['security', 'http-bad-token-401', badTok.status === 401]);
        }

        // H3) IDOR: запрос чужого ресурса по id БЕЗ валидного токена → не должен отдавать данные.
        //     Проверяем, что endpoint не сливает данные другого id анониму/по пустому токену.
        scenarios.push('sec:http-idor');
        const idor = await httpProbe(`${base}/api/schedule/appointments/1/details`, { headers: { 'X-Admin-Token': '' } });
        if (!idor.ok) {
          // Сбой сети ≠ «IDOR закрыт». Без ответа сервера утверждать нечего.
          skipped(coverage, bugs, 'security', 'http-idor-protected',
            `запрос к staging не выполнился (${idor.error}) — IDOR не проверен`, { role: 'security' });
        } else {
          if (idor.status === 200 && /("id"|"master"|"client"|"appointment")/i.test(idor.body || '')) {
            bugs.push({ severity: 'high', module: 'security', role: 'security',
              title: 'IDOR: детали чужой записи отдаются без валидного токена',
              scenario: 'GET /api/schedule/appointments/1/details с пустым токеном',
              steps: `curl -H "X-Admin-Token:" ${base}/api/schedule/appointments/1/details`,
              expected: '401/403/404 без утечки данных', actual: '200 OK с данными записи',
              cause: 'Нет проверки владельца ресурса / авторизации перед выдачей объекта по id',
              stillBroken: true, evidence: { status: idor.status, bodySample: (idor.body || '').slice(0, 200) } });
          }
          coverage.push(['security', 'http-idor-protected', idor.status === 401 || idor.status === 403 || idor.status === 404]);
        }

        // H4) SQL-инъекция через query-параметр: payload `1 OR 1=1` / `'; DROP` →
        //     не должно быть 500 с SQL-ошибкой в теле и не должно сливать лишние данные.
        scenarios.push('sec:http-sql-injection');
        // ПРИЧИНА ПРАВКИ (двойная):
        //  1) токен брался ТОЛЬКО из process.env.ADMIN_TOKEN. Пустой токен → все ответы 401 →
        //     флаги sqlErr/sqlLeak остаются false → отчёт писал «SQL-инъекция не проходит»,
        //     хотя атака вообще не дошла до SQL-слоя. Добавлен фолбэк на cfg.adminToken.
        //  2) `if (!r.ok) continue` — если ВСЕ payload'ы упали по таймауту, вердикт был «безопасно».
        //     Теперь считаем реально выполненные попытки: ноль выполненных → «не проверено».
        const adminTok = process.env.ADMIN_TOKEN || cfg.adminToken || '';
        const authH = adminTok ? { 'X-Admin-Token': adminTok } : {};
        const sqlPayloads = ["1 OR 1=1", "1'; DROP TABLE masters; --", "2024-01-01' OR '1'='1"];
        let sqlLeak = false, sqlErr = false;
        let sqlExecuted = 0, sqlDenied = 0;
        const sqlEvidence = [];
        for (const p of sqlPayloads) {
          const r = await httpProbe(`${base}/api/schedule/journal?date=${encodeURIComponent(p)}`, { headers: authH });
          if (!r.ok) continue;
          sqlExecuted++;
          if (r.status === 401 || r.status === 403) sqlDenied++;
          const bodyLc = (r.body || '').toLowerCase();
          const hasSqlError = r.status >= 500 && /(syntax error|sql|pg_|postgres|column .* does not exist|relation .* does not exist|invalid input syntax)/i.test(bodyLc);
          if (hasSqlError) { sqlErr = true; sqlEvidence.push({ payload: p, status: r.status, bodySample: (r.body || '').slice(0, 200) }); }
          // Если payload проходит валидацию и отдаёт 200 с массивом данных — потенциальная инъекция/обход фильтра.
          if (r.status === 200 && /or\s+1\s*=\s*1/i.test(p) && /\[|"masters"|"appointments"/i.test(r.body || '')) {
            sqlLeak = true; sqlEvidence.push({ payload: p, status: r.status, bodySample: (r.body || '').slice(0, 200) });
          }
        }
        if (sqlErr) bugs.push({ severity: 'high', module: 'security', role: 'security',
          title: 'SQL Injection: сервер отдаёт SQL-ошибку (500) на инъекционный параметр',
          scenario: 'GET /api/schedule/journal?date=<sql-payload>',
          steps: `curl "${base}/api/schedule/journal?date=1'%3B%20DROP..."`,
          expected: '400 bad-request без SQL-деталей', actual: '500 c SQL-ошибкой в теле (утечка структуры БД)',
          cause: 'Параметр подставляется в SQL без параметризации/валидации', stillBroken: true, evidence: sqlEvidence });
        if (sqlLeak) bugs.push({ severity: 'critical', module: 'security', role: 'security',
          title: 'SQL Injection: `OR 1=1` проходит и возвращает данные',
          scenario: 'GET /api/schedule/journal?date=1 OR 1=1',
          expected: '400/пустой результат', actual: '200 с данными — фильтр обойдён',
          cause: 'Конкатенация пользовательского ввода в SQL WHERE', stillBroken: true, evidence: sqlEvidence });
        // Зелёный вердикт «инъекции безопасны» имеет право появиться, только если атака
        // реально дошла до проверяемого слоя: есть токен, есть выполненные попытки, и не все
        // они отбиты авторизацией. Иначе — «не проверено».
        if (!adminTok) {
          skipped(coverage, bugs, 'security', 'http-sql-injection-safe',
            'нет токена — атака не дошла до проверяемого слоя', { role: 'security' });
        } else if (sqlExecuted === 0) {
          skipped(coverage, bugs, 'security', 'http-sql-injection-safe',
            'ни один payload не выполнился (сеть/таймаут) — SQL-инъекция не проверена', { role: 'security' });
        } else if (sqlDenied === sqlExecuted) {
          skipped(coverage, bugs, 'security', 'http-sql-injection-safe',
            `все ${sqlExecuted} ответа(ов) — 401/403: атака не дошла до проверяемого слоя (токен не принят)`, { role: 'security' });
        } else {
          coverage.push(['security', 'http-sql-injection-safe', !sqlErr && !sqlLeak]);
        }

        // H5) Заголовки безопасности: базовый набор (nosniff, frameguard, referrer-policy).
        //     Если отсутствуют — low bug (defense-in-depth).
        scenarios.push('sec:http-security-headers');
        const hh = await httpProbe(`${base}/health`);
        // ПРИЧИНА ПРАВКИ: если /health не ответил, hget() возвращал '' для ВСЕХ заголовков →
        // рождался баг «отсутствуют заголовки безопасности» без единого полученного ответа.
        // Сбой = «не проверено», а не находка.
        if (!hh.ok || !hh.headers || typeof hh.headers.get !== 'function') {
          skipped(coverage, bugs, 'security', 'http-security-headers',
            `ответ /health не получен (${hh.error || 'нет заголовков в ответе'}) — заголовки безопасности не проверены`, { role: 'security' });
        } else {
          const hget = (n) => hh.headers.get(n) || '';
          const missing = [];
          if (!hget('x-content-type-options')) missing.push('X-Content-Type-Options');
          if (!hget('x-frame-options') && !/frame-ancestors/i.test(hget('content-security-policy'))) missing.push('X-Frame-Options');
          if (!hget('referrer-policy')) missing.push('Referrer-Policy');
          if (missing.length) bugs.push({ severity: 'low', module: 'security', role: 'security',
            title: `Отсутствуют заголовки безопасности: ${missing.join(', ')}`,
            scenario: 'GET /health — анализ ответных заголовков',
            expected: 'X-Content-Type-Options: nosniff, X-Frame-Options/CSP frame-ancestors, Referrer-Policy',
            actual: `нет: ${missing.join(', ')}`, cause: 'helmet не выставляет часть базовых заголовков',
            stillBroken: true, evidence: { missing } });
          coverage.push(['security', 'http-security-headers', missing.length === 0]);
        }
      }
    }

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
      // HTTP-атаки (XSS/CSRF/IDOR/RBAC) уже выполнены реально против staging выше — заглушка не нужна.
    } else if (!regression && !cfg.allowDestructive) {
      bugs.push({ severity: 'low', module: 'security', role: 'security', title: 'Активные атаки не выполнены (нет QA-ветки)',
        needsManual: true, manualReason: 'Требует QA_DB_URL. Против боевой БД салона деструктив запрещён.' });
    }
    return { scenarios, bugs, coverage };
  },
};
