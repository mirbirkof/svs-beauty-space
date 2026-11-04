'use strict';
// price-materials-0411: ціни волосся «робота + матеріал» (мініап, бот, підказка адміну). Без БД.
const test = require('node:test');
const assert = require('node:assert');
const hv = require('../lib/hair-variants');

const raw = (o) => ({ id: 1, length_label: 'до 25 см', length_code: 'l2', cm_to: 25, level: 2, work_service_id: 25, work_name: 'біовирівнювання 2', work_price: 2400, work_duration: 180, material_mode: 'separate', material_service_id: 90, material_name: 'матеріал біо 2', material_svc_price: 600, ...o });
const proc = () => ({ id: 1, title: 'Біовирівнювання', category: 'Волосся', alias_service_ids: [7],
  variants: [hv.variantView(raw()), hv.variantView(raw({ id: 2, length_label: 'до 80 см', cm_to: 80, work_service_id: 36, work_price: 4600, material_service_id: 91, material_svc_price: 1400 }))] });

test('variantView: сума = робота + матеріал тієї самої довжини', () => {
  const v = hv.variantView(raw());
  assert.strictEqual(v.total, 3000); assert.strictEqual(v.material, 600); assert.strictEqual(v.material_known, true);
  assert.strictEqual(v.cm, 'до 25 см');
});
test('variantView: extra — матеріал невідомий, сума = робота', () => {
  const v = hv.variantView(raw({ material_mode: 'extra', material_service_id: null, material_svc_price: null }));
  assert.strictEqual(v.material_known, false); assert.strictEqual(v.total, 2400);
});
test('applyProcedures: одна картка «від», роботи/матеріали/аліаси сховані', () => {
  const services = [{ id: 25, name: 'біо 2' }, { id: 36, name: 'біо 5' }, { id: 90, name: 'мат' }, { id: 7, name: 'дубль' }, { id: 145, name: 'Стрижка' }];
  const out = hv.applyProcedures(services, [proc()]);
  assert.deepStrictEqual(out.map(s => s.id), [145, 'p1']);
  const c = out.find(s => s.id === 'p1');
  assert.strictEqual(c.price, 3000); assert.strictEqual(c.price_to, 6000); assert.strictEqual(c.price_from, true);
  assert.strictEqual(c.price_note, 'робота + матеріал'); assert.strictEqual(c.variants.length, 2);
});
test('applyProcedures: робота «без барвників» поза процедурою отримує «+ матеріал за фактом»', () => {
  const out = hv.applyProcedures([{ id: 170, name: 'Фарбування 2 довжина (без барвників)' }, { id: 5, name: 'Біозавивка 3-4 довжина (робота)' }, { id: 6, name: 'Манікюр' }], []);
  assert.strictEqual(out[0].price_note, '+ матеріал за фактом');
  assert.strictEqual(out[1].price_note, '+ матеріал за фактом');
  assert.strictEqual(out[2].price_note, undefined);
});
test('estimateText/adminHint: відома довжина', () => {
  const p = proc(); const e = hv.estimateOf(p, p.variants[0]);
  assert.strictEqual(hv.estimateText(e), '≈ 3 000 ₴ = робота 2 400 + матеріал 600');
  assert.strictEqual(hv.adminHint(e), 'довжина: до 25 см (до 25 см); додати матеріал: матеріал біо 2 — 600 ₴');
});
test('estimateText: «не знаю довжину» → діапазон', () => {
  const p = proc(); const e = hv.estimateOf(p, p.variants[1], { unknown: true });
  assert.strictEqual(hv.estimateText(e), '≈ 3 000–6 000 ₴ (довжину визначить майстер)');
  assert.match(hv.adminHint(e), /довжина: визначить майстер/);
});
test('бот: priceLabel / totalLabel', () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u@127.0.0.1:1/x';
  const bot = require('../lib/booking-bot');
  const s = { id: 25, name: 'біо 2', price: 2400, hair: hv.variantView(raw()) };
  assert.match(bot.priceLabel(s), /≈ 3 000 грн \(робота 2 400 \+ матеріал 600\)/);
  assert.match(bot.priceLabel({ name: 'Фарбування 2 довжина (без барвників)', price: 950 }), /матеріал за фактом/);
  assert.match(bot.totalLabel([s, { name: 'Стрижка', price: 750 }], 3150), /≈ 3 750 грн \(робота \+ матеріал\)/);
  assert.doesNotMatch(bot.totalLabel([{ name: 'Стрижка', price: 750 }], 750), /≈/);
});
