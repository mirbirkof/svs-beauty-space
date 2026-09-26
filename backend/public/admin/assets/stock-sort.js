/* stock-sort.js — ЄДИНИЙ порядок складу та інвентаризації (26.09, Бос: «в складі й інвентаризації має бути
   нормальне сортування… і по брендах, по типу»). Один файл на сервер (require через lib/stock-sort.js)
   і на всі екрани (склад салону, склад магазину, акт салону, акт магазину) — щоб порядок ніде не розʼїхався.

   Порядок за замовчуванням: ТИП (Фарба → Окисник → … → Інше) → БРЕНД (за абеткою, «Інше» і «без бренду» в кінці)
   → НАЗВА по-людськи → обʼєм/варіант.
   «По-людськи» = без різниці регістру й зайвих пробілів («SOCOLOR  9M » = «socolor 9m»), числа — як ЧИСЛА:
   тони 1.0 < 3.0 < 5.0 < 6.04 < 7.46 < 10.1 < 100 < 1002 (текстом було «10.1» < «1002» < «3.0»);
   «6,04» = «6.04»; «03» = «3.0» за значенням (далі за написанням); голий тон іде перед підсерією («extremo 9.1»
   перед «extremo acid 9.02»). Порожня назва — в кінці своєї групи, не ламає сортування. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StockSort = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── нормалізація назви ──
  function norm(s) {
    return String(s == null ? '' : s)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/(\d),(\d)/g, '$1.$2')      // 6,04 → 6.04
      .replace(/[’'`ʼ]/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  // шматки: текст / число. «extremo 6.04» → ['extremo ', 6.04]; «st13.68» → ['st', 13.68]
  const CHUNK = /(\d+(?:\.\d+)?)/;
  const _cache = new Map();
  function chunks(s) {
    const k = norm(s);
    let c = _cache.get(k);
    if (c) return c;
    c = k.split(CHUNK).filter(x => x !== '').map(x => (/^\d/.test(x) ? { n: parseFloat(x), raw: x } : { t: x.trim() })).filter(x => x.t !== '');
    if (_cache.size > 20000) _cache.clear();
    _cache.set(k, c);
    return c;
  }

  const collator = (typeof Intl !== 'undefined' && Intl.Collator) ? new Intl.Collator('uk', { sensitivity: 'base' }) : null;
  const cmpText = (a, b) => (collator ? collator.compare(a, b) : (a < b ? -1 : a > b ? 1 : 0));

  // натуральне порівняння двох назв (регістр/пробіли не важать, числа — за значенням)
  function naturalCompare(a, b) {
    const A = chunks(a), B = chunks(b);
    if (!A.length || !B.length) return (A.length ? -1 : 0) + (B.length ? 1 : 0); // порожні — в кінці
    const n = Math.min(A.length, B.length);
    for (let i = 0; i < n; i++) {
      const x = A[i], y = B[i];
      const xn = x.n !== undefined, yn = y.n !== undefined;
      if (xn && yn) { if (x.n !== y.n) return x.n < y.n ? -1 : 1; continue; }
      if (xn !== yn) return xn ? -1 : 1;            // число раніше за слово: «extremo 9.1» < «extremo acid»
      const c = cmpText(x.t, y.t);
      if (c) return c;
    }
    if (A.length !== B.length) return A.length < B.length ? -1 : 1;
    // однакові за значенням («03» і «3.0», «socolor 9m» і «SOCOLOR 9M») — стабільно за написанням
    const ra = norm(a), rb = norm(b);
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  }

  // ── ТИП товару (для людей). Порядок у списку = порядок груп на складі ──
  const TYPES = ['Фарба', 'Знебарвлення', 'Окисник', 'Пігмент', 'Шампунь', 'Кондиціонер', 'Маска', 'Догляд',
                 'Термозахист', 'Стайлінг', 'Завивка', 'Набір', 'Інструмент', 'Інше'];
  const TYPE_ORDER = Object.fromEntries(TYPES.map((t, i) => [t, i]));

  // стара категорія магазину → тип (категорії вітрини НЕ змінюються, тип живе окремо в products.attrs.type)
  const CATEGORY_TYPE = {
    coloring: 'Фарба', krasky: 'Фарба', 'farba-raywell-eterna': 'Фарба',
    bleach: 'Знебарвлення', oxidant: 'Окисник', pigment: 'Пігмент',
    shampoo: 'Шампунь', conditioner: 'Кондиціонер',
    mask: 'Маска', 'maska-na-golovy': 'Маска', toning: 'Маска',
    care: 'Догляд', cream: 'Догляд', spray: 'Догляд', fluid: 'Догляд', serum: 'Догляд', oil: 'Догляд',
    ampoules: 'Догляд', lotion: 'Догляд', repair: 'Догляд', keratin: 'Догляд', scalp: 'Догляд',
    thermal: 'Термозахист', styling: 'Стайлінг', perm: 'Завивка', set: 'Набір', tools: 'Інструмент', accessory: 'Інструмент',
    // змішані категорії (shampuni-masky, raywell-envie-extremo-invidia, materialy) — тип за назвою
  };
  const L = '[^a-zа-яіїєґ0-9]'; // межа слова для кирилиці+латиниці
  const w = (re) => new RegExp('(^|' + L + ')(' + re + ')', 'i');
  // сильні ознаки в назві — важать більше за категорію (у змішаних категоріях лежать і шампуні, і маски)
  const STRONG = [
    ['Набір', w('набір|набор|set' + L + '|set$|kit' + L + '|kit$')],
    ['Інструмент', w('пензл|щітк|гребін|фольг|рукавич|миска|пеньюар|косметичк')],
    ['Термозахист', w('термозах|термоспрей|thermal|heat ?protect')],
    ['Завивка', w('завивк|perm' + L + '|perm$|waving')],
    ['Окисник', w('окисн|окислювач|оксидант|oxy|oxidant|developer')],
    ['Пігмент', w('пігмент|пигмент|pigment')],
    ['Знебарвлення', w('знебарвл|освітлююч|blond(e)? powder|bleach')],
    ['Фарба', w('фарба|фарби|краска|фарбкарт|hair color|toner|тонер')],
  ];
  // вид засобу — перемагає той, що стоїть у назві РАНІШЕ («Маска … після шампуню» = маска)
  const KIND = [
    ['Шампунь', w('шамп|shampoo')],
    ['Кондиціонер', w('конд|conditioner|бальзам')],
    ['Маска', w('маск|mask')],
  ];
  const SOFT = [
    ['Стайлінг', w('лак|hairspray|стайлер|віск|wax|гель для|мус для укладки')],
    ['Догляд', w('ампул|крем|спрей|spray|флюїд|fluid|сироват|серум|serum|олі[йя]|oil|лосьйон|lotion|кристал|скраб|реконст|вода|протеїн|церамід|гідрогель|мус|молочко|філер|filler|treatment|догляд|bond|бонд|keratin|кератин|phases|фазн|10 в 1|all in one')],
    ['Інструмент', w('інструмент')],
  ];
  // тон фарби в кінці назви: 7.46, 1002, 03, 6A, 10Av, 508NA, 9/8, T79, ST13.68 — лише у ваговому товарі
  const TONE = /(^|\s)([a-z]{0,2}\s?\.?\d{1,4}([./]\d{1,3})?[a-zа-я]{0,3}|clear|\.00)(\s*\(ex\s?\d+\))?\s*(ex)?$/i;

  // серії фарб у ваговому товарі (тон може бути складним: «SOCOLOR UL-AA.11»)
  const DYE_SERIES = w('socolor|color sync|sync|synk|eterna|extremo|chromatics|lipure|mster lux|demi cult');

  function detectType(p) {
    p = p || {};
    const fixed = p.attrs && typeof p.attrs === 'object' ? p.attrs.type : null;
    if (fixed && TYPE_ORDER[fixed] !== undefined) return fixed;
    const name = norm(p.name);
    for (const [t, re] of STRONG) if (re.test(name)) return t;
    let best = null, pos = Infinity;
    for (const [t, re] of KIND) { const m = re.exec(name); if (m && m.index < pos) { pos = m.index; best = t; } }
    if (best) return best;
    const byCat = CATEGORY_TYPE[p.category_id];
    // у категоріях фарб на проді лежать і креми/скраби/олійки — явне слово в назві важить більше
    if (byCat === 'Фарба') for (const [t, re] of SOFT) if (re.test(name)) return t;
    if (byCat) return byCat;
    const gram = p.price_per_gram != null || /^(г|гр|за грам|мл\/г)$/i.test(String(p.volume || '').trim());
    for (const [t, re] of SOFT) if (re.test(name)) return t;
    if (gram && (TONE.test(name) || DYE_SERIES.test(name))) return 'Фарба';
    return 'Інше';
  }

  const typeRank = (t) => (TYPE_ORDER[t] !== undefined ? TYPE_ORDER[t] : TYPES.length);
  // бренди за абеткою; «Інше» і «без бренду» — наприкінці групи
  function brandRank(b) { const s = norm(b); return !s ? 2 : (s === 'інше' || s === 'other') ? 1 : 0; }
  function compareBrand(a, b) { return (brandRank(a) - brandRank(b)) || cmpText(norm(a), norm(b)); }

  // РЯДОК складу/акту: { type, brand_name, product_name, volume, id }
  function compareDefault(a, b) {
    return (typeRank(a.type) - typeRank(b.type))
      || compareBrand(a.brand_name, b.brand_name)
      || naturalCompare(a.product_name, b.product_name)
      || naturalCompare(a.volume, b.volume)
      || ((Number(a.id) || 0) - (Number(b.id) || 0));
  }
  function sortDefault(rows) { return rows.slice().sort(compareDefault); }

  return { norm, naturalCompare, detectType, TYPES, CATEGORY_TYPE, typeRank, compareBrand, compareDefault, sortDefault };
});
