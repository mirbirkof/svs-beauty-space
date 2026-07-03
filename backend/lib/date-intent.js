/* ═══════════════════════════════════════════════════════════════
   Детермінований парсер дати/часу з вільного тексту клієнта.
   «хочу в суботу пофарбуватись після обіду» → { date:'2026-07-05',
   win:[780,1080], cleaned:'хочу пофарбуватись' }

   СВІДОМО без ШІ: помилка тут = запис не на той день. Правила прозорі,
   все що не розпізнано на 100% — повертається null і клієнт обирає кнопками.
   Увага: \b у JS НЕ працює з кирилицею — межі слів задаємо явно.
   ═══════════════════════════════════════════════════════════════ */
const { kyivToday, addDays } = require('./slot-engine');

const L = 'а-яa-zіїєґё'; // «буква» для меж слів
const W = (body) => new RegExp(`(?<![${L}])(?:${body})(?![${L}])`, 'i');

// день тижня: індекс 0=неділя … 6=субота
const DAYS = [
  { i: 1, re: W('(?:(?:в|у)\\s+)?(?:понеділок|понедельник)') },
  { i: 2, re: W('(?:(?:в|у)\\s+)?(?:вівторок|вторник)') },
  { i: 3, re: W('(?:(?:в|у)\\s+)?(?:серед[уаі]|сред[уа])') },
  { i: 4, re: W('(?:(?:в|у)\\s+)?(?:четвер|четверг)') },
  { i: 5, re: W('(?:(?:в|у)\\s+)?(?:п.?ятниц[юяі]|пятниц[уы])') },
  { i: 6, re: W('(?:(?:в|у)\\s+)?(?:субот[уаі]|суббот[уы])') },
  { i: 0, re: W('(?:(?:в|у)\\s+)?(?:неділ[юяі]|воскресень[ея]|воскресенье)') },
];

// вікна часу в хвилинах від півночі
const WINDOWS = [
  { re: W('після\\s*обід[уа]|после\\s*обеда|по\\s*обіді'), win: [13 * 60, 18 * 60] },
  { re: W('зранку|вранці|утром|з\\s*ранку|с\\s*утра|на\\s*ранок'), win: [8 * 60, 12 * 60] },
  { re: W('ввечері|увечері|вечером|звечора|під\\s*вечір|надвечір'), win: [16 * 60, 21 * 60] },
  { re: W('в\\s*обід|днем|вдень|удень'), win: [12 * 60, 15 * 60] },
];

const REL = [
  { d: 2, re: W('післязавтра|послезавтра') },
  { d: 1, re: W('завтра') },
  { d: 0, re: W('сьогодні|сегодня') },
];

// конкретний час: «о 15», «на 15:30», «к 14»
const TIME_RE = new RegExp(`(?<![${L}])(?:о|на|к|в|у)\\s+(\\d{1,2})(?::(\\d{2}))?(?:\\s*(?:год|годин[иу]?))?(?![${L}0-9:])`, 'i');

function parse(text) {
  if (!text) return { date: null, win: null, cleaned: text };
  let t = ' ' + String(text).toLowerCase().replace(/['’ʼ]/g, '.').replace(/\s+/g, ' ').trim() + ' ';
  let date = null, win = null;
  const today = kyivToday();

  for (const r of REL) {
    if (r.re.test(t)) { date = addDays(today, r.d); t = t.replace(r.re, ' '); break; }
  }
  if (!date) {
    for (const w of DAYS) {
      if (w.re.test(t)) {
        const [y, m, d] = today.split('-').map(Number);
        const todayDow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        const diff = (w.i - todayDow + 7) % 7; // 0 = цей же день тижня → сьогодні
        date = addDays(today, diff);
        t = t.replace(w.re, ' ');
        break;
      }
    }
  }

  for (const w of WINDOWS) {
    if (w.re.test(t)) { win = w.win; t = t.replace(w.re, ' '); break; }
  }
  if (!win) {
    const m = t.match(TIME_RE);
    if (m) {
      const h = Number(m[1]), mm = Number(m[2] || 0);
      if (h >= 7 && h <= 21 && mm < 60) {
        win = [Math.max(0, h * 60 + mm - 15), h * 60 + mm + 90]; // «о 15» = 14:45–16:30
        t = t.replace(TIME_RE, ' ');
      }
    }
  }

  const cleaned = t.replace(/\s+/g, ' ').trim();
  return { date, win, cleaned: cleaned || null };
}

module.exports = { parse };
