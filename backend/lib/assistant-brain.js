'use strict';
// «Розуміння питання» для помічника CRM (05.11, Босс: «щоб робот був розумнішим,
// краще розумів логіку питання, знав усю CRM і здогадувався, навіть якщо пояснюють криво»).
// Усе, що можна порахувати КОДОМ, рахуємо тут, а не просимо модель:
//   • таблиця відносних дат («позавчора», «в пʼятницю», «за вихідні») — модель плутала минулу/наступну пʼятницю;
//   • імена майстрів з питання → id (Таня → Тетяна, Лиза → Ліза: ru/uk-написання і зменшувальні);
//   • релевантні розділи карти CRM (lib/assistant-kb.md) — top-N за словами питання, а не вся карта (≈17k токенів).
const fs = require('fs');
const path = require('path');

// ── нормалізація ru/uk: щоб «Лиза» = «Ліза», «Алины» ≈ «Аліна» ──
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/ё/g, 'е').replace(/є/g, 'е').replace(/[іїы]/g, 'и').replace(/э/g, 'е').replace(/ґ/g, 'г')
    .replace(/[ʼ'’`ъь]/g, '');
}
function words(s) { return norm(s).split(/[^a-zа-я0-9]+/).filter(w => w.length >= 3); }
function stem(w) { return w.length > 5 ? w.slice(0, 5) : w; } // псевдо-основа слова для пошуку (не текст для людини)

// ── Карта CRM ──
let _kb = null;
function loadKB() {
  if (_kb) return _kb;
  let raw = '';
  try { raw = fs.readFileSync(path.join(__dirname, 'assistant-kb.md'), 'utf8'); } catch (_) { raw = ''; }
  const parts = raw.split(/\n(?=## )/).filter(p => p.startsWith('## '));
  const secs = parts.map(p => {
    const head = p.split('\n')[0].replace(/^##\s*/, '');
    const key = head.split('|')[0].trim();
    const slova = (p.match(/^СЛОВА:(.*)$/m) || [, ''])[1];
    return {
      key, text: p.trim(),
      kw: new Set(words(slova + ' ' + head).map(stem)),
      all: new Set(words(p).map(stem)),
    };
  });
  const df = new Map();
  for (const s of secs) for (const w of s.all) df.set(w, (df.get(w) || 0) + 1);
  _kb = { secs, df, N: secs.length || 1 };
  return _kb;
}

// pickKB: top-N розділів карти під питання. allowedKey(key) — RBAC-фільтр (недоступні розділи не підмішуємо).
function pickKB(question, allowedKey, n = 4) {
  const { secs, df, N } = loadKB();
  const qs = [...new Set(words(question).map(stem))];
  if (!qs.length) return [];
  const scored = [];
  for (const s of secs) {
    if (allowedKey && !allowedKey(s.key)) continue;
    let sc = 0;
    for (const w of qs) {
      const idf = Math.log(1 + N / (df.get(w) || N));
      if (s.kw.has(w)) sc += 3 * idf; else if (s.all.has(w)) sc += idf;
    }
    if (sc > 0) scored.push([sc, s]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, n).map(x => x[1]);
}

// ── Відносні дати (рахує КОД) ──
const DOW_UK = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'];
const DOW_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
function _d(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function _iso(dt) { return dt.toISOString().slice(0, 10); }
function _add(iso, n) { const t = _d(iso); t.setUTCDate(t.getUTCDate() + n); return _iso(t); }
function dateTable(todayISO) {
  const dow = _d(todayISO).getUTCDay();
  const mon = _add(todayISO, -((dow + 6) % 7));
  const sun = _add(mon, 6);
  const t = _d(todayISO);
  const m1 = _iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)));
  const pm1 = _iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1)));
  const pmEnd = _add(m1, -1);
  const isWeekend = dow === 6 || dow === 0;
  const lastWeekend = isWeekend ? `${_add(mon, 5)}…${sun} (це поточні вихідні)` : `${_add(mon, -2)}…${_add(mon, -1)}`;
  const nextWeekend = isWeekend ? `${_add(mon, 12)}…${_add(mon, 13)}` : `${_add(mon, 5)}…${sun}`;
  const lines = [
    `сьогодні/сегодня = ${todayISO} (${DOW_UK[dow]})`,
    `вчора/вчера = ${_add(todayISO, -1)}; позавчора/позавчера = ${_add(todayISO, -2)}`,
    `завтра = ${_add(todayISO, 1)}; післязавтра/послезавтра = ${_add(todayISO, 2)}`,
    `цей тиждень = ${mon}…${sun}; минулий тиждень = ${_add(mon, -7)}…${_add(mon, -1)}; наступний = ${_add(mon, 7)}…${_add(mon, 13)}`,
    `останні (минулі) вихідні = ${lastWeekend}; найближчі вихідні = ${nextWeekend}`,
    `цей місяць = ${m1}…${todayISO} (до сьогодні); минулий місяць = ${pm1}…${pmEnd}`,
  ];
  const wd = [];
  for (let k = 1; k <= 7; k++) {
    const i = (k % 7); // пн..нд
    const back = (dow - i + 7) % 7; const fwd = (i - dow + 7) % 7;
    const past = back === 0 ? todayISO : _add(todayISO, -back);
    const next = fwd === 0 ? todayISO : _add(todayISO, fwd);
    wd.push(back === 0 ? `${DOW_UK[i]}/${DOW_RU[i]} = СЬОГОДНІ ${todayISO} (минулий: ${_add(todayISO, -7)}, наступний: ${_add(todayISO, 7)})`
      : `${DOW_UK[i]}/${DOW_RU[i]}: минулий ${past}, найближчий ${next}`);
  }
  return lines.join('\n') + '\nДні тижня:\n' + wd.join('\n');
}

