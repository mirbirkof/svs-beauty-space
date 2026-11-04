'use strict';
// Каталог для Mini App: як клієнт бачить послуги (Босс 04.11).
// Дані послуг у БД НЕ перейменовуються — тут лише вітрина:
//  1) normCategory — злиття синонімів категорій («Перукарські послуги» → «Волосся», «Брови» → «Брови та вії» …);
//  2) serviceGroup — підгрупа всередині великої категорії (Стрижки / Фарбування / … ) для чіпів і заголовків;
//  3) groupCatalog — готова відповідь /api/miniapp/catalog.

const CAT_ORDER = ['Волосся', 'Нігті', 'Брови та вії', 'Макіяж', 'Масаж та тіло'];
const OTHER = 'Інші послуги';

// ключ — нижній регістр без зайвих пробілів; значення — канонічна категорія
const CAT_SYNONYMS = new Map(Object.entries({
  'волосся': 'Волосся', 'перукарські послуги': 'Волосся', 'перукарська послуга': 'Волосся', 'перукарня': 'Волосся',
  'перукар': 'Волосся', 'стрижки': 'Волосся', 'стрижка': 'Волосся', 'фарбування': 'Волосся', 'фарбування волосся': 'Волосся',
  'парикмахерские услуги': 'Волосся', 'волосы': 'Волосся',
  'нігті': 'Нігті', 'манікюр': 'Нігті', 'педикюр': 'Нігті', 'манікюр та педикюр': 'Нігті', 'нігтьовий сервіс': 'Нігті', 'ногти': 'Нігті',
  'брови та вії': 'Брови та вії', 'брови': 'Брови та вії', 'вії': 'Брови та вії', 'брови і вії': 'Брови та вії',
  'брови й вії': 'Брови та вії', 'брови/вії': 'Брови та вії', 'ресницы': 'Брови та вії', 'брови и ресницы': 'Брови та вії',
  'макіяж': 'Макіяж', 'візаж': 'Макіяж', 'макияж': 'Макіяж',
  'масаж та тіло': 'Масаж та тіло', 'масаж': 'Масаж та тіло', 'тіло': 'Масаж та тіло', 'догляд за тілом': 'Масаж та тіло', 'массаж': 'Масаж та тіло',
}));

function normCategory(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!s) return OTHER;
  return CAT_SYNONYMS.get(s.toLowerCase()) || s;
}

// Підгрупи: перший збіг виграє, тож порядок важливий («Фарбування + стрижка» — це фарбування).
const MATERIAL = 'Матеріали до процедур';
const isMaterial = (n) => /(^|[\s(+])матеріал/i.test(n) && !/без[^)]*матеріал/i.test(n);
const GROUPS = {
  'Волосся': [
    ['Фарбування та мелірування', /фарб|мелір|мілір|airtouch|контур|блонд|вихід з чорного|тонуван|балаяж|шатуш/i],
    ['Біовирівнювання та завивка', /біовирівн|біозавив|кератин|ботокс|вирівнюван|завивк/i],
    ['Відновлення та догляд', /відновл|відновал|полірув|догляд|ламінув|маск/i],
    ['Стрижки та укладання', /стриж|кінчик|кончик|чубчик|вкладан|укладан|накрутк|миття|зачіск|локон/i],
  ],
  'Нігті': [
    ['Нарощування та корекція', /нарощ|корекц/i],
    ['Педикюр', /педикюр/i],
    ['Манікюр', /манікюр/i],
    ['Дизайн, ремонт, зняття', /дизайн|ремонт|зняття|укріпл|френч|покриття/i],
  ],
};
const MIN_FOR_GROUPS = 9; // у малих категоріях (≤8) підгрупи лише заважають

function serviceGroup(category, name) {
  const n = String(name || '');
  if (isMaterial(n)) return MATERIAL;
  for (const [g, re] of GROUPS[category] || []) if (re.test(n)) return g;
  return 'Інше';
}

const byName = (a, b) => a.name.localeCompare(b.name, 'uk', { numeric: true, sensitivity: 'base' });

function groupCatalog(services) {
  const cats = new Map();
  for (const s of services || []) {
    const c = normCategory(s.category);
    if (!cats.has(c)) cats.set(c, []);
    const row = { id: s.id, name: String(s.name || '').trim(), duration_min: Number(s.duration_min) || 60, price: Number(s.price) || 0 };
    // price-materials-0411: картка процедури (робота + матеріал, варіанти довжини) — поля проходять як є
    for (const k of ['proc_id', 'price_from', 'price_to', 'price_note', 'variants']) if (s[k] != null) row[k] = s[k];
    cats.get(c).push(row);
  }
  const rank = (c) => { const i = CAT_ORDER.indexOf(c); return i < 0 ? 99 : i; };
  return [...cats.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0], 'uk'))
    .map(([name, list]) => {
      const withGroups = list.length >= MIN_FOR_GROUPS;
      const order = withGroups ? [...(GROUPS[name] || []).map(g => g[0]), 'Інше', MATERIAL] : [];
      for (const s of list) s.group = withGroups ? serviceGroup(name, s.name) : null;
      list.sort((a, b) => (withGroups ? order.indexOf(a.group) - order.indexOf(b.group) : 0) || byName(a, b));
      let groups = [];
      if (withGroups) {
        const cnt = new Map(); for (const s of list) cnt.set(s.group, (cnt.get(s.group) || 0) + 1);
        groups = order.filter(g => cnt.has(g)).map(g => ({ name: g, count: cnt.get(g) }));
        if (groups.length < 2) { groups = []; for (const s of list) s.group = null; } // одна група = без груп
      }
      return { name, count: list.length, groups, services: list };
    });
}

module.exports = { normCategory, serviceGroup, groupCatalog, CAT_ORDER, CAT_SYNONYMS };
