// combo-0411: кілька послуг за візит — чиста логіка призначення майстрів і відкат броні (без БД).
const { test } = require('node:test');
const assert = require('node:assert');
const { mergeLegs, assignAt, bookCombo, MAX_ITEMS } = require('../lib/combo-plan');

const items = [{ id: 1, name: 'Брови', duration_min: 30 }, { id: 2, name: 'Вії', duration_min: 90 }];
const M = (pairs) => new Map(pairs);

test('один майстер на все має пріоритет над ланцюжком', () => {
  const single = M([[600, [38]]]);
  const freeBy = [M([[600, [38, 66]]]), M([[630, [66]]])];
  assert.deepStrictEqual(assignAt(600, items, freeBy, single, null), [38, 38]);
});

test('ланцюжок: друга послуга стартує рівно після першої, у вільного майстра', () => {
  const freeBy = [M([[600, [38]]]), M([[630, [66]]])];
  assert.deepStrictEqual(assignAt(600, items, freeBy, new Map(), null), [38, 66]);
  // другий майстер зайнятий саме о 10:30 → старту немає (без розриву не складається)
  assert.strictEqual(assignAt(600, items, [M([[600, [38]]]), M([[660, [66]]])], new Map(), null), null);
});

test('ланцюжок віддає перевагу тому ж майстру (менше передач)', () => {
  const freeBy = [M([[600, [38, 66]]]), M([[630, [12, 66]]])];
  assert.deepStrictEqual(assignAt(600, items, freeBy, new Map(), null), [38, 12]);
  const freeBy2 = [M([[600, [66, 38]]]), M([[630, [12, 66]]])];
  assert.deepStrictEqual(assignAt(600, items, freeBy2, new Map(), null), [66, 66]);
});

test('клієнт обрав конкретного майстра → інших не підставляємо', () => {
  const freeBy = [M([[600, [38]]]), M([[630, [66]]])];
  assert.strictEqual(assignAt(600, items, freeBy, new Map(), 38), null);
  assert.deepStrictEqual(assignAt(600, items, freeBy, M([[600, [38]]]), 38), [38, 38]);
});

test('mergeLegs: сусідні послуги одного майстра = одна нога, час підряд', () => {
  const three = [...items, { id: 3, name: 'Ламінування', duration_min: 60 }];
  const legs = mergeLegs(600, three, [38, 38, 66]);
  assert.strictEqual(legs.length, 2);
  assert.deepStrictEqual(legs.map(l => [l.master_id, l.start_min, l.dur, l.items.length]), [[38, 600, 120, 2], [66, 720, 60, 1]]);
});

test('bookCombo: друга нога впала → першу скасовано, помилка нагору', async () => {
  const cancelled = [];
  let n = 0;
  const core = {
    async createBooking(a) { n++; if (n === 2) { const e = new Error('slot'); e.slotTaken = true; throw e; } return { apptIds: [101], bookingId: 'b1', existing: false }; },
    async cancelAppointments(pool, ids) { cancelled.push(...ids); },
  };
  const legs = mergeLegs(600, items, [38, 66]);
  await assert.rejects(bookCombo({ pool: {}, core, legs, date: '2026-11-06', base: {} }), /slot/);
  assert.deepStrictEqual(cancelled, [101]);
});

test('bookCombo: успіх → усі записи і бронювання', async () => {
  let k = 0;
  const seen = [];
  const core = { async createBooking(a) { seen.push([a.masterId, a.startMin, a.services.map(s => s.id)]); k++; return { apptIds: [200 + k], bookingId: 'b' + k, existing: false }; }, async cancelAppointments() {} };
  const r = await bookCombo({ pool: {}, core, legs: mergeLegs(600, items, [38, 66]), date: '2026-11-06', base: { clientId: 1 } });
  assert.deepStrictEqual(seen, [[38, 600, [1]], [66, 630, [2]]]);
  assert.deepStrictEqual(r.apptIds, [201, 202]);
  assert.deepStrictEqual(r.bookingIds, ['b1', 'b2']);
  assert.strictEqual(r.existing, false);
});

test('ліміт послуг у візиті', () => { assert.strictEqual(MAX_ITEMS, 5); });
