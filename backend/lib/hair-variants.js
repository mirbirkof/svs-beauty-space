'use strict';
// price-materials-0411 (Босс 04.11): «ціни на волосся лише за роботу без матеріалу — вводить в оману».
// Процедура → варіант довжини → робота (послуга CRM, йде у візит) + матеріал (окрема послуга / включено / за фактом).
// Ціни ЖИВІ: беруться з services.price привʼязаних послуг (правка ціни в CRM одразу видна клієнту).
// Таблиці — міграція 319 (service_procedures, service_length_variants).
const { getTenantId } = require('./tenant');

const _cache = new Map(); // tenantId → { at, data }
const TTL = 60 * 1000;
function clearCache() { _cache.clear(); }

const num = (x) => (x == null || x === '' ? null : Number(x));

function cmText(v) {
  const f = num(v.cm_from), t = num(v.cm_to);
  if (f && t) return `${f}–${t} см`;
  if (t) return `до ${t} см`;
  if (f) return `понад ${f} см`;
  return '';
}

// Один варіант для клієнта: сума ЗАВЖДИ з одного рядка (робота + матеріал тієї самої довжини).
function variantView(v) {
  const work = num(v.work_price) || 0;
  let material = null, materialKnown = true;
  if (v.material_mode === 'separate') { material = num(v.material_svc_price); if (material == null) materialKnown = false; }
  else if (v.material_mode === 'extra') { material = num(v.material_price); materialKnown = false; } // «за фактом [від X]»
  else material = 0; // included / none
  const total = work + (material || 0);
  return {
    id: v.id, code: v.length_code, label: v.length_label, cm: cmText(v), cm_from: num(v.cm_from), cm_to: num(v.cm_to),
    level: Number(v.level) || 3, work_service_id: v.work_service_id, work_name: v.work_name,
    material_service_id: v.material_service_id || null, material_name: v.material_name || null,
    material_mode: v.material_mode, material_note: v.material_note || null,
    work, material, material_known: materialKnown, total, duration_min: Number(v.work_duration) || 60,
  };
}

async function loadProcedures(db, { all = false } = {}) {
  const tid = String(getTenantId() || 'default');
  const hit = !all && _cache.get(tid);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const ps = (await db.query(
    `SELECT id, key, title, category, alias_service_ids, note, sort, active FROM service_procedures
      ${all ? '' : 'WHERE active'} ORDER BY sort, id`)).rows;
  const vs = (await db.query(
    `SELECT v.*, w.name AS work_name, w.price::float AS work_price, COALESCE(w.duration_min, 60) AS work_duration,
            (w.active IS NOT FALSE AND w.deleted_at IS NULL) AS work_active,
            m.name AS material_name, m.price::float AS material_svc_price
       FROM service_length_variants v
       JOIN services w ON w.id = v.work_service_id
       LEFT JOIN services m ON m.id = v.material_service_id
      ${all ? '' : 'WHERE v.active'} ORDER BY v.procedure_id, v.sort, v.id`)).rows;
  const data = ps.map(p => ({
    ...p, alias_service_ids: (p.alias_service_ids || []).map(Number),
    variants: vs.filter(v => v.procedure_id === p.id).map(v => ({ ...variantView(v), active: v.active, work_active: v.work_active })),
  }));
  if (!all) _cache.set(tid, { at: Date.now(), data });
  return data;
}

// Підпис ціни картки: «робота + матеріал» / «+ матеріал за фактом» / нічого (матеріал не потрібен)
function modeNote(variants) {
  if (variants.some(v => v.material_mode === 'extra' || !v.material_known)) return '+ матеріал за фактом';
  if (variants.some(v => v.material_mode === 'separate' || v.material_mode === 'included')) return 'робота + матеріал';
  return '';
}

// Робота «без матеріалу/барвників» поза процедурами — щоб і там клієнт бачив, що матеріал окремо
const MATERIAL_EXTRA_RE = /без[^)]*(матеріал|барвник|фарбник)|\(робота\)/i;

