/* Регресія розпізнавання колонок при переносі з чужої CRM.
   ЧОМУ ЦЕ Є: 26.07 знайдено, що «ФИО клиента» не збігалось зі словником ('фио')
   і колонка ТИХО ігнорувалась → салон переносив клієнтів без імен. Тихі втрати
   при міграції — найгірший сценарій онбордингу, тому фіксуємо тестом.
   Запуск: node test/migrate-headers.test.js  (без фреймворку, exit 1 при провалі) */
const M = require('../lib/migration-presets');

let failed = 0;
function check(entity, headers, expect) {
  const map = M.buildColMap(entity, headers);
  headers.forEach((h, i) => {
    const want = expect[i];
    const got = map[i];
    if (want !== got) {
      failed++;
      console.log(`  [-] ${entity}: "${h}" → ${got === null ? 'ЗАГУБЛЕНО' : got}, очікували ${want === null ? 'ігнор' : want}`);
    }
  });
}

console.log('── розпізнавання колонок міграції ──');

// Клієнти: різні CRM називають по-різному
check('clients',
  ['ФИО клиента', 'Номер телефона', 'Дата рождения', 'Комментарий'],
  ['name', 'phone', 'birthday', 'notes']);
check('clients',
  ["Ім'я клієнта", 'Мобільний телефон', 'Ел. пошта', 'Нотатки менеджера'],
  ['name', 'phone', 'email', 'notes']);
check('clients',
  ['Client name', 'Phone number', 'E-mail', 'Birthday'],
  ['name', 'phone', 'email', 'birthday']);
check('clients',
  ['Ф.И.О.', 'тел.', 'др'],
  ['name', 'phone', 'birthday']);

// Захист від хибних збігів: службові колонки не повинні чіплятись до полів
check('clients',
  ['ID клиента', 'Статус', 'Дата регистрации'],
  [null, null, null]);

// Послуги і майстри
check('services', ['Название услуги', 'Цена', 'Длительность'], ['name', 'price', 'duration_min']);
check('masters', ["Ім'я майстра", 'Телефон майстра', 'Посада'], ['name', 'phone', 'specialty']);

// Візити: «Дата» і «Час» ОКРЕМИМИ колонками — так вивантажує більшість CRM.
// Раніше «Время» падало в duration → усі перенесені візити ставали на 12:00.
check('visits',
  ['Дата записи', 'Время', 'Клиент ФИО', 'Телефон клиента', 'Услуга', 'Мастер', 'Сумма'],
  ['date', 'time', 'client', 'phone', 'service', 'master', 'price']);
check('visits',
  ['Дата візиту', 'Час початку', 'Клієнт', 'Послуга', 'Майстер', 'Ціна', 'Тривалість'],
  ['date', 'time', 'client', 'service', 'master', 'price', 'duration']);
// Один стовпець «дата і час» — час НЕ має плутатись з тривалістю
check('visits',
  ['Дата и время', 'Клиент', 'Услуга', 'Длительность'],
  ['date', 'client', 'service', 'duration']);

if (failed) { console.log(`РЕЗУЛЬТАТ: ${failed} невідповідностей`); process.exit(1); }
console.log('  [+] усі заголовки розпізнані вірно');
