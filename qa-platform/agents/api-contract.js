/* AI API Tester (schema-contract слой + реальные HTTP-проверки staging).
   Раньше HTTP-проверки эндпоинтов помечались needs-manual (прод за Cloudflare, локального API нет).
   Теперь при заданном достижимом staging-API (cfg.stagingApi, песочница Neon) выполняем РЕАЛЬНЫЕ
   HTTP-проверки по разделу API TESTING ТЗ: доступность эндпоинтов, неподдерживаемые методы,
   авторизация, валидация тела, некорректные параметры, большие объёмы.
   БД-контракт (таблицы/колонки, на которые опираются эндпоинты) проверяется как и раньше —
   этот блок НЕ трогаем, HTTP-проверки ДОБАВЛЕНЫ поверх. */
const { q } = require('../lib/crm');
const cfg = require('../config');

// модуль → [таблица, [обязательные колонки]]
const CONTRACT = [
  ['clients', 'clients', ['id', 'name', 'phone']],
  ['appointments', 'appointments', ['id', 'client_id', 'master_id', 'starts_at', 'status']],
  ['finance', 'cash_operations', ['id', 'type', 'category', 'amount', 'master_id', 'ref_type']],
  ['tasks', 'tasks', ['id', 'title', 'status', 'priority', 'tags']],
  ['incidents', 'incidents', ['id', 'incident_number', 'status', 'priority', 'sla_resolution_at']],
  ['beauty', 'medical_cards', ['id', 'client_id', 'allergies', 'contraindications']],
  ['beauty', 'coloring_formulas', ['id', 'client_id', 'zones', 'is_current']],
  ['beauty', 'allergy_tests', ['id', 'client_id', 'final_result', 'valid_until']],
  ['surveys', 'surveys', ['id', 'title', 'type', 'status']],
  ['documents', 'documents', ['id', 'title', 'category', 'status', 'expires_at']],
  ['kb', 'kb_articles', ['id', 'title', 'status']],
];