// Каталог мініапу: процедура з онлайн-варіантами → ОДНА картка; її роботи, матеріали й аліаси ховаються.
// services — рядки loadCatalog (лише ті, що мають онлайн-майстра).
function applyProcedures(services, procs) {
  const online = new Map((services || []).map(s => [Number(s.id), s]));
  const hide = new Set(), cards = [];
  for (const p of procs || []) {
    const vars = p.variants.filter(v => v.work_active !== false && online.has(Number(v.work_service_id)));
    if (!vars.length) continue; // жоден варіант не бронюється онлайн — лишаємо як було
    for (const v of p.variants) { hide.add(Number(v.work_service_id)); if (v.material_service_id) hide.add(Number(v.material_service_id)); }
    for (const a of p.alias_service_ids) hide.add(Number(a));
    const totals = vars.map(v => v.total);
    cards.push({
      id: 'p' + p.id, proc_id: p.id, name: p.title, category: p.category,
      price: Math.min(...totals), price_to: Math.max(...totals), price_from: true,
      price_note: modeNote(vars), duration_min: Math.min(...vars.map(v => v.duration_min)),
      variants: vars.map(({ work_active, active, ...v }) => v),
    });
  }
  const rest = (services || []).filter(s => !hide.has(Number(s.id))).map(s => (
    MATERIAL_EXTRA_RE.test(s.name || '') ? { ...s, price_note: '+ матеріал за фактом' } : s));
  return rest.concat(cards);
}

// Варіант за id + перевірка, що робота — саме ця послуга (бронь із мініапу/бота)
async function variantFor(db, variantId, workServiceId) {
  const id = Number(variantId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const procs = await loadProcedures(db);
  for (const p of procs) for (const v of p.variants) {
    if (v.id === id && (workServiceId == null || Number(v.work_service_id) === Number(workServiceId))) return { proc: p, v };
  }
  return null;
}

// Орієнтовна сума для візиту (appointments.price_estimate) і підказки адміну
function estimateOf(proc, v, { unknown = false } = {}) {
  const vars = proc.variants;
  const totals = vars.map(x => x.total);
  return {
    procedure: proc.title, variant_id: v.id, length: unknown ? null : v.label, cm: unknown ? null : v.cm,
    length_unknown: !!unknown, work: v.work, material: v.material, material_mode: v.material_mode,
    material_known: v.material_known, material_service_id: v.material_service_id, material_name: v.material_name,
    total: v.total, range: unknown ? [Math.min(...totals), Math.max(...totals)] : null,
  };
}

const fmt = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
function estimateText(e) {
  if (!e) return '';
  if (e.length_unknown) return `≈ ${fmt(e.range[0])}–${fmt(e.range[1])} ₴ (довжину визначить майстер)`;
  if (e.material_mode === 'separate' && e.material_known) return `≈ ${fmt(e.total)} ₴ = робота ${fmt(e.work)} + матеріал ${fmt(e.material)}`;
  if (e.material_mode === 'extra' || !e.material_known) return `≈ ${fmt(e.work)} ₴ + матеріал за фактом`;
  return `≈ ${fmt(e.total)} ₴`;
}
// Рядок для адміна: що ДОДАТИ в рахунок
function adminHint(e) {
  if (!e) return '';
  const len = e.length_unknown ? 'довжина: визначить майстер' : `довжина: ${e.length}${e.cm ? ' (' + e.cm + ')' : ''}`;
  let mat = '';
  if (e.material_mode === 'separate') mat = `додати матеріал: ${e.material_name || 'матеріал'}${e.material_known ? ' — ' + fmt(e.material) + ' ₴' : ''}`;
  else if (e.material_mode === 'extra') mat = 'матеріал (барвник) — за фактом';
  return [len, mat].filter(Boolean).join('; ');
}

module.exports = { loadProcedures, applyProcedures, variantFor, variantView, estimateOf, estimateText, adminHint, cmText, modeNote, clearCache, MATERIAL_EXTRA_RE };