// ── Імена майстрів у питанні → id ──
// Зменшувальні/російські форми → можливі основи повного імені (після norm)
const DIMIN = {
  'таня': ['тетян', 'татьян'], 'танечка': ['тетян', 'татьян'], 'татьяна': ['тетян'], 'тетяна': ['татьян'],
  'лиза': ['лиз', 'елизав'], 'лизонька': ['лиз', 'елизав'], 'елизавета': ['лиз'],
  'юля': ['юли'], 'юлечка': ['юли'], 'юлия': ['юли'],
  'алинка': ['алин'],
  'света': ['свитл', 'светл'], 'светлана': ['свитл'], 'свитлана': ['светл'],
  'лера': ['лера', 'валер'], 'валерия': ['лера'],
  'ева': ['евели', 'ева'], 'эвелина': ['евели'],
  'оля': ['ольг', 'оля'], 'катя': ['катер', 'катя'], 'наташа': ['натал', 'наташ'], 'настя': ['анаст', 'настя'],
  'вика': ['викт', 'вика'], 'ира': ['ирин', 'ира'], 'аня': ['анн', 'аня'], 'саша': ['олекс', 'алекс', 'саша'],
  'женя': ['евген', 'женя'], 'даша': ['дари', 'даша'], 'маша': ['мари', 'маша'], 'лена': ['олен', 'елен', 'лена'],
  'галя': ['галин', 'галя'], 'оксана': ['оксан'], 'марина': ['марин'],
};
const DIMIN_N = Object.fromEntries(Object.entries(DIMIN).map(([k, v]) => [norm(k), v.map(norm)]));
const STOP = new Set(['как', 'что', 'чего', 'где', 'кто', 'хто', 'там', 'тут', 'шо', 'чо', 'это', 'ето', 'для', 'при', 'про', 'над', 'под', 'все', 'всех', 'вси', 'сколько', 'скилки', 'скока', 'запис', 'записи', 'записам', 'каса', 'касса', 'мастер', 'майстер']);
function _tokenMatchesName(tok, part) {
  // tok і part — після norm. Відкидаємо відмінкове закінчення: «алины» ~ «алина», «тани» ~ «таня»
  if (tok.length < 3 || part.length < 3) return false;
  const base = (w) => (w.length > 4 ? w.slice(0, w.length - 1) : w.slice(0, 3));
  return base(tok) === base(part) || (tok.length >= 4 && part.startsWith(tok.slice(0, Math.max(4, tok.length - 2))));
}
function matchMasters(question, masters) {
  const toks = words(question).filter(t => !STOP.has(t));
  const hits = [];
  for (const tok of toks) {
    let dimStems = null;
    for (const [k, v] of Object.entries(DIMIN_N)) {
      const kb = k.length >= 4 ? k.slice(0, k.length - 1) : (k === 'юля' ? 'юл' : k);
      if (tok.startsWith(kb) && tok.length <= k.length + 3) { dimStems = v; break; }
    }
    const found = masters.filter(m => {
      const parts = norm(m.name).split(/[^a-zа-я0-9]+/).filter(Boolean);
      return parts.some(p => _tokenMatchesName(tok, p) || (dimStems && dimStems.some(s => p.startsWith(s))));
    });
    if (found.length) hits.push({ word: (String(question).match(new RegExp('[^\\s,.!?;:()«»"]+', 'g')) || []).find(w => norm(w) === tok) || tok, masters: found.map(m => ({ id: m.id, name: m.name })) });
  }
  return hits;
}
function mastersHint(question, masters) {
  const hits = matchMasters(question, masters || []);
  if (!hits.length) return '';
  return hits.map(h => h.masters.length === 1
    ? `«${h.word}» → майстер ${h.masters[0].name} (master_id ${h.masters[0].id})`
    : `«${h.word}» → кілька майстрів: ${h.masters.map(m => `${m.name} (master_id ${m.id})`).join(', ')} — якщо з контексту не ясно, кого саме, коротко перепитай, назвавши варіанти`).join('\n');
}

