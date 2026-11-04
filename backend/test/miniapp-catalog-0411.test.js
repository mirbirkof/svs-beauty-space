// Вітрина каталогу Mini App (Босс 04.11: «видно лише 4 послуги Перукарські послуги»).
// Чисті функції, без БД: синоніми категорій зливаються, підгрупи стабільні, нічого не губиться.
// Прод-знімок test/fixtures-miniapp-prod-catalog-0411.json — лише назви/ціни/тривалості/категорії (133 послуги).
const { test } = require('node:test');
const assert = require('node:assert');
const { normCategory, serviceGroup, groupCatalog } = require('../lib/miniapp-catalog');
const PROD = require('./fixtures-miniapp-prod-catalog-0411.json');

test('синоніми категорій → канонічні назви, регістр/пробіли не важливі', () => {
  assert.equal(normCategory('Перукарські послуги'), 'Волосся');
  assert.equal(normCategory('  перукарські   ПОСЛУГИ '), 'Волосся');
  assert.equal(normCategory('Брови'), 'Брови');
  assert.equal(normCategory('Брови та вії', 'LED нарощування вій 2D'), 'Вії');
  assert.equal(normCategory('Брови та вії', 'корекція та фарбування брів'), 'Брови');
  assert.equal(normCategory('Вії'), 'Вії');
  assert.equal(normCategory('Манікюр'), 'Нігті');
  assert.equal(normCategory('Масаж'), 'Масаж та тіло');
  assert.equal(normCategory(''), 'Інші послуги');
  assert.equal(normCategory(null), 'Інші послуги');
  assert.equal(normCategory('Косметологія'), 'Косметологія'); // невідома — як є
});

test('підгрупи: фарбування важливіше за стрижку, матеріали окремо, «без матеріалу» — не матеріал', () => {
  assert.equal(serviceGroup('Волосся', 'Фарбування(без барвників) + стрижка 2 довжина'), 'Фарбування та мелірування');
  assert.equal(serviceGroup('Волосся', 'Стрижка жіноча'), 'Стрижки та укладання');
  assert.equal(serviceGroup('Волосся', 'Холодне відновлення 1-2 довжина (матеріал)'), 'Матеріали до процедур');
  assert.equal(serviceGroup('Волосся', 'матеріал біовирівнювання 2 довжина'), 'Матеріали до процедур');
  assert.equal(serviceGroup('Волосся', 'Мелірування + тонування 3-4 довжина(без врахування матеріалу)'), 'Фарбування та мелірування');
  assert.equal(serviceGroup('Волосся', 'Біовирівнювання 3 довжина'), 'Біовирівнювання та завивка');
  assert.equal(serviceGroup('Нігті', 'Педикюр з покриттям гель-лак'), 'Педикюр');
  assert.equal(serviceGroup('Нігті', 'Корекція нарощених нігтів'), 'Нарощування та корекція');
  assert.equal(serviceGroup('Макіяж', 'Денний макіяж'), 'Інше');
});

test('прод-знімок: немає «Перукарські послуги»/«Брови», жодна послуга не загубилась', () => {
  const cats = groupCatalog(PROD);
  const names = cats.map(c => c.name);
  assert.ok(!names.includes('Перукарські послуги'), names.join(','));
  assert.ok(!names.includes('Брови та вії'), names.join(','));
  assert.deepEqual(names, ['Волосся', 'Нігті', 'Брови']);
  assert.equal(cats.reduce((s, c) => s + c.count, 0), PROD.length);
  const ids = cats.flatMap(c => c.services.map(s => s.id));
  assert.equal(new Set(ids).size, PROD.length, 'id не змінюються і не дублюються');
  const hair = cats[0];
  assert.equal(hair.count, 99); // 95 «Волосся» + 4 «Перукарські послуги»
  assert.ok(hair.services.some(s => /^Біовирівнювання/.test(s.name)));
  assert.ok(hair.groups.length >= 4);
  assert.equal(hair.groups.reduce((s, g) => s + g.count, 0), hair.count);
  assert.equal(hair.groups[hair.groups.length - 1].name, 'Матеріали до процедур', 'матеріали — в кінці');
  // послуги впорядковані по групах (одна група = суцільний блок)
  const seq = hair.services.map(s => s.group).filter((g, i, a) => g !== a[i - 1]);
  assert.deepEqual(seq, hair.groups.map(g => g.name));
  assert.deepEqual(cats[2].groups, [], 'мала категорія — без підгруп');
  assert.equal(cats[2].services[0].group, null);
});

test('поля послуги для фронта: id, name, duration_min, price, group', () => {
  const s = groupCatalog([{ id: 5, name: ' Стрижка ', duration_min: null, price: '450', category: 'Перукарські послуги' }])[0];
  assert.equal(s.name, 'Волосся');
  assert.deepEqual(s.services[0], { id: 5, name: 'Стрижка', duration_min: 60, price: 450, group: null });
});
