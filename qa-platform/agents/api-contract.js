/* AI API Tester (schema-contract слой).
   Прод-API за Cloudflare и недоступен для авто-вызовов из этой среды, поэтому HTTP-проверки
   эндпоинтов помечаются needs-manual. Здесь проверяем КОНТРАКТ хранилища: таблицы и ключевые
   колонки, на которые опираются эндпоинты, существуют. Битый контракт = эндпоинт упадёт 500. */
const { q } = require('../lib/crm');

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
    // HTTP-контракт эндпоинтов — нужен достижимый API-таргет (прод за CF). Честно: ручная зона.
    if (!regression) {
      bugs.push({ severity: 'low', module: 'api', role: 'api', title: 'HTTP-проверка всех эндпоинтов не автоматизирована',
        needsManual: true, manualReason: 'Прод-API за Cloudflare, локальный API не поднят в QA-среде. Нужен достижимый API-таргет (staging) для автотестов методов/валидации/лимитов.' });
    }
    return { scenarios, bugs, coverage };
  },
};
