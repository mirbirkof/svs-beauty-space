'use strict';
// combo-0411 (Босс 04.11: «нужен выбор в комплексе услуги»): кілька послуг за один візит.
// Модель — та сама, що в бота (booking-core.createBooking): кожна послуга = окремий запис у журналі,
// послуги йдуть ОДНА ЗА ОДНОЮ без розриву. Каса/зарплати працюють як завжди — на рівні запису.
//
// Пріоритет: один майстер на всі послуги (клієнту простіше). Якщо одного такого немає або він зайнятий —
// ланцюжок: послуга 1 у майстра А, одразу після неї послуга 2 у майстра Б (брови в Насті → вії в Ксюші).
const slotEngine = require('./slot-engine');

const MAX_ITEMS = 5;

// legs: сусідні послуги в одного майстра → одна «нога» (один виклик createBooking)
function mergeLegs(start, items, assign) {
  const legs = [];
  let t = start;
  items.forEach((it, i) => {
    const mid = assign[i], d = Number(it.duration_min) || 60;
    const last = legs[legs.length - 1];
    if (last && last.master_id === mid) { last.items.push(it); last.dur += d; }
    else legs.push({ master_id: mid, start_min: t, dur: d, items: [it] });
    t += d;
  });
  return legs;
}

/**
 * Призначення майстрів на старт t. freeBy[i] — Map(start → [masterIds у порядку пріоритету]) для послуги i,
 * single — Map(start → [masterIds, які роблять УСІ послуги й вільні весь час]).
 * Повертає масив masterId по послугах або null.
 */
function assignAt(t, items, freeBy, single, fixedMaster) {
  const s = single.get(t);
  if (s && s.length) return items.map(() => s[0]);
  if (fixedMaster != null) return null; // клієнт обрав конкретного майстра — ланцюжок з іншими не підставляємо
  const out = [];
  let cur = t, prev = null;
  for (let i = 0; i < items.length; i++) {
    const cands = freeBy[i].get(cur);
    if (!cands || !cands.length) return null;
    out.push(prev != null && cands.includes(prev) ? prev : cands[0]); // менше передач між майстрами
    prev = out[i];
    cur += Number(items[i].duration_min) || 60;
  }
  return out;
}

/**
 * Вільні старти комплексу на дату.
 * items: [{id, duration_min, ...}] у порядку виконання; eligAll: майстри, що роблять усі; eligBy[i]: майстри послуги i.
 * fixedMaster: id обраного клієнтом майстра (тоді лише він на всі послуги).
 * → [{ startMin, label, legs:[{master_id,start_min,dur,items}] }]
 */
async function comboSlots(pool, { date, items, eligAll, eligBy, fixedMaster = null }) {
  const total = items.reduce((a, s) => a + (Number(s.duration_min) || 60), 0);
  const allIds = fixedMaster != null ? [Number(fixedMaster)] : eligAll;
  const single = new Map();
  if (allIds.length) {
    const sl = await slotEngine.freeSlotsForDate(pool, { date, masterIds: allIds, durationMin: total, dedupe: false });
    for (const s of sl) { const a = single.get(s.startMin) || []; a.push(Number(s.masterId)); single.set(s.startMin, a); }
  }
  const freeBy = [];
  if (fixedMaster == null) {
    for (let i = 0; i < items.length; i++) {
      const m = new Map();
      if (eligBy[i] && eligBy[i].length) {
        const sl = await slotEngine.freeSlotsForDate(pool, { date, masterIds: eligBy[i], durationMin: Number(items[i].duration_min) || 60, dedupe: false });
        for (const s of sl) { const a = m.get(s.startMin) || []; a.push(Number(s.masterId)); m.set(s.startMin, a); }
      }
      freeBy.push(m);
    }
  }
  const starts = new Set([...single.keys(), ...(freeBy[0] ? freeBy[0].keys() : [])]);
  const out = [];
  for (const t of [...starts].sort((a, b) => a - b)) {
    const assign = assignAt(t, items, freeBy, single, fixedMaster);
    if (!assign) continue;
    out.push({ startMin: t, label: slotEngine.minToLabel(t), legs: mergeLegs(t, items, assign) });
  }
  return out;
}

/**
 * Бронь комплексу: кожна «нога» — createBooking у свого майстра; якщо друга нога не вдалась —
 * першу скасовуємо (клієнт не лишається з половиною візиту). → { apptIds, bookingIds, legs, existing }
 */
async function bookCombo({ pool, core, legs, date, base }) {
  const done = [];
  try {
    for (const leg of legs) {
      const r = await core.createBooking(Object.assign({}, base, {
        masterId: leg.master_id, masterName: leg.master_name || null, date, startMin: leg.start_min,
        services: leg.items.map(it => ({ id: it.id, name: it.name, duration_min: it.duration_min, price: it.price })),
      }));
      done.push(r);
    }
  } catch (e) {
    const fresh = done.filter(r => !r.existing).flatMap(r => r.apptIds);
    if (fresh.length) await core.cancelAppointments(pool, fresh).catch(err => console.error('[combo/rollback]', err.message));
    throw e;
  }
  return {
    apptIds: done.flatMap(r => r.apptIds), bookingIds: done.map(r => r.bookingId).filter(Boolean),
    existing: done.length > 0 && done.every(r => r.existing), perLeg: done,
  };
}

module.exports = { comboSlots, bookCombo, mergeLegs, assignAt, MAX_ITEMS };
