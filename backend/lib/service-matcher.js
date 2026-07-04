/* ═══════════════════════════════════════════════════════════════
   Визначення послуги за вільним текстом — БЕЗ ШІ.

   Клієнт пише "манікюр і педикюр" або "стрижка фарбування" →
   матчер нормалізує, шукає за синонімами + збігом слів, повертає
   найкращі послуги і визначає чи це комплекс (кілька послуг разом).

   Чистий, детермінований, без зовнішніх викликів. Працює офлайн.
   ═══════════════════════════════════════════════════════════════ */

// Згортання укр/рус варіантів літер до спільної форми, щоб «мелирование» (рус «и»)
// і «мелірування» (укр «і») збігалися. Застосовується і до запиту, і до назв послуг,
// тому обидва боки завжди в однаковому алфавіті — корінь проблеми «написав, а бот не впізнав».
function foldCyr(t) {
  return String(t)
    .replace(/і/g, 'и').replace(/ї/g, 'и').replace(/й/g, 'и')
    .replace(/є/g, 'е').replace(/ґ/g, 'г').replace(/ы/g, 'и').replace(/ъ/g, '');
}
// Згорнути ключі+значення словника (бо токени запиту вже згорнуті)
function foldMap(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[foldCyr(k)] = foldCyr(v);
  return out;
}

// Часті опечатки / варіанти написання → канон (укр/рус мікс реальних даних салону)
const TYPO_MAP = foldMap({
  'нарущування': 'нарощування',
  'бовирівювання': 'біовирівнювання',
  'біовирівнювання': 'біовирівнювання',
  'контуринг': 'контурінг',
  'манік': 'манікюр', 'маник': 'манікюр', 'маникюр': 'манікюр',
  'педик': 'педикюр', 'педикюр': 'педикюр',
  'шеллак': 'шелак', 'shellac': 'шелак',
});

// Категорія → ключові слова (корені). Дає буст послугам цієї категорії.
const CATEGORY_KEYWORDS = (() => {
  const raw = {
    'Нігті':        ['манікюр', 'педикюр', 'нігт', 'ногт', 'гель', 'шелак', 'френч', 'покритт', 'nail', 'зняття гель'],
    'Волосся':      ['волос', 'стрижк', 'фарб', 'мелір', 'тон', 'укладк', 'вклад', 'завивк', 'вирівнюван', 'контурінг', 'ботокс волос', 'кератин', 'hair'],
    'Брови та вії': ['бров', 'брів', 'вій', 'вії', 'ресн', 'нарощуван', 'ламінуван', 'lash', 'lamination'],
    'Макіяж':       ['макіяж', 'макі', 'визаж', 'makeup', 'make up', 'мейк'],
    'Масаж':        ['масаж', 'massage', 'sculpt', 'лімфо', 'lymph', 'обличч масаж'],
    'Депіляція':    ['депіл', 'шугар', 'воск', 'wax', 'епіл'],
  };
  const out = {};
  for (const [cat, kws] of Object.entries(raw)) out[cat] = kws.map(foldCyr);
  return out;
})();

// Загальні синоніми: слово клієнта → корінь що зустрічається в назвах
const WORD_SYNONYMS = foldMap({
  'ногти': 'нігт', 'ногтей': 'нігт', 'ноготь': 'нігт', 'ногтях': 'нігт',
  'ресницы': 'вій', 'ресниц': 'вій', 'реснички': 'вій', 'вії': 'вій', 'вия': 'вій',
  'брови': 'брів', 'бровь': 'брів', 'бровей': 'брів', 'бровки': 'брів',
  'волосы': 'волос', 'стрижка': 'стрижк', 'покраска': 'фарб', 'окрашивание': 'фарб',
  'маникюр': 'манікюр', 'педикюр': 'педикюр',
  'покрытие': 'покритт', 'наращивание': 'нарощуван', 'ламинирование': 'ламінуван',
  'макияж': 'макіяж', 'массаж': 'масаж', 'мелирование': 'мелір', 'мелировка': 'мелір',
  'тонирование': 'тон', 'завивка': 'завивк', 'укладка': 'укладк',
  'выравнивание': 'вирівнюван', 'выпрямление': 'вирівнюван', 'биовыравнивание': 'вирівнюван',
  'выпрямление волос': 'вирівнюван', 'стрижки': 'стрижк', 'окрашивания': 'фарб',
  // розмовні дієслова («хочу пофарбуватись», «підстригтись») → корінь послуги
  'пофарбуватись': 'фарб', 'пофарбуватися': 'фарб', 'пофарбувати': 'фарб', 'фарбуватись': 'фарб',
  'покраситься': 'фарб', 'покраситись': 'фарб', 'покрасить': 'фарб', 'краситься': 'фарб',
  'підстригтись': 'стрижк', 'підстригтися': 'стрижк', 'постригтись': 'стрижк', 'постричься': 'стрижк',
  'підстригти': 'стрижк', 'постричь': 'стрижк',
  'наростити': 'нарощуван', 'нарастити': 'нарощуван', 'нарастить': 'нарощуван',
  // назви стрижок / зачісок → корінь «стрижк» (клієнт пише стиль, а не слово «стрижка»)
  'каре': 'стрижк', 'боб': 'стрижк', 'боб-каре': 'стрижк', 'каскад': 'стрижк',
  'пікси': 'стрижк', 'пикси': 'стрижк', 'шегги': 'стрижк', 'шеги': 'стрижк',
  'гарсон': 'стрижк', 'аврора': 'стрижк', 'сессон': 'стрижк', 'сесон': 'стрижк',
  'чубчик': 'стрижк', 'чёлка': 'стрижк', 'челка': 'стрижк', 'гривка': 'стрижк',
  'кончики': 'стрижк', 'кінчики': 'стрижк', 'подстричься': 'стрижк',
});