// ── HTTP-хелпер: fetch (Node 22) с жёстким таймаутом на каждый запрос (AbortController, 8с) ──
async function req(base, path, { method = 'GET', headers = {}, body, timeoutMs = 8000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(base.replace(/\/$/, '') + path, {
      method, headers, body, signal: ac.signal,
    });
    return { ok: true, status: res.status };
  } catch (e) {
    // abort/сетевая ошибка — считаем как «нет ответа» (не 5xx, но и не успех)
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Ключевые публичные/health эндпоинты — должны отвечать (не сеть-fail, не 5xx).
const KEY_ENDPOINTS = [
  ['health', '/health'],
  ['health', '/api/shop/health'],
  ['schedule', '/api/schedule/masters'],
  ['catalog', '/api/catalog'],
  ['services', '/api/services'],
];

async function runHttpChecks({ base, token, bugs, scenarios, coverage }) {
  const adminHeaders = token ? { 'X-Admin-Token': token } : {};

  // 1) Доступность ключевых эндпоинтов: отвечает и не 5xx.
  for (const [module, path] of KEY_ENDPOINTS) {
    const sc = `http:GET ${path}`;
    scenarios.push(sc);
    const r = await req(base, path, { headers: adminHeaders });
    if (!r.ok) {
      bugs.push({ severity: 'high', module, role: 'api', title: `Эндпоинт ${path} недоступен`,
        scenario: sc, expected: 'HTTP-ответ (2xx/3xx/4xx)', actual: `нет ответа: ${r.error}`,
        cause: 'эндпоинт не отвечает / упал / таймаут', stillBroken: true });
      coverage.push([module, `http:${path}`, false]);
      continue;
    }
    if (r.status >= 500) {
      bugs.push({ severity: 'high', module, role: 'api', title: `Эндпоинт ${path} отдаёт ${r.status}`,
        scenario: sc, expected: '2xx/3xx (или 4xx при авторизации)', actual: `HTTP ${r.status}`,
        cause: 'необработанное исключение на сервере (5xx)', stillBroken: true });
      coverage.push([module, `http:${path}`, false]);
      continue;
    }
    coverage.push([module, `http:${path}`, true]);
  }

  // 2) Неподдерживаемый HTTP-метод → 404/405, но НЕ 500.
  {
    const sc = 'http:unsupported method (DELETE /health)';
    scenarios.push(sc);
    const r = await req(base, '/health', { method: 'DELETE', headers: adminHeaders });
    coverage.push(['api', 'http:method-handling', r.ok && r.status < 500]);
    if (r.ok && r.status >= 500) {
      bugs.push({ severity: 'medium', module: 'api', role: 'api', title: 'Неподдерживаемый метод даёт 5xx вместо 404/405',
        scenario: sc, expected: '404 или 405', actual: `HTTP ${r.status}`,
        cause: 'нет обработки неподдерживаемого метода — падает в 500' });
    }
  }

  // 3) Авторизация: защищённый эндпоинт БЕЗ токена → 401 (не 200, не 500).
  {
    const sc = 'http:auth GET /api/users без токена';
    scenarios.push(sc);
    const r = await req(base, '/api/users'); // без X-Admin-Token
    coverage.push(['api', 'http:auth-guard', r.ok && r.status === 401]);
    if (r.ok && r.status !== 401) {
      const leak = r.status >= 200 && r.status < 300;
      bugs.push({ severity: leak ? 'critical' : 'high', module: 'api', role: 'api',
        title: leak ? 'Защищённый эндпоинт доступен БЕЗ токена (утечка данных)' : `Защищённый эндпоинт без токена вернул ${r.status} вместо 401`,
        scenario: sc, expected: '401 unauthorized', actual: `HTTP ${r.status}`,
        cause: leak ? 'отсутствует/не срабатывает проверка авторизации' : 'ошибка авторизационного middleware (5xx вместо 401)' });
    }
  }

  // 4) Валидация: POST с мусорным (невалидный JSON) телом → 400 (не 500).
  {
    const sc = 'http:validation POST /api/clients мусорное тело';
    scenarios.push(sc);
    const r = await req(base, '/api/clients', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: '{this is not: valid json,,,',
    });
    // 400 (bad json) или 401 (нет прав) — ок; 500 — баг.
    coverage.push(['api', 'http:body-validation', r.ok && r.status < 500]);
    if (r.ok && r.status >= 500) {
      bugs.push({ severity: 'high', module: 'api', role: 'api', title: 'POST с невалидным JSON-телом даёт 5xx вместо 400',
        scenario: sc, expected: '400 (bad request) или 401', actual: `HTTP ${r.status}`,
        cause: 'не обрабатывается ошибка парсинга тела запроса' });
    }
  }

  // 5) Некорректные параметры: /api/schedule/appointments?date=BADDATE → НЕ 500.
  {
    const sc = 'http:bad param /api/schedule/appointments?date=BADDATE';
    scenarios.push(sc);
    const r = await req(base, '/api/schedule/appointments?date=BADDATE', { headers: adminHeaders });
    coverage.push(['schedule', 'http:param-validation', r.ok && r.status < 500]);
    if (r.ok && r.status >= 500) {
      bugs.push({ severity: 'high', module: 'schedule', role: 'api', title: 'Некорректный date-параметр роняет эндпоинт в 5xx',
        scenario: sc, expected: '400/422 (или пустой 200), НЕ 5xx', actual: `HTTP ${r.status}`,
        cause: 'параметр date уходит в SQL-каст без валидации → ошибка приведения типа' });
    }
  }

  // 6) Большие объёмы: очень длинный query param → не падает 500.
  {
    const sc = 'http:large query param (~50k символов)';
    scenarios.push(sc);
    const big = 'A'.repeat(50000);
    const r = await req(base, '/api/schedule/masters?q=' + big, { headers: adminHeaders });
    // сеть-fail здесь допустим (сервер мог оборвать) — фиксируем только явный 5xx.
    coverage.push(['api', 'http:large-input', !(r.ok && r.status >= 500)]);
    if (r.ok && r.status >= 500) {
      bugs.push({ severity: 'medium', module: 'api', role: 'api', title: 'Очень длинный query param роняет эндпоинт в 5xx',
        scenario: sc, expected: 'обработать/отклонить (4xx или 2xx), НЕ 5xx', actual: `HTTP ${r.status}`,
        cause: 'нет лимита на длину параметров — большой ввод вызывает необработанную ошибку' });
    }
  }
}

module.exports = {
  name: 'api-contract', role: 'api',
  async run({ regression } = {}) {
    const bugs = [], scenarios = [], coverage = [];
    for (const [module, table, cols] of CONTRACT) {
      scenarios.push(`contract:${table}`);
      const exists = (await q(`SELECT to_regclass($1) t`, ['public.' + table]))[0].t;
      if (!exists) {
        bugs.push({ severity: 'high', module, role: 'api', title: `Таблица ${table} отсутствует (эндпоинты модуля упадут)`,
          scenario: 'schema contract', expected: `${table} существует`, actual: 'нет таблицы', stillBroken: true });
        coverage.push([module, `table:${table}`, false]); continue;
      }
      const have = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [table])).map((r) => r.column_name);
      const missing = cols.filter((c) => !have.includes(c));
      if (missing.length) {
        bugs.push({ severity: 'high', module, role: 'api', title: `В таблице ${table} нет колонок: ${missing.join(', ')}`,
          scenario: 'schema contract', expected: cols.join(', '), actual: `нет: ${missing.join(', ')}`, stillBroken: true });
      }
      coverage.push([module, `table:${table}`, missing.length === 0]);
    }

    // ── HTTP-контракт эндпоинтов ──
    // Есть достижимый staging-API (песочница Neon) → делаем РЕАЛЬНЫЕ проверки.
    // Условие: cfg.stagingApi задан И /health отвечает. Иначе — прежнее поведение (needsManual).
    const base = cfg.stagingApi;
    let healthOk = false;
    if (base) {
      const h = await req(base, '/health', { timeoutMs: 8000 });
      healthOk = h.ok && h.status < 500;
    }

    if (base && healthOk) {
      await runHttpChecks({ base, token: process.env.ADMIN_TOKEN || cfg.adminToken || '', bugs, scenarios, coverage });
    } else if (!regression) {
      // staging не задан или /health не отвечает — честно оставляем ручную зону.
      bugs.push({ severity: 'low', module: 'api', role: 'api', title: 'HTTP-проверка всех эндпоинтов не автоматизирована',
        needsManual: true, manualReason: base
          ? `staging-API задан (${base}), но /health не ответил — HTTP-автотесты пропущены до восстановления таргета.`
          : 'Прод-API за Cloudflare, staging-таргет (cfg.stagingApi / QA_STAGING_API) не задан. Нужен достижимый API для автотестов методов/валидации/лимитов.' });
    }

    return { scenarios, bugs, coverage };
  },
};
