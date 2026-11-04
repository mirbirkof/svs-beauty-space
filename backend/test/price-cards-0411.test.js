'use strict';
// price-cards-0411: картки мініапу за прайсом салону. Без БД: маппинг сиду + розрахунок цін/топ-майстра/опцій.
const test = require('node:test');
const assert = require('node:assert');
const hv = require('../lib/hair-variants');
const { P, NEW } = require('../scripts/seed-price-cards-0411');

const card = (k) => P.find(p => p.key === k);
// рядок variants із БД → variantView
const raw = (o) => hv.variantView({ id: 1, length_code: 'one', length_label: 'x', level: 1, work_service_id: 88, work_price: 450,
  work_duration: 60, material_mode: 'none', ...o });
const proc = (o, vars) => ({ id: 1, title: 'Манікюр жіночий', category: 'Нігті', alias_service_ids: [], addons: [], top_master_ids: [25],
  price_hint: null, variant_kind: 'type', variants: vars, ...o });
// applyProcedures повертає список: несховані послуги + картки процедур
const apply = (svcs, procs) => { const r = hv.applyProcedures(svcs, procs); const left = new Set(r.filter(x => !x.proc_id).map(x => Number(x.id)));
  return { cards: r.filter(x => x.proc_id), hide: { has: (id) => svcs.some(s => s.id === id) && !left.has(id) } }; };
const online = (...ids) => ids.map(id => ({ id, name: 's' + id, duration_min: 60, price: 1, category: 'Нігті' }));

test('маппинг: 32 картки, ключі унікальні, усі ціни прайсу на місці', () => {
  assert.strictEqual(P.length, 32);
  assert.strictEqual(new Set(P.map(p => p.key)).size, P.length);
  const lows = (k) => card(k).v.map(v => v.list);
  assert.deepStrictEqual(lows('bio'), [2900, 3700, 4700, 5800]);
  assert.deepStrictEqual(lows('total_blond'), [3500, 4000, 5000, 5500, 6500]);
  assert.deepStrictEqual(lows('complex_dye'), [4000, 5000, 6500, 9000]);
  assert.deepStrictEqual(lows('black_out'), [4000, 5000, 6000, 7500, 8500]);
  assert.deepStrictEqual(lows('contouring'), [2500, 2600, 2700]);
  assert.deepStrictEqual(lows('top_contour'), [2600, 2900, 3100]);
  assert.deepStrictEqual(lows('milir'), [2700, 3200, 3600, 5000]);
  assert.deepStrictEqual(card('dye').v.map(v => [v.list, v.list_to]), [[1400, 2000], [1500, 2100], [1700, 2500], [2000, 2700], [2300, 3000]]);
  assert.deepStrictEqual(lows('lash_ext'), [700, 750, 800, 900]);
  assert.deepStrictEqual(lows('lash_led'), [700, 750, 800, 900]);
  assert.deepStrictEqual(lows('makeup'), [700, 800, 900]);
  assert.deepStrictEqual(card('makeup').addons.map(a => a.price), [50, 50, 100]);
});
test('маппинг: волосся — опція стрижки +200 і підказка «до +30%» на всіх 8 картках', () => {
  const hair = P.filter(p => p.kind === 'length');
  assert.strictEqual(hair.length, 8);
  for (const p of hair) {
    assert.deepStrictEqual(p.addons, [{ key: 'cut', label: 'Стрижка під час фарбування', price: 200 }], p.key);
    assert.match(p.hint, /30%/);
  }
});
test('маппинг: нігті — 14 карток, ціни інших/Тетяни, топ-майстер 25', () => {
  const nails = P.filter(p => /^(nail|pedi)_/.test(p.key));
  assert.strictEqual(nails.length, 14);
  for (const p of nails) assert.deepStrictEqual(p.top_ids, [25], p.key);
  const v = (k) => card(k).v[0];
  assert.deepStrictEqual([v('nail_correction').list, v('nail_correction').list_to, v('nail_correction').list_top], [750, 800, 850]);
  assert.deepStrictEqual([v('nail_mani_w').list, v('nail_mani_w').list_top, v('nail_mani_w').svc, v('nail_mani_w').top], [450, 500, 88, 89]);
  assert.deepStrictEqual([v('pedi_m').list, v('pedi_m').list_top], [550, 650]);
  assert.strictEqual(Math.min(...nails.map(p => p.v[0].list)), 100);
});
test('маппинг: масаж — 6 нових послуг Каті, старі 7 — аліаси', () => {
  const m = NEW.filter(n => n.ref.startsWith('m_'));
  assert.strictEqual(m.length, 6);
  for (const n of m) assert.deepStrictEqual(n.masters, [73]);
  assert.deepStrictEqual(m.map(n => n.price), [400, 350, 300, 550, 450, 200]);
  assert.deepStrictEqual(card('massage_full').alias, [20, 21, 48, 71, 75, 101, 123]);
  assert.ok(card('makeup').alias.includes(83), 'весільний прихований');
});

