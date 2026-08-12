/* ═══════════════════════════════════════════════════════
   Движок миграции из сторонних CRM — общая логика.

   Идея: ЛЮБАЯ CRM умеет выгружать данные в CSV/Excel.
   Мы принимаем такой файл, сами определяем ЧТО это (клиенты/
   услуги/мастера), сами сопоставляем колонки по словарю синонимов
   (укр/рус/eng + пресеты популярных CRM) и показываем превью
   ДО записи. Это и даёт «перенос за несколько кликов с любой CRM».

   Здесь: парсер CSV, словари полей по сущностям, авто-определение
   сущности, пресеты источников. Запись — в routes/migrate.js.
   ═══════════════════════════════════════════════════════ */

// ── Парсер CSV: кавычки, экранированные "", переводы строк в кавычках, BOM, разделитель , или ; ──
function parseCsv(text) {
  const raw = String(text || '').replace(/^\ufeff/, '');
  // Авто-детект разделителя: берём первую строку, считаем ; vs ,
  const firstLine = raw.slice(0, raw.indexOf('\n') >= 0 ? raw.indexOf('\n') : raw.length);
  const delim = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') { if (raw[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === delim) { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

// ── Словари полей по сущностям ──
// key — каноничное поле в нашей БД; required — обязательный ключ для записи.
const ENTITIES = {
  clients: {
    label: 'Клієнти',
    key: ['phone', 'name'], // достаточно одного
    fields: {
      phone: ['phone', 'телефон', 'тел', 'mobile', 'номер', 'phone number', 'тел.', 'номер телефону', 'номер телефона', 'моб', 'моб.', 'мобільний', 'мобильный', 'контакт', 'cell'],
      name: ['name', 'имя', "ім'я", 'имя клиента', 'клиент', 'клієнт', 'фио', 'фіо', 'full name', 'клиент фио', "ім’я", 'піб', 'п і б', 'прізвище імя', 'фамилия имя'],
      email: ['email', 'почта', 'пошта', 'e-mail', 'mail', 'эл. почта'],
      birthday: ['birthday', 'birth', 'дата рождения', 'др', 'день народження', 'дн', 'дата народження', 'birthdate'],
      source: ['source', 'источник', 'джерело', 'откуда узнали'],
      notes: ['notes', 'note', 'заметки', 'нотатки', 'коментар', 'комментарий', 'примечание', 'комментарии'],
      tags: ['tags', 'теги', 'метки', 'мітки', 'категория клиента'],
    },
  },
  services: {
    label: 'Послуги',
    key: ['name'],
    fields: {
      name: ['name', 'услуга', 'послуга', 'назва', 'название', 'service', 'наименование', 'найменування', 'назва послуги', 'название услуги'],
      category: ['category', 'категория', 'категорія', 'группа', 'група', 'раздел', 'розділ', 'тип'],
      duration_min: ['duration', 'длительность', 'тривалість', 'время', 'час', 'минут', 'хвилин', 'duration_min', 'длит', 'продолжительность', 'тривалість (хв)'],
      price: ['price', 'цена', 'ціна', 'стоимость', 'вартість', 'сумма', 'cost', 'прайс', 'вартість, грн', 'цена, грн'],
      description: ['description', 'описание', 'опис', 'комментарий', 'примечание'],
    },
  },
  visits: {
    label: 'Візити (історія)',
    key: ['date', 'client'],
    fields: {
      date: ['date', 'дата', 'дата візиту', 'дата визита', 'дата и время', 'дата й час', 'datetime', 'дата/час', 'дата время', 'visit date', 'дата запису', 'дата записи', 'дата и время визита', 'начало', 'початок', 'время визита'],
      client: ['client', 'клиент', 'клієнт', 'имя клиента', "ім'я клієнта", 'фио', 'фіо', 'customer', 'client name', 'піб', 'п і б'],
      phone: ['phone', 'телефон', 'тел', 'номер', 'mobile', 'номер телефону', 'номер телефона'],
      master: ['master', 'мастер', 'майстер', 'співробітник', 'сотрудник', 'специалист', 'спеціаліст', 'фахівець', 'employee', 'исполнитель', 'виконавець', 'работник', 'працівник', 'staff'],
      service: ['service', 'услуга', 'послуга', 'услуги', 'послуги', 'услуги / товары', 'услуги/товары', 'послуги/товари', 'послуги / товари', 'services', 'назва послуги', 'процедура', 'наименование услуги'],
      price: ['price', 'цена', 'ціна', 'стоимость', 'вартість', 'сумма', 'сума', 'ціна, uah', 'цена, uah', 'ціна,uah', 'цена,uah', 'ціна uah', 'cost', 'total', 'сума, грн', 'сума грн', 'до сплати'],
      status: ['status', 'статус', 'стан', 'state', 'статус визита', 'статус візиту'],
      // Час початку ОКРЕМОЮ колонкою — так вивантажують більшість CRM («Дата» + «Час»).
      // Раніше такої колонки не було, «Время» падало в duration, і ВСІ перенесені візити
      // ставали на 12:00 — розклад майстра після міграції перетворювався на кашу (26.07).
      // 'начало'/'початок' свідомо НЕ тут: вони лишаються за полем date (там це часто
      // повний datetime «01.07.2026 14:30»). Дублювання зробило б розпізнавання лотереєю.
      time: ['time', 'час', 'время', 'час візиту', 'время визита', 'час запису', 'время записи', 'час початку', 'время начала'],
      duration: ['duration', 'тривалість', 'длительность', 'хвилин', 'минут', 'тривалість, хв', 'тривалість (хв)'],
      rating: ['rating', 'оцінка', 'оценка', 'відгук'],
      payment: ['payment', 'тип оплати', 'тип оплаты', 'оплата', 'спосіб оплати', 'способ оплаты', 'метод оплати'],
    },
  },
  products: {
    label: 'Товари і залишки',
    key: ['name'],
    fields: {
      name: ['name', 'товар', 'назва', 'название', 'наименование', 'найменування', 'product', 'назва товару', 'название товара'],
      sku: ['sku', 'артикул', 'арт', 'арт.', 'код', 'code', 'штрихкод', 'barcode'],
      category: ['category', 'категория', 'категорія', 'группа', 'група', 'тип', 'розділ'],
      qty: ['qty', 'залишок', 'остаток', 'кількість', 'количество', 'кол-во', 'к-сть', 'stock', 'на складі', 'на складе', 'шт'],
      wholesale: ['wholesale', 'опт', 'себестоимость', 'собівартість', 'себе', 'закупка', 'закупівля', 'cost', 'ціна закупки', 'цена закупки'],
      price: ['price', 'цена', 'ціна', 'роздріб', 'розница', 'продаж', 'retail', 'ціна продажу', 'цена продажи'],
      unit: ['unit', 'одиниця', 'единица', 'од', 'ед', 'од.вим', 'ед.изм'],
      volume: ['volume', 'обʼєм', 'объем', 'мл', 'ml', 'вага', 'вес', 'грам', 'фасування', 'фасовка'],
    },
  },
  masters: {
    label: 'Майстри',
    key: ['name'],
    fields: {
      name: ['name', 'имя', "ім'я", 'мастер', 'майстер', 'специалист', 'спеціаліст', 'сотрудник', 'співробітник', 'фио', 'фіо', 'employee', 'піб', 'п і б', 'прізвище імя', 'фамилия имя'],
      phone: ['phone', 'телефон', 'тел', 'тел.', 'mobile', 'номер', 'моб', 'моб.', 'мобільний', 'мобильный', 'номер телефону', 'номер телефона', 'cell'],
      email: ['email', 'почта', 'пошта', 'e-mail', 'mail'],
      specialty: ['specialty', 'специальность', 'спеціальність', 'должность', 'посада', 'специализация', 'спеціалізація', 'position', 'напрямок', 'напрям'],
      surname: ['surname', 'фамилия', 'прізвище', 'last name'],
    },
  },
};

// ── Пресеты источников: подсказки/особенности по конкретным CRM ──
// Авто-маппинг работает по словарю синонимов выше, пресеты — для UI-подсказок
// и дополнительных синонимов под конкретный экспорт.
const ALL_ENTITIES = ['clients', 'visits', 'products', 'services', 'masters'];
const SOURCE_PRESETS = [
  { id: 'generic', label: 'Інша CRM / Excel / Google Sheets', hint: 'Підійде будь-який експорт у CSV або .xlsx. Стовпці визначимо автоматично, помилку можна поправити вручну.', entities: ALL_ENTITIES },
  { id: 'dikidi', label: 'DIKIDI', hint: 'Кабінет → Клієнти → Експорт, і Журнал записів → Експорт. Беремо .xlsx напряму — переносимо клієнтів і всю історію візитів за всі роки.', entities: ALL_ENTITIES },
  { id: 'bukon', label: 'Букон', hint: 'Звіти → Візити → Вивантажити. Формат «Дата / Співробітник / Послуги / Клієнт / Статус / Ціна» розпізнається з коробки.', entities: ALL_ENTITIES },
  { id: 'yclients', label: 'YCLIENTS / Altegio', hint: 'Налаштування → Експорт даних → CSV: клієнти, записи, послуги, товари.', entities: ALL_ENTITIES },
  { id: 'excel', label: 'Власна таблиця Excel', hint: 'Будь-яка таблиця з колонками. Перший рядок — назви стовпців.', entities: ALL_ENTITIES },
];

// Нормалізація заголовка: регістр, пробіли, пунктуація, ё→е, різнобій апострофів.
// «ПІБ клієнта:» / «Ф.И.О. клиента» / «имʼя  клієнта» → однакова основа для порівняння.
function normHeader(h) {
  return String(h || '')
    .replace(/[’'`´]/g, "'")
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.:;,_/\\|()\[\]{}"«»*#№]/g, ' ')
    .replace(/-/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    // «ф и о» → «фио», «п и б» → «піб»: після зняття крапок абревіатура розсипається
    // на окремі літери й перестає збігатись зі словником (реальний заголовок «Ф.И.О.»).
    .replace(/(^| )((?:[а-яa-zіїєґ] ){1,3}[а-яa-zіїєґ])(?= |$)/g, (m, pre, abbr) => pre + abbr.replace(/ /g, ''));
}

// Чи міститься синонім у заголовку ЯК ОКРЕМЕ СЛОВО (а не всередині іншого слова).
// «дата народження» ⊂ «дата народження клієнта» → так. «ім'я» ⊄ «прізвище» → ні.
function containsWord(haystack, needle) {
  if (!needle) return false;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^| )' + esc + '( |$)').test(haystack);
}

/* Сопоставить один заголовок с полем сущности.
   ДВА ПРОХОДИ — навмисно (Jarvis 26.07):
   раніше було лише точне співпадіння зі словником, тому «ФИО клиента» не збігалось
   із 'фио' і колонка ТИХО ігнорувалась — салон переносив клієнтів БЕЗ імен і дізнавався
   про це вже після імпорту. Для SaaS це неприпустимо: кожна CRM називає колонки по-своєму.
   Тепер: 1) точний збіг (найнадійніший), 2) якщо ні — синонім як окреме слово всередині
   заголовка; з кількох кандидатів беремо НАЙДОВШИЙ (найспецифічніший), щоб «дата запису»
   не перетворилась на «дата» від іншого поля. */
function mapHeaderFor(entity, h, opts = {}) {
  const norm = normHeader(h);
  if (!norm) return null;
  const fields = ENTITIES[entity].fields;
  const taken = opts.taken || new Set();
  for (const [field, syn] of Object.entries(fields)) {
    if (syn.some((s) => normHeader(s) === norm)) return field;
  }
  let best = null, bestLen = 0;
  for (const [field, syn] of Object.entries(fields)) {
    if (taken.has(field)) continue;      // поле вже зайняте точним збігом — не перебиваємо
    for (const s of syn) {
      const ns = normHeader(s);
      if (ns.length < 3) continue;       // короткі ('др','тел') лише точним збігом — інакше шум
      if (containsWord(norm, ns) && ns.length > bestLen) { best = field; bestLen = ns.length; }
    }
  }
  return best;
}

// Карта колонок для сущности: индекс → каноничное поле (или null).
// Спочатку розставляємо ТОЧНІ збіги по всьому рядку, і лише потім — нечіткі,
// щоб точний збіг завжди мав пріоритет над «схожим» у сусідній колонці.
function buildColMap(entity, headerRow) {
  const exact = headerRow.map((h) => {
    const norm = normHeader(h);
    if (!norm) return null;
    for (const [field, syn] of Object.entries(ENTITIES[entity].fields)) {
      if (syn.some((s) => normHeader(s) === norm)) return field;
    }
    return null;
  });
  const taken = new Set(exact.filter(Boolean));
  return exact.map((f, i) => {
    if (f) return f;
    const guess = mapHeaderFor(entity, headerRow[i], { taken });
    if (guess && !taken.has(guess)) { taken.add(guess); return guess; }
    return null;
  });
}

// Авто-определение сущности по строке заголовков: у кого больше совпадений.
function detectEntity(headerRow) {
  let best = null, bestScore = 0;
  for (const entity of Object.keys(ENTITIES)) {
    const map = buildColMap(entity, headerRow);
    const score = map.filter(Boolean).length;
    // бонус за наличие ключевого поля
    const hasKey = ENTITIES[entity].key.some(k => map.includes(k));
    const total = score + (hasKey ? 2 : 0);
    if (total > bestScore) { bestScore = total; best = entity; }
  }
  return bestScore >= 2 ? best : null;
}

function toDateOrNull(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

// Число из строки с мусором («1 200 грн», «150,00») → Number | null
function toNumberOrNull(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/[^\d.,-]/g, '').replace(/\s/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  parseCsv, ENTITIES, SOURCE_PRESETS,
  mapHeaderFor, buildColMap, detectEntity, toDateOrNull, toNumberOrNull, normHeader,
};
