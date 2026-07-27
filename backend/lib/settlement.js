/* ═══════════════════════════════════════════════════════════════════════
   settlement.js — ЕДИНЕ джерело правди про «проведений / не проведений візит».

   НАВІЩО ЦЕЙ ФАЙЛ (Босс 26.07, третій випадок поспіль):
   формула «оплачено» жила копіпастою у двох місцях — routes/schedule.js
   (панель «Забули провести») і routes/cashbox.js (звірка каси). Двічі їх
   правили руками, і двічі цифри розходились, бо хтось міняв одну копію.
   Для SaaS це неприпустимо: у кожного нового салону розходження повторилось би.
   Тепер обидві панелі беруть вирази ЗВІДСИ. Правка в одному місці = правка всюди.

   ВАЖЛИВО ДЛЯ SaaS: жодних «магічних» назв систем-джерел у бізнес-логіці.
   Історичний імпорт визначається штатним полем appointments.import_batch,
   яке проставляє будь-який імпортер, а не переліком 'beautypro'/'bukon_import'.
   Список назв лишається лише як сумісність зі старими рядками цього салону.
   ═══════════════════════════════════════════════════════════════════════ */

// Назви джерел до появи import_batch (легасі ЦЬОГО салону). Нові тенанти сюди
// нічого не додають — у них імпорт завжди має import_batch.
const LEGACY_IMPORT_SOURCES = ['beautypro', 'bukon_import', 'migrate'];
// Дата переїзду салону в CRM: візити ДО неї — історія, каса за них лишилась у
// старій системі. Для інших тенантів береться з їх власного налаштування.
const DEFAULT_MIGRATION_DATE = '2026-07-01';

/**
 * «ОПЛАЧЕНО» = будь-який реальний платіж по візиту:
 *   • явний прапор закриття візиту (pay_settled_at), АБО
 *   • пряма касова операція по цьому візиту, АБО
 *   • зафіксований у касі продаж послуги тому ж клієнту тим же майстром того ж дня
 *     (візит провели через продаж, без прив'язки до appointment).
 * @param {string} al — алиас таблиці appointments у запиті
 */
function paidExpr(al) {
  return `(
      ${al}.pay_settled_at IS NOT NULL
      OR EXISTS(SELECT 1 FROM cash_operations co WHERE co.type='in' AND co.ref_type='appointment' AND co.ref_id=${al}.id)
      OR (${al}.bp_client IS NOT NULL AND ${al}.master_id IS NOT NULL AND EXISTS(
            SELECT 1 FROM cash_operations co WHERE co.type='in' AND co.ref_type='bp_sale' AND co.category='sale_service'
              AND co.bp_client=${al}.bp_client AND co.master_id=${al}.master_id
              AND (COALESCE(co.bp_calendar,co.created_at) AT TIME ZONE 'Europe/Kyiv')::date
                  = (${al}.starts_at AT TIME ZONE 'Europe/Kyiv')::date))
    )`;
}

/**
 * ОПЕРАЦІЙНИЙ ВІЗИТ — той, за який салон реально відповідає сьогодні.
 * НЕ операційні (і тому НЕ потрапляють ні в «Забули провести», ні у звірку каси):
 *   • історичний імпорт (import_batch заповнений або легасі-джерело до переїзду) —
 *     гроші за них лишились у попередній системі;
 *   • демо-дані презентації (клієнт з тегом 'demo');
 *   • тестові записи автотестів (ім'я містить test/e2e).
 * @param {string} a — алиас appointments
 * @param {string} c — алиас clients (LEFT JOIN); якщо null — перевірки по клієнту пропускаються
 */
function operationalExpr(a, c, opts = {}) {
  const since = opts.migrationDate || DEFAULT_MIGRATION_DATE;
  const srcList = LEGACY_IMPORT_SOURCES.map((s) => `'${s}'`).join(',');
  const parts = [
    // штатна ознака імпорту — універсальна для будь-якого тенанта
    `${a}.import_batch IS NULL`,
    // сумісність зі старими рядками без import_batch
    `(COALESCE(${a}.source,'') NOT IN (${srcList}) OR ${a}.starts_at >= '${since}')`,
  ];
  if (c) {
    parts.push(`NOT ('demo' = ANY(COALESCE(${c}.tags, '{}'::text[])))`);
    parts.push(`COALESCE(${a}.client_name, ${c}.name, '') NOT ILIKE '%e2e%'`);
    parts.push(`COALESCE(${a}.client_name, ${c}.name, '') NOT ILIKE '%test%'`);
  }
  return '(' + parts.join('\n          AND ') + ')';
}

/**
 * АНТИДУБЛЬ: той самий клієнт у ТОЙ САМИЙ слот має ОПЛАЧЕНУ запис → поточна є дублем.
 * (напр. запис на 850 ₴ booked, а реально оплачено 1000 ₴ тим же майстром о тій годині)
 */
function paidTwinExists(a, tbl = 'appointments') {
  return `EXISTS(
            SELECT 1 FROM ${tbl} b
             WHERE b.id <> ${a}.id AND b.starts_at = ${a}.starts_at
               AND (b.client_id = ${a}.client_id
                    OR lower(btrim(COALESCE(b.client_name,''))) = lower(btrim(COALESCE(${a}.client_name,''))))
               AND ${paidExpr('b')})`;
}

/**
 * НАРАХУВАННЯ % МАЙСТРУ рахується лише по візитах, ЗА ЯКІ САЛОН ПЛАТИТЬ САМ.
 *
 * Чому це ОКРЕМИЙ, вужчий вираз, а не operationalExpr (урок 27.07):
 * operationalExpr викидає ще й легасі-історію BeautyPro до дати переїзду. Для панелей
 * «Забули провести» / звірки каси це правильно. Для ГРОШЕЙ — ні: архівні продажі BeautyPro
 * лежать у нашій касі (cash_operations ref_type='bp_sale') і рахуються у ВИРУЧКУ. Викинути
 * по них ЗП, лишивши виручку, = асиметрія: прибуток червня роздувся б на ~200 тис. з повітря
 * (зловлено живим прогоном ДО викатки).
 * Дані ж мастера міграції (import_batch) каси не мають НІДЕ — вони не у виручці, тому і в
 * ЗП їх бути не повинно. Це і є єдиний чесний виняток.
 * @param {string} a — аліас appointments
 */
function payrollEligibleExpr(a) {
  // ЄДИНИЙ критерій — СИМЕТРІЯ З ВИРУЧКОЮ. Виручка живе в cash_operations. Отже:
  //   • bp_export/bp_gap (source beautypro/bukon_import) — касу МАЮТЬ (bp_sale + прив'язані
  //     операції, живий факт 27.07: 1103 з 1463 і 116 з 233) → їх ЗП рахувати ТРЕБА;
  //   • мастер міграції (source='migrate') каси не створює НІКОЛИ → і ЗП по них бути не може.
  // Перевірено ДВІЧІ до викатки: спершу взяв operationalExpr (червень −200к ЗП при тій самій
  // виручці), потім import_batch IS NULL (червень −36к) — обидва створювали фальшивий прибуток.
  // Цей вираз лишає червень/липень копійка в копійку і б'є рівно по даних мастера міграції.
  return `(COALESCE(${a}.source,'') <> 'migrate')`;
}

module.exports = { paidExpr, operationalExpr, paidTwinExists, payrollEligibleExpr, LEGACY_IMPORT_SOURCES, DEFAULT_MIGRATION_DATE };