// Сполучники що розділяють кілька послуг у комплекс.
// Символи (+ , ; &) — з будь-якими пробілами. Слова-сполучники (і/та/и/плюс/and) —
// ТІЛЬКИ оточені пробілами (\b у JS не працює з кирилицею, тому явні \s).
const COMBO_SPLIT = /\s*[+,;&]\s*|\s+(?:і|та|и|плюс|and)\s+/gi;

// Стоп-слова (шум, не впливають на матч)
const STOP = new Set(['на', 'в', 'у', 'до', 'для', 'з', 'із', 'та', 'і', 'и', 'the', 'a', 'мені', 'хочу', 'треба',
  'будь', 'ласка', 'запис', 'записатись', 'послуга', 'послугу', 'зробити', 'довжина', 'робота', 'матеріал']
  .map(w => w.replace(/і/g, 'и').replace(/ї/g, 'и').replace(/й/g, 'и').replace(/є/g, 'е').replace(/ґ/g, 'г').replace(/ы/g, 'и').replace(/ъ/g, '')));

function normalize(s) {
  if (!s) return '';
  let t = String(s).toLowerCase().trim();
  t = t.replace(/ё/g, 'е').replace(/[`'’ʼ"]/g, '');
  t = t.replace(/[^a-zа-яіїєґ0-9\s\+\,\;\&]/gi, ' ');
  t = foldCyr(t); // зводимо укр/рус літери до спільної форми (і↔и, ї, є, ґ, ы)
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// Токени слова з врахуванням опечаток та синонімів
function tokenize(s) {
  const norm = normalize(s);
  const raw = norm.split(/\s+/).filter(Boolean);
  const out = [];
  for (let w of raw) {
    if (STOP.has(w)) continue;
    if (TYPO_MAP[w]) w = TYPO_MAP[w];
    if (WORD_SYNONYMS[w]) w = WORD_SYNONYMS[w];
    if (w.length >= 2) out.push(w);
  }
  return out;
}

// Чи токен запиту "покриває" слово назви: префіксний збіг по кореню (>=4 симв) або входження
function tokenHit(qTok, nameNorm) {
  if (qTok.length >= 4) {
    // корінь: беремо перші 4-5 символів, шукаємо в назві
    const stem = qTok.slice(0, Math.max(4, qTok.length - 2));
    if (nameNorm.includes(stem)) return true;
  }
  return nameNorm.includes(qTok);
}

function detectCategory(qTokens) {
  let best = null, bestScore = 0;
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const t of qTokens) {
      for (const kw of kws) {
        if (t.startsWith(kw.slice(0, 4)) || kw.includes(t.slice(0, 4))) { score++; break; }
      }
    }
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return bestScore > 0 ? best : null;
}

// Скоринг однієї послуги проти токенів запиту
function scoreService(qTokens, svc) {
  const nameNorm = svc._norm;
  if (!qTokens.length) return 0;
  let hits = 0;
  for (const t of qTokens) if (tokenHit(t, nameNorm)) hits++;
  if (!hits) return 0;
  const coverage = hits / qTokens.length;          // скільки слів запиту знайдено
  // специфічність: яку частку НАЗВИ покрив запит. Коротка точна назва ("Стрижка")
  // виграє у довгого комплексу ("Мелірування + тонування + стрижка").
  const specificity = hits / Math.max(1, svc._tokCount);
  const cat = svc.category || '';
  const catBoost = (detectCategory(qTokens) === cat) ? 0.15 : 0;
  return coverage * 0.7 + specificity * 0.45 + catBoost;
}

// Підготувати індекс послуг (нормалізовані назви) один раз
function buildIndex(services) {
  return services.map(s => {
    const nm = (s.name || '');
    const _norm = normalize(nm);
    return { ...s, _norm, _tokCount: _norm.split(' ').length };
  });
}

// Головна функція: текст → { isCombo, parts: [{ query, matches }], category }
function match(query, indexedServices, { perPart = 5, minScore = 0.34 } = {}) {
  const rawParts = String(query || '').split(COMBO_SPLIT).map(p => p.trim()).filter(Boolean);
  const parts = (rawParts.length ? rawParts : [query]).map(p => {
    const qTokens = tokenize(p);
    const scored = indexedServices
      .map(s => ({ service: s, score: scoreService(qTokens, s) }))
      .filter(x => x.score >= minScore)
      .sort((a, b) => b.score - a.score);
    // дедуп майже однакових назв (залишаємо найдешевшу/першу за рангом)
    const seen = new Set();
    const matches = [];
    for (const x of scored) {
      const key = x.service._norm.replace(/\d+\s*-?\s*\d*\s*довжин\w*/g, '').replace(/premium|led/g, '').trim().slice(0, 24);
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        id: x.service.id, name: x.service.name, price: x.service.price,
        duration_min: x.service.duration_min, category: x.service.category,
        score: Math.round(x.score * 100) / 100,
      });
      if (matches.length >= perPart) break;
    }
    return { query: p, tokens: qTokens, matches };
  });

  const isCombo = parts.length > 1 && parts.filter(p => p.matches.length).length > 1;
  const category = detectCategory(tokenize(query));
  return { isCombo, category, parts };
}

module.exports = { normalize, tokenize, detectCategory, buildIndex, match, CATEGORY_KEYWORDS };