test('variantView: ціна прайсу перекриває CRM-роботу, CRM-ціна лишається у work', () => {
  const v = raw({ work_price: 800, list_price: 700 });
  assert.strictEqual(v.total, 700); assert.strictEqual(v.work, 800); assert.strictEqual(v.list, 700);
});

test('applyProcedures: нігті «від 450», топ-послуга схована, базова/аліаси сховані', () => {
  const p = proc({ alias_service_ids: [87] }, [raw({ list_price: 450, list_price_top: 500, work_service_top_id: 89, top_duration: 75 })]);
  const { cards, hide } = apply(online(88, 89, 87), [p]);
  assert.strictEqual(cards.length, 1);
  const c = cards[0];
  assert.strictEqual(c.price, 450); assert.strictEqual(c.price_to, 500); assert.strictEqual(c.price_from, true);
  assert.deepStrictEqual(c.top_master_ids, [25]);
  for (const id of [88, 89, 87]) assert.ok(hide.has(id), 'hide ' + id);
});
test('applyProcedures: топ-послуга не онлайн → без топ-ціни; топ-послуги немає → топ-ціна лишається', () => {
  const a = apply(online(88), [proc({}, [raw({ list_price: 450, list_price_top: 500, work_service_top_id: 89 })])]).cards[0];
  assert.strictEqual(a.variants[0].list_top, null); assert.strictEqual(a.price_from, false);
  const b = apply(online(56), [proc({}, [raw({ work_service_id: 56, list_price: 200, list_price_top: 250 })])]).cards[0];
  assert.strictEqual(b.variants[0].list_top, 250); assert.strictEqual(b.price, 200);
});
test('applyProcedures: жоден варіант не онлайн → картки немає, послуги не ховаються (масаж без майстра)', () => {
  const r = apply(online(1, 20), [proc({ alias_service_ids: [20] }, [raw({ work_service_id: 237, list_price: 400 })])]);
  assert.strictEqual(r.cards.length, 0); assert.ok(!r.hide.has(20));
});

test('serviceFor / isTopMaster: Тетяна → топ-послуга і топ-ціна, інші → база', () => {
  const v = raw({ list_price: 450, list_price_top: 500, work_service_top_id: 89 });
  const p = proc({}, [v]);
  assert.strictEqual(hv.serviceFor(p, v, 25), 89); assert.strictEqual(hv.serviceFor(p, v, 20), 88);
  assert.strictEqual(hv.serviceFor(p, v, null), 88);
  assert.strictEqual(hv.estimateOf(p, v, { masterId: 25 }).total, 500);
  assert.strictEqual(hv.estimateOf(p, v, { masterId: 20 }).total, 450);
  const w = raw({ work_service_id: 56, list_price: 200, list_price_top: 250 }); // без окремої топ-послуги
  assert.strictEqual(hv.serviceFor(proc({}, [w]), w, 25), 56);
  assert.strictEqual(hv.estimateOf(proc({}, [w]), w, { masterId: 25 }).total, 250);
  assert.deepStrictEqual(hv.topPairsFor([p], 88).map(x => x.topId), [89]);
});
test('pickAddons: лише опції процедури, ціна з БД; estimateText з опціями', () => {
  const addons = [{ key: 'lashes', label: 'Накладні вії', price: 50 }, { key: 'early', label: 'Запис до 8:00', price: 100 }];
  const v = raw({ work_service_id: 85, work_price: 800, list_price: 700 });
  const p = proc({ title: 'Макіяж', addons, top_master_ids: [] }, [v]);
  const picked = hv.pickAddons(p, ['early', 'hack', 'lashes']);
  assert.deepStrictEqual(picked.map(a => a.key), ['lashes', 'early']);
  assert.deepStrictEqual(hv.pickAddons(p, 'early'), []);
  const e = hv.estimateOf(p, v, { addons: picked });
  assert.strictEqual(e.total, 850); assert.strictEqual(e.work, 800);
  assert.strictEqual(hv.estimateText(e), '850 ₴ (з опціями +150 ₴)');
});
test('estimateText: довжина «від», діапазон тонування, невідома довжина', () => {
  const vs = [raw({ id: 1, length_label: '1 довжина', list_price: 1400, list_price_to: 2000 }), raw({ id: 2, length_label: '5 довжина', list_price: 2300, list_price_to: 3000 })];
  const p = proc({ title: 'Тонування', variant_kind: 'length', top_master_ids: [] }, vs);
  assert.strictEqual(hv.estimateText(hv.estimateOf(p, vs[0])), '1 400–2 000 ₴');
  assert.strictEqual(hv.estimateText(hv.estimateOf(p, vs[1], { unknown: true })), 'від 1 400 ₴ (довжину визначить майстер)');
  const b = [raw({ list_price: 2900 })];
  assert.strictEqual(hv.estimateText(hv.estimateOf(proc({ variant_kind: 'length', top_master_ids: [] }, b), b[0])), 'від 2 900 ₴');
});
