/* ═══════════════════════════════════════════════════════════════
   Імпорт візитів з вивантаження Букон (стара CRM) → appointments.
   Чисті функції (без БД) — парсинг файлу, нормалізація, зіставлення.
   Використовує routes/visits-import.js для preview (dry-run) та apply.

   Формат вивантаження (лист "Worksheet"), колонки:
   0 Дата("дд.мм.рр гг:хв") 1 Співробітник("Ім'я (роль)") 2 Послуги/Товари(через кому)
   3 Клієнт 4 Оцінка 5 Статус 6 Тривалість 7 Ціна,uah 8 Тип оплати 9 Кешбек
   ═══════════════════════════════════════════════════════════════ */

// Статуси Букон → статуси appointments нашої CRM.
// (Букон пише російсько/укр змішано — ловимо обидва варіанти.)
const STATUS_MAP = {
  'пришел': 'done', 'прийшов': 'done', 'виконано': 'done',
  'скасовано': 'cancelled', 'отменен': 'cancelled', 'отменён': 'cancelled',
  'записан': 'booked', 'записаний': 'booked',
  'подтвердил': 'confirmed', 'підтвердив': 'confirmed', 'подтверждён': 'confirmed',
  'не пришел': 'noshow', 'не прийшов': 'noshow', 'неявка': 'noshow',
  'отказался': 'cancelled', 'відмовився': 'cancelled',
};

function mapStatus(raw) {
  const k = String(raw || '').trim().toLowerCase();
  return STATUS_MAP[k] || null; // null → невідомий статус (це помилка імпорту, покажемо)
}

// "дд.мм.рр гг:хв" → { date:'yyyy-mm-dd', time:'hh:mm', iso:'yyyy-mm-ddThh:mm' } (локальний Київ)
function parseDate(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{2})(?:\s+(\d{1,2}):(\d{2}))?/.exec(String(s || '').trim());
  if (!m) return null;
  const [, dd, mm, yy, hh, mi] = m;
  const date = `20${yy}-${mm}-${dd}`;
  const time = hh != null ? `${String(hh).padStart(2, '0')}:${mi}` : '00:00';
  return { date, time, iso: `${date}T${time}` };
}

// "Кушнерук Тетяна (Майстер манікюра (топ майстер))" → "кушнерук тетяна"
function normMaster(s) {
  return String(s || '').replace(/\s*\(.*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Ролі-спеціалізації, які Букон домішує до імені ("вера колорист", "настя візаж").
const ROLE_WORDS = new Set(['майстер', 'майстра', 'манікюр', 'манікюра', 'маникюр', 'педикюр', 'педікюр',
  'колорист', 'візаж', 'визаж', 'візажист', 'перукар', 'лешмейкер', 'лэшмейкер', 'топ',
  'стиліст', 'стилист', 'косметолог', 'адмін', 'администратор', 'масажист', 'тренер', 'лікар', 'терапевт',
  'брови', 'бровист', 'нігті', 'ногти']);

// Стійкий ключ майстра для зіставлення: слова імені без ролей, відсортовані.
// "Світлана Скібенко" і "Скібенко Світлана" → однаковий ключ "світлана скібенко".
// "вера колорист" → "вера" (роль відкинуто) = "Вера" в базі. Зіставляємо і звільнених майстрів.
function masterKey(s) {
  const words = String(s || '')
    .replace(/\s*\(.*$/, '')
    .toLowerCase()
    .replace(/[^a-zа-яіїєґ'’\s]/gi, ' ')
    .split(/\s+/)
    .filter(w => w && !ROLE_WORDS.has(w));
  return words.sort().join(' ');
}

// нормалізація імені клієнта для зіставлення (регістр, зайві пробіли)
function normClient(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// "Корекція + гель лак, Ремонт нігтя" → ['Корекція + гель лак','Ремонт нігтя']
function splitServices(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}

// Розбір масиву рядків (header:1) з xlsx → нормалізовані візити.
// Повертає { rows:[...], errors:[...] } — errors = рядки що не розпарсились.
function parseRows(rawRows) {
  const out = [], errors = [];
  const body = rawRows.slice(1); // рядок 0 = заголовок
  body.forEach((r, i) => {
    if (!r || !r[0]) return; // порожній рядок
    const d = parseDate(r[0]);
    const status = mapStatus(r[5]);
    const rec = {
      line: i + 2, // номер рядка в файлі (1-based + заголовок)
      raw_date: r[0], date: d ? d.date : null, time: d ? d.time : null, starts_iso: d ? d.iso : null,
      master_raw: r[1], master: normMaster(r[1]),
      services: splitServices(r[2]), services_raw: r[2] || '',
      client_raw: r[3], client: normClient(r[3]),
      status_raw: r[5], status,
      price: Number(r[7]) || 0,
      pay_method: r[8] || null,
      cashback: Number(r[9]) || 0,
    };
    const problems = [];
    if (!d) problems.push('невалідна дата');
    if (!status) problems.push(`невідомий статус "${r[5]}"`);
    if (!rec.master) problems.push('порожній майстер');
    if (problems.length) { errors.push({ line: rec.line, raw: r, problems }); }
    out.push(rec);
  });
  return { rows: out, errors };
}

module.exports = { STATUS_MAP, mapStatus, parseDate, normMaster, masterKey, normClient, splitServices, parseRows };
