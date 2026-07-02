/* РОСТЕР 13 AI-агентов из ТЗ → их реальный статус и что они покрывают.
   Честная карта: ready (работает сейчас) | gated (ждёт изолированный staging-таргет) | meta.
   Никакой имитации: gated-агенты в safe-режиме делают что МОГУТ безопасно и помечают остальное needs-manual. */
module.exports = [
  { role: 'AI Administrator',      agent: 'schedule-integrity', status: 'ready',  covers: 'запись, календарь, двойные брони, длительность визита' },
  { role: 'AI Master',             agent: 'data-integrity',     status: 'ready',  covers: 'медкарта, формулы, аллергопробы, согласия (целостность)' },
  { role: 'AI Owner',              agent: 'finance-reconciler', status: 'ready',  covers: 'KPI/выручка/касса — сверка cash-контура' },
  { role: 'AI Accountant',         agent: 'finance-reconciler', status: 'ready',  covers: 'касса, сироты платежей, лояльность, сертификаты, зарплата' },
  { role: 'AI Warehouse Manager',  agent: 'data-integrity',     status: 'ready',  covers: 'остатки (отрицательный склад)' },
  { role: 'AI Regression Tester',  agent: 'workflow-trail',     status: 'ready',  covers: 'event-bus, события визитов, перепроверка с доказательством' },
  { role: 'AI API Tester',         agent: 'api-contract',       status: 'ready',   covers: 'контракт схемы + HTTP на staging: коды ответов, валидация тел, утечки ошибок' },
  { role: 'AI Security Tester',    agent: 'security-probe',     status: 'ready', covers: 'RBAC/токен + активные: SQL-инъекция, двойной платёж (в ветке)' },
  { role: 'AI Client',             agent: 'ai-client',          status: 'ready',  covers: 'онлайн-запись, подтверждение, история (целостность)' },
  { role: 'AI Marketing Manager',  agent: 'ai-marketing',       status: 'ready',  covers: 'триггеры, сегменты, кампании (консистентность)' },
  { role: 'AI Load Tester',        agent: 'ai-load',            status: 'ready',  covers: 'массовая генерация в Neon-ветке + замер throughput (8к/с) + очистка' },
  { role: 'AI UX Tester',          agent: 'ai-ux-live',         status: 'ready',  covers: 'живой браузер (Playwright): страницы, клики, JS-ошибки + артефакты (скриншоты, HAR)' },
  { role: 'AI Product Owner',      agent: 'product-owner',      status: 'meta',   covers: 'анализ покрытия, генерация новых сценариев, рост сложности' },
  { role: 'AI Modules Integrity',  agent: 'modules-integrity',  status: 'ready',  covers: 'целостность данных: касса, выплаты, абонементы, отзывы' },
  { role: 'AI Visual Tester',      agent: 'visual-check',       status: 'ready',  covers: 'визуальные нестыковки: съехавшая вёрстка, пустые кнопки, битые картинки, невидимый текст, адаптив (десктоп+телефон)' },
  { role: 'AI Booking Guard',      agent: 'booking-independence', status: 'ready', covers: 'самостоятельность записи без BeautyPro: подтверждённая запись видна мастеру, каталог из нашей БД, нет утечек ошибок' },
];
