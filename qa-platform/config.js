/* QA Platform — конфигурация и режимы безопасности.
   ГЛАВНОЕ ПРАВИЛО БЕЗОПАСНОСТИ: деструктивные агенты (load, write-heavy, SQL-injection
   с реальными мутациями) НЕ запускаются против боевой БД салона. Они включаются ТОЛЬКО
   когда задан изолированный QA-таргет (QA_TENANT_ID или staging API). По умолчанию —
   SAFE: read-only проверки + сверки против прода. Это защищает реальные данные клиента. */
require('dotenv').config({ path: require('path').join(__dirname, '../backend/.env') });

const cfg = {
  // База API CRM. Для прод-сверок читаем напрямую из БД (быстрее, без CF).
  apiBase: process.env.QA_API_BASE || 'http://127.0.0.1:3011',
  prodApiBase: 'https://svs-shop-api.onrender.com',
  adminToken: process.env.ADMIN_TOKEN || '',

  // Изолированный таргет для деструктивных тестов. Пока не задан — деструктив запрещён.
  qaTenantId: process.env.QA_TENANT_ID || null,
  stagingApi: process.env.QA_STAGING_API || null,

  // Режим: 'safe' (только read-only + сверки) | 'full' (нужен изолированный таргет)
  get mode() { return (this.qaTenantId || this.stagingApi) ? 'full' : 'safe'; },
  // Разрешены ли деструктивные операции (массовая генерация, мутации, инъекции)
  get allowDestructive() { return this.mode === 'full'; },

  // Пути хранения
  dataDir: require('path').join(__dirname, 'data'),
  artifactsDir: require('path').join(__dirname, 'artifacts'),

  // Loop
  cycleCooldownMs: Number(process.env.QA_COOLDOWN_MS || 0), // пауза между циклами
  scenarioDedupWindowH: 12, // не повторять идентичный сценарий чаще, чем раз в N часов
};

module.exports = cfg;
