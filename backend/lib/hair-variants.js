'use strict';
// price-materials-0411 (Босс 04.11): «ціни на волосся лише за роботу без матеріалу — вводить в оману».
// Процедура → варіант довжини → робота (послуга CRM, йде у візит) + матеріал (окрема послуга / включено / за фактом).
// Ціни ЖИВІ: беруться з services.price привʼязаних послуг (правка ціни в CRM одразу видна клієнту).
// Таблиці — міграція 319 (service_procedures, service_length_variants).
// price-cards-0411: + ціни ПРАЙСУ салону (list_price «від X», діапазон, ціна топ-майстра + його послуга),
// опції «+X ₴» (addons), підказка «до +30%» (price_hint), вид варіантів 'length' (силует) | 'type' (класика/2D…).
// Клієнт бачить прайс; у візит іде послуга CRM (services.price не чіпаємо — від неї каса й зарплати).
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
  const list = num(v.list_price);
  // прайс: клієнту — ціна прайсу (матеріал/догляд уже всередині), CRM-«робота» лишається для каси
  const total = list != null ? list : work + (material || 0);
  return {
    id: v.id, code: v.length_code, label: v.length_label, cm: cmText(v), cm_from: num(v.cm_from), cm_to: num(v.cm_to),
    level: Number(v.level) || 3, work_service_id: v.work_service_id, work_name: v.work_name,
    material_service_id: v.material_service_id || null, material_name: v.material_name || null,
    material_mode: v.material_mode, material_note: v.material_note || null,
    work, material, material_known: materialKnown, total, duration_min: Number(v.work_duration) || 60,
    list, list_to: num(v.list_price_to), list_top: num(v.list_price_top), list_top_to: num(v.list_price_top_to),
    work_service_top_id: v.work_service_top_id ? Number(v.work_service_top_id) : null,
    top_duration_min: v.work_service_top_id ? (Number(v.top_duration) || 60) : null,
  };
}

