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
      name: ['name', 'имя', "ім'я", 'имя клиента', 'клиент', 'клієнт', 'фио', 'фіо', 'full name', 'клиент фио', "ім’я"],
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
  masters: {
    label: 'Майстри',
    key: ['name'],
    fields: {
      name: ['name', 'имя', "ім'я", 'мастер', 'майстер', 'специалист', 'спеціаліст', 'сотрудник', 'співробітник', 'фио', 'фіо', 'employee'],
      phone: ['phone', 'телефон', 'тел', 'mobile', 'номер'],
      email: ['email', 'почта', 'пошта', 'e-mail', 'mail'],
      specialty: ['specialty', 'специальность', 'спеціальність', 'должность', 'посада', 'специализация', 'спеціалізація', 'position'],
      surname: ['surname', 'фамилия', 'прізвище', 'last name'],
    },
  },
};

// ── Пресеты источников: подсказки/особенности по конкретным CRM ──
// Авто-маппинг работает по словарю синонимов выше, пресеты — для UI-подсказок
// и дополнительных синонимов под конкретный экспорт.
const SOURCE_PRESETS = [
  { id: 'generic', label: 'Інша CRM / Excel / Google Sheets', hint: 'Підійде будь-який експорт у CSV. Стовпці визначимо автоматично.', entities: ['clients', 'services', 'masters'] },
  { id: 'beautypro', label: 'BeautyPro', hint: 'Експорт клієнтів/послуг у CSV, або пряме підтягування через API (у Інтеграціях).', entities: ['clients', 'services', 'masters'] },
  { id: 'dikidi', label: 'DIKIDI', hint: 'Кабінет → Експорт → клієнти/послуги у Excel, збережіть як CSV.', entities: ['clients', 'services'] },
  { id: 'yclients', label: 'YCLIENTS / Altegio', hint: 'Налаштування → Експорт даних → CSV.', entities: ['clients', 'services', 'masters'] },
  { id: 'excel', label: 'Власна таблиця Excel', hint: 'Будь-яка таблиця з колонками. Перший рядок — назви стовпців.', entities: ['clients', 'services', 'masters'] },
];

function normHeader(h) { return String(h || '').trim().toLowerCase().replace(/\s+/g, ' '); }

// Сопоставить один заголовок с полем заданной сущности
function mapHeaderFor(entity, h) {
  const norm = normHeader(h);
  const fields = ENTITIES[entity].fields;
  for (const [field, syn] of Object.entries(fields)) {
    if (syn.includes(norm)) return field;
  }
  return null;
}

// Карта колонок для сущности: индекс → каноничное поле (или null)
function buildColMap(entity, headerRow) {
  return headerRow.map(h => mapHeaderFor(entity, h));
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
