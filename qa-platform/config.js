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

  // Изолированный таргет для деструктивных тестов: ОТДЕЛЬНАЯ Neon-ветка (qa-sandbox).
  // Это copy-on-write копия БД — запись сюда НЕ касается ни прода, ни бэкап-main.
  qaDbUrl: process.env.QA_DB_URL || null,
  qaTenantId: process.env.QA_TENANT_ID || null,
  stagingApi: process.env.QA_STAGING_API || null,

  // Постоянный тест-салон на проде — QA-фикстур для авторизованных проверок кабинета.
  // Изолирован RLS, отдельный тенант, реальных клиентов не касается. Тестер логинится сам
  // через panel-login (токен не хранится — не протухает). Удалить только когда СРМ 100%.
  qaUi: {
    slug: process.env.QA_UI_SLUG || 'qa-visual-test',
    phone: process.env.QA_UI_PHONE || '+380991310672',
    password: process.env.QA_UI_PASSWORD || 'qatest123456',
  },

  // Режим: 'safe' (только read-only + сверки) | 'full' (есть изолированная QA-ветка)
  get mode() { return (this.qaDbUrl || this.qaTenantId || this.stagingApi) ? 'full' : 'safe'; },
  // Деструктив РАЗРЕШЁН только при изолированной QA-ветке — НИКОГДА против прод-пула.
  get allowDestructive() { return !!this.qaDbUrl; },

  // Пути хранения
  dataDir: require('path').join(__dirname, 'data'),
  artifactsDir: require('path').join(__dirname, 'artifacts'),

  // Loop
  cycleCooldownMs: Number(process.env.QA_COOLDOWN_MS || 180000), // пауза между циклами: 3 мин — без неё циклы молотят нон-стоп и сервер дважды падал от исчерпания процессов (02.07)
  scenarioDedupWindowH: 12, // не повторять идентичный сценарий чаще, чем раз в N часов
};

module.exports = cfg;
