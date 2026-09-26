// Сторож порядку складу та інвентаризації (26.09, Бос: «в складі й інвентаризації має бути нормальне сортування…
// і по брендах, по типу»). Одна функція (public/admin/assets/stock-sort.js через lib/stock-sort) для сервера й екранів.
// Ловимо: тони фарб за НОМЕРОМ (текстом було 10.1 < 1002 < 3.0), регістр/пробіли не рвуть групу,
// «6,04» = «6.04», порожня назва не ламає сортування і йде в кінець, групи Тип → Бренд, «без бренду» — в кінці,
// тип із attrs.type важить більше за вгадування, у категоріях фарб крем/пензлик не стають «Фарбою».
// Чисті функції — без БД і сервера.
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../lib/stock-sort');

const sortNames = (a) => a.slice().sort(S.naturalCompare);

test('тони фарб — за номером: 1.0 < 3.0 < 5.0 < 6.04 < 7.46 < 10.1 < 100 < 1002', () => {
  const got = sortNames(['extremo 1002', 'extremo 10.1', 'extremo 3.0', 'extremo 7.46', 'extremo 100', 'extremo 6.04', 'extremo 5.0', 'extremo 1.0']);
  assert.deepStrictEqual(got, ['extremo 1.0', 'extremo 3.0', 'extremo 5.0', 'extremo 6.04', 'extremo 7.46', 'extremo 10.1', 'extremo 100', 'extremo 1002']);
  // відтінки одного рівня: 6.0 < 6.01 < 6.04 < 6.1 < 6.35 < 6.4
  assert.deepStrictEqual(sortNames(['eterna 6.4', 'eterna 6.1', 'eterna 6.35', 'eterna 6.01', 'eterna 6.04', 'eterna 6.0']),
    ['eterna 6.0', 'eterna 6.01', 'eterna 6.04', 'eterna 6.1', 'eterna 6.35', 'eterna 6.4']);
  // голий тон — перед підсерією; «03» і «3.0» поруч
  const g2 = sortNames(['extremo acid 9.02', 'extremo 9.1', 'extremo 3.0', 'extremo 03', 'extremo 000']);
  assert.deepStrictEqual(g2, ['extremo 000', 'extremo 03', 'extremo 3.0', 'extremo 9.1', 'extremo acid 9.02']);
  assert.strictEqual(S.naturalCompare('окисник 4,5%', 'окисник 4.5%'), 0, 'кома = крапка');
  assert.ok(S.naturalCompare('окисник 4,5%', 'окисник 12%') < 0, '4,5% < 12%');
});

test('регістр і зайві пробіли не розривають групу', () => {
  const got = sortNames(['socolor 10A', 'SOCOLOR  9M ', 'socolor 508N', 'socolor 9m', 'Socolor 4ma']);
  assert.deepStrictEqual(got.map(S.norm), ['socolor 4ma', 'socolor 9m', 'socolor 9m', 'socolor 10a', 'socolor 508n']);
  assert.strictEqual(S.norm('  SOCOLOR   9M '), 'socolor 9m');
});

test('порожні назви не ламають сортування і йдуть у кінець', () => {
  const got = sortNames(['', 'b 2', null, 'a 10', undefined, 'a 9']);
  assert.deepStrictEqual(got.slice(0, 3), ['a 9', 'a 10', 'b 2']);
  assert.ok(got.slice(3).every(x => !x), JSON.stringify(got));
  assert.doesNotThrow(() => S.sortDefault([{ product_name: null, type: null, brand_name: null, id: 1 }, { product_name: 'x', type: 'Фарба', id: 2 }]));
});

test('порядок за замовчуванням: Тип → Бренд (без бренду в кінці) → назва → обʼєм', () => {
  const rows = [
    { id: 1, type: 'Шампунь', brand_name: 'Raywell', product_name: 'Шампунь hidra', volume: '1000ml' },
    { id: 2, type: 'Фарба', brand_name: null, product_name: 'sync 7N', volume: 'г' },
    { id: 3, type: 'Фарба', brand_name: 'Extremo', product_name: 'extremo 10.1', volume: 'за грам' },
    { id: 4, type: 'Фарба', brand_name: 'Extremo', product_name: 'Extremo 3.0', volume: 'за грам' },
    { id: 5, type: 'Шампунь', brand_name: 'Raywell', product_name: 'шампунь HIDRA', volume: '250ml' },
    { id: 6, type: 'Фарба', brand_name: 'Інше', product_name: 'eterna 6.88', volume: 'г' },
    { id: 7, type: 'Окисник', brand_name: 'Raywell', product_name: 'окисник 6%', volume: 'за грам' },
  ];
  assert.deepStrictEqual(S.sortDefault(rows).map(r => r.id), [4, 3, 6, 2, 7, 5, 1]);
});

test('тип: attrs.type головний; назва сильніша за змішану категорію; категорія фарб не робить «Фарбою» крем/пензлик', () => {
  const t = (p) => S.detectType(p);
  assert.strictEqual(t({ name: 'extremo 7.46', category_id: 'krasky' }), 'Фарба');
  assert.strictEqual(t({ name: 'sync 7N', volume: 'г' }), 'Фарба', 'тон у ваговому товарі без категорії');
  assert.strictEqual(t({ name: 'окисник 4,5%', volume: 'мл' }), 'Окисник');
  assert.strictEqual(t({ name: 'Окисник Raywell 20 VOL (6%)', category_id: 'coloring' }), 'Окисник');
  assert.strictEqual(t({ name: 'Маска SOS EXPRESS 250ml', category_id: 'raywell-envie-extremo-invidia' }), 'Маска');
  assert.strictEqual(t({ name: 'Extremo маска total protector' }), 'Маска');
  assert.strictEqual(t({ name: 'Набір для фарбованого волосся з косметичкою', category_id: 'set' }), 'Набір');
  assert.strictEqual(t({ name: 'Пензлик Raywell для фарбування', category_id: 'coloring' }), 'Інструмент');
  assert.strictEqual(t({ name: 'Крем 10 в 1', category_id: 'raywell-envie-extremo-invidia', price_per_gram: 1019, volume: 'шт' }), 'Догляд');
  assert.strictEqual(t({ name: 'Крем термозахист 10 в 1 EXTREMO', category_id: 'thermal' }), 'Термозахист');
  assert.strictEqual(t({ name: 'що завгодно', attrs: { type: 'Пігмент' } }), 'Пігмент');
  assert.strictEqual(t({ name: 'що завгодно', attrs: { type: 'сміття' } }), 'Інше', 'невідомий attrs.type ігнорується');
  assert.strictEqual(t({ name: '' }), 'Інше');
  assert.strictEqual(t(null), 'Інше');
});

test('пошук по словах: кожне слово — AND, % і _ екрановані, кома в тоні = крапка', () => {
  const vals = [];
  const sql = S.wordsWhere('socolor 9M 5%_', vals, 'hay');
  assert.strictEqual((sql.match(/ILIKE/g) || []).length, 3);
  assert.deepStrictEqual(vals, ['%socolor%', '%9M%', '%5\\%\\_%']);
  const v2 = []; S.wordsWhere('6,04', v2, 'h'); assert.deepStrictEqual(v2, ['%6.04%']);
  assert.strictEqual(S.wordsWhere('   ', [], 'h'), '');
});