async function loadProcedures(db, { all = false } = {}) {
  const tid = String(getTenantId() || 'default');
  const hit = !all && _cache.get(tid);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const ps = (await db.query(
    `SELECT id, key, title, category, alias_service_ids, note, sort, active,
            addons, top_master_ids, price_hint, variant_kind FROM service_procedures
      ${all ? '' : 'WHERE active'} ORDER BY sort, id`)).rows;
  const vs = (await db.query(
    `SELECT v.*, w.name AS work_name, w.price::float AS work_price, COALESCE(w.duration_min, 60) AS work_duration,
            (w.active IS NOT FALSE AND w.deleted_at IS NULL) AS work_active,
            m.name AS material_name, m.price::float AS material_svc_price,
            COALESCE(t.duration_min, 60) AS top_duration,
            (t.id IS NOT NULL AND t.active IS NOT FALSE AND t.deleted_at IS NULL) AS top_active
       FROM service_length_variants v
       JOIN services w ON w.id = v.work_service_id
       LEFT JOIN services m ON m.id = v.material_service_id
       LEFT JOIN services t ON t.id = v.work_service_top_id
      ${all ? '' : 'WHERE v.active'} ORDER BY v.procedure_id, v.sort, v.id`)).rows;
  const data = ps.map(p => ({
    ...p, alias_service_ids: (p.alias_service_ids || []).map(Number),
    addons: Array.isArray(p.addons) ? p.addons.filter(a => a && a.key && a.label).map(a => ({ key: String(a.key), label: String(a.label), price: Number(a.price) || 0 })) : [],
    top_master_ids: (p.top_master_ids || []).map(Number), price_hint: p.price_hint || null, variant_kind: p.variant_kind || 'length',
    variants: vs.filter(v => v.procedure_id === p.id).map(v => ({ ...variantView(v), active: v.active, work_active: v.work_active, top_active: v.top_active })),
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
// Варіант бронюється онлайн, якщо онлайн його робота АБО (для топ-майстра) топ-послуга
const workOnline = (v, online) => v.work_active !== false && online.has(Number(v.work_service_id));
const topOnline = (v, online) => !!v.work_service_top_id && v.top_active !== false && online.has(Number(v.work_service_top_id));
// Нижня/верхня ціна варіанта для клієнта (прайс; топ-майстер — своя)
function varLow(v) { return v.list != null ? Math.min(v.list, v.list_top != null ? v.list_top : v.list) : v.total; }
function varHigh(v) {
  if (v.list == null) return v.total;
  return Math.max(v.list_to != null ? v.list_to : v.list, v.list_top_to != null ? v.list_top_to : (v.list_top != null ? v.list_top : 0));
}
function applyProcedures(services, procs) {
  const online = new Map((services || []).map(s => [Number(s.id), s]));
  const hide = new Set(), cards = [];
  for (const p of procs || []) {
    // топ-послуга є, але не онлайн → варіант бронюється лише як базовий (без топ-ціни);
    // топ-послуги немає зовсім → топ-майстер робить базову послугу за своєю ціною прайсу
    const vars = p.variants.filter(v => workOnline(v, online) || topOnline(v, online))
      .map(v => (!v.work_service_top_id || topOnline(v, online)) ? v
        : { ...v, work_service_top_id: null, list_top: null, list_top_to: null, top_duration_min: null });
    if (!vars.length) continue; // жоден варіант не бронюється онлайн — лишаємо як було
    for (const v of p.variants) {
      hide.add(Number(v.work_service_id)); if (v.material_service_id) hide.add(Number(v.material_service_id));
      if (v.work_service_top_id) hide.add(Number(v.work_service_top_id));
    }
    for (const a of p.alias_service_ids) hide.add(Number(a));
    const isList = vars.some(v => v.list != null);
    const lo = Math.min(...vars.map(varLow)), hi = Math.max(...vars.map(varHigh));
    const card = {
      id: 'p' + p.id, proc_id: p.id, name: p.title, category: p.category,
      price: lo, price_to: hi,
      // «від X»: кілька варіантів / довжина / топ-майстер дорожче / діапазон прайсу
      price_from: !isList || vars.length > 1 || p.variant_kind === 'length' || hi > lo,
      price_note: isList ? (p.price_hint || '') : modeNote(vars),
      duration_min: Math.min(...vars.map(v => v.duration_min)),
      variants: vars.map(({ work_active, active, top_active, ...v }) => v),
    };
    if (isList) {
      card.variant_kind = p.variant_kind;
      if (p.addons.length) card.addons = p.addons;
      if (p.price_hint) card.price_hint = p.price_hint;
      if (p.top_master_ids.length && vars.some(v => v.list_top != null)) card.top_master_ids = p.top_master_ids;
    }
    cards.push(card);
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
    if (v.id === id && (workServiceId == null || Number(v.work_service_id) === Number(workServiceId)
      || (v.work_service_top_id && Number(v.work_service_top_id) === Number(workServiceId)))) return { proc: p, v };
  }
  return null;
}

// Орієнтовна сума для візиту (appointments.price_estimate) і підказки адміну
// price-cards-0411: варіант із прайсом — ціна за майстром (топ/інші) + обрані опції
function isTopMaster(proc, v, masterId) {
  return masterId != null && v.list_top != null && (proc.top_master_ids || []).includes(Number(masterId));
}
// Яка послуга CRM іде у візит до цього майстра
function serviceFor(proc, v, masterId) {
  return isTopMaster(proc, v, masterId) && v.work_service_top_id ? Number(v.work_service_top_id) : Number(v.work_service_id);
}
// Опції з тіла броні → лише ті, що є в процедурі (ціна — з БД, не з клієнта)
function pickAddons(proc, keys) {
  if (!Array.isArray(keys) || !keys.length) return [];
  const want = new Set(keys.slice(0, 10).map(String));
  return (proc.addons || []).filter(a => want.has(a.key));
}
function estimateOf(proc, v, { unknown = false, masterId = null, addons = [] } = {}) {
  const vars = proc.variants;
  if (v.list != null) {
    const top = isTopMaster(proc, v, masterId);
    const add = (addons || []).reduce((a, x) => a + (Number(x.price) || 0), 0);
    const price = top ? v.list_top : v.list;
    const to = top ? v.list_top_to : v.list_to;
    const lows = vars.map(x => (top && x.list_top != null ? x.list_top : x.list)).filter(x => x != null);
    return {
      procedure: proc.title, variant_id: v.id, list: true, from: proc.variant_kind === 'length',
      length: unknown ? null : v.label, cm: unknown ? null : v.cm, length_unknown: !!unknown,
      work: v.work, price, price_to: to || null, top, master_id: masterId != null ? Number(masterId) : null,
      addons: (addons || []).map(a => ({ key: a.key, label: a.label, price: Number(a.price) || 0 })), addons_sum: add,
      total: price + add, range: unknown ? [Math.min(...lows) + add, Math.max(...lows) + add] : null,
      hint: proc.price_hint || null, material_mode: 'list',
    };
  }
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
  if (e.list) {
    const opt = e.addons && e.addons.length ? ` (з опціями +${fmt(e.addons_sum)} ₴)` : '';
    if (e.length_unknown) return `від ${fmt(e.range[0])} ₴${opt} (довжину визначить майстер)`;
    if (e.price_to && e.price_to > e.price) return `${fmt(e.total)}–${fmt(e.price_to + e.addons_sum)} ₴${opt}`;
    return `${e.from ? 'від ' : ''}${fmt(e.total)} ₴${opt}`;
  }
  if (e.length_unknown) return `≈ ${fmt(e.range[0])}–${fmt(e.range[1])} ₴ (довжину визначить майстер)`;
  if (e.material_mode === 'separate' && e.material_known) return `≈ ${fmt(e.total)} ₴ = робота ${fmt(e.work)} + матеріал ${fmt(e.material)}`;
  if (e.material_mode === 'extra' || !e.material_known) return `≈ ${fmt(e.work)} ₴ + матеріал за фактом`;
  return `≈ ${fmt(e.total)} ₴`;
}
// Рядок для адміна: що ДОДАТИ в рахунок
function adminHint(e) {
  if (!e) return '';
  if (e.list) {
    const parts = [];
    if (e.length || e.length_unknown) parts.push(e.length_unknown ? 'довжина: визначить майстер' : `${e.from ? 'довжина' : 'вид'}: ${e.length}${e.cm ? ' (' + e.cm + ')' : ''}`);
    parts.push(`клієнту показано за прайсом ${estimateText(e)}${e.top ? ' (топ-майстер)' : ''}`);
    if (e.addons && e.addons.length) parts.push('опції: ' + e.addons.map(a => `${a.label} +${fmt(a.price)} ₴`).join(', '));
    return parts.join('; ');
  }
  const len = e.length_unknown ? 'довжина: визначить майстер' : `довжина: ${e.length}${e.cm ? ' (' + e.cm + ')' : ''}`;
  let mat = '';
  if (e.material_mode === 'separate') mat = `додати матеріал: ${e.material_name || 'матеріал'}${e.material_known ? ' — ' + fmt(e.material) + ' ₴' : ''}`;
  else if (e.material_mode === 'extra') mat = 'матеріал (барвник) — за фактом';
  return [len, mat].filter(Boolean).join('; ');
}

// Пари «базова послуга → топ-послуга» для резолву майстрів/слотів: workId → [{ topId, topMasterIds, v, proc }]
function topPairsFor(procs, serviceId) {
  const out = [];
  for (const p of procs || []) for (const v of p.variants) {
    if (v.work_service_top_id && Number(v.work_service_id) === Number(serviceId) && p.top_master_ids.length)
      out.push({ topId: Number(v.work_service_top_id), topMasterIds: p.top_master_ids, v, proc: p });
  }
  return out;
}

module.exports = { loadProcedures, applyProcedures, variantFor, variantView, estimateOf, estimateText, adminHint, cmText, modeNote, clearCache, MATERIAL_EXTRA_RE,
  isTopMaster, serviceFor, pickAddons, topPairsFor };