// ── Народні слова → терміни CRM ──
const SLANG = `НАРОДНІ СЛОВА → ТЕРМІНИ CRM (люди пишуть по-простому, суржиком, з помилками):
• бабки/бабло/гроші/виторг/выручка/наторгували/заробили/скока вышло/капнуло → виручка (get_revenue за період); «каса» за сьогодні/вчора → get_cashbox; «каса» за інший день/період → get_revenue за ці дати
• запис/запись/хто прийде/кто придёт/кого записали/шо по записям/загрузка → журнал записів (get_appointments на дату)
• окошко/віконце/дірка/вільне/свободно/можна втиснути → вільні слоти (get_free_slots)
• зп/зарплатня/получка/аванс/скока мені капнуло → зарплата; премія/накинути/подякувати грошима майстру → add_bonus; штраф/оштрафувати/вирахувати/зняти з майстра → add_penalty
• кешбек/бали/баллы/бонуси клієнта/копилка → бонуси клієнта (картка клієнта); абик/абон/абонік → абонемент; серт/сертик/подарунковий → сертифікат
• расход/витрата/потратили/купили/заплатили за → витрата (create_expense)
• потеряшки/пропали/давно не було/кого дозаписати/обзвон → повторні візити (get_clients_to_rebook)
• ЧС/не пускать/погані клієнти → Чорний список; дубль/двічі клієнт → обʼєднати в картці клієнта
• онлайн/в системі/через бот/сайт/сама записалась → онлайн-запис (бот/вітрина)
• фарба/краска/окисник/шампунь/матеріали/розхідник → Склад (Залишки, Товари); списати → списання матеріалів
• план/норма/скільки до плану → get_month_plan; топ/що найбільше роблять/хіт → get_top_services
• зміна/відкрити касу/закрити день/Z-звіт → каса (зміна); табель/хто вийшов → Зміни; графік/вихідні майстра → Графіки роботи`;

module.exports = { norm, pickKB, dateTable, matchMasters, mastersHint, SLANG, loadKB };
