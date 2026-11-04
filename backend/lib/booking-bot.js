/* ═══════════════════════════════════════════════════════════════
   Розмовна онлайн-запис у Telegram — БЕЗ ШІ.

   Клієнт пише послугу вільним текстом ("манікюр і педикюр") →
   матчер визначає послугу/комплекс → бот веде по кроках inline-кнопками:
     текст послуги → (уточнення якщо неоднозначно) → дата → майстер → час → підтвердження.

   Мінімум кліків. Детермінований матчер (lib/service-matcher.js).
   Стан діалогу в БД (booking_sessions) — переживає рестарт.

   Модуль ІЗОЛЬОВАНИЙ: не чіпає робочий web→telegram токен-флоу.
   routes/booking.js делегує сюди callback_query і вільний текст.
   ═══════════════════════════════════════════════════════════════ */
const matcher = require('./service-matcher');
const slotEngine = require('./slot-engine');
const { fmtPhoneFull } = require('./phone');

const SESSION_TTL_MIN = 30;
const MAX_DAYS = 14;          // горизонт вибору дати
const MAX_SLOT_BTN = 24;      // ліміт кнопок часу
const QUICK_LIMIT = 6;        // «найближчі вікна» на першому екрані

// ── дрібні утиліти ─────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const DOW = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MM = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];

function toLocalISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
function fmtPrice(p) {
  const n = Math.round(Number(p) || 0);
  return n > 0 ? `${n} грн` : 'за прайсом';
}
function fmtDur(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? `${h} год ${m} хв` : `${h} год`) : `${m} хв`;
}


// price-materials-0411: волосся — клієнт бачить «робота + матеріал», а не лише роботу (Босс 04.11).
// s.hair (з lib/hair-variants) — варіант довжини процедури, у якому ця послуга є роботою.
const hairVariants = require('./hair-variants');
const nf = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
function priceLabel(s) {
  const h = s && s.hair;
  if (!h) return fmtPrice(s.price) + (hairVariants.MATERIAL_EXTRA_RE.test(s.name || '') ? ' + матеріал за фактом' : '');
  if (h.list != null) return `від ${nf(h.list)} грн`; // price-cards-0411: прайс салону
  if (h.material_mode === 'separate' && h.material_known) return `≈ ${nf(h.total)} грн (робота ${nf(h.work)} + матеріал ${nf(h.material)})`;
  if (h.material_mode === 'extra' || !h.material_known) return `${fmtPrice(h.work)} + матеріал за фактом`;
  return fmtPrice(s.price);
}
// «Разом»: робота + відомий матеріал; позначка, що сума орієнтовна
function totalLabel(chosen, total) {
  let sum = 0, approx = false, extra = false;
  for (const s of chosen || []) {
    const h = s.hair;
    if (h && h.list != null) { approx = true; sum += h.list; }
    else if (h) { approx = true; sum += (h.material_mode === 'separate' && h.material_known) ? h.total : h.work; if (h.material_mode === 'extra' || !h.material_known) extra = true; }
    else { sum += Number(s.price) || 0; if (hairVariants.MATERIAL_EXTRA_RE.test(s.name || '')) { approx = true; extra = true; } }
  }
  if (!approx) return fmtPrice(total);
  return `≈ ${nf(sum)} грн${extra ? ' + матеріал за фактом' : ' (робота + матеріал)'} — точну суму назве майстер після огляду`;
}

// ── каталог послуг (кеш 5 хв, ПЕР-ТЕНАНТ) ──────────────────────────────────
// Major-фікс: раніше кеш каталогу був глобальний → бот першого салону віддавав
// послуги першого салону всім іншим (витік каталогу між тенантами).
const { getTenantId } = require('./tenant');
const _catCache = new Map(); // tenantId → { data, at }
// combo-0411 (Босс: «перевір, як синхронізовано летять»): новий майстер / звʼязка / вимкнений онлайн
// мають зʼявлятися у боті й міні-аппі одразу, а не через 5 хв кешу. Дешевий відбиток стану
// (майстри + звʼязки + послуги) — змінився → кеш скидаємо. Сам відбиток памʼятаємо 5 с.
const CATALOG_SIG_SQL = `SELECT
   (SELECT count(*)::text || ':' || COALESCE(sum(hashtext(ms.master_id || '/' || ms.service_id || '/' || COALESCE(ms.active, true)::text)), 0)::text
      FROM master_services ms) || '|' ||
   (SELECT count(*)::text || ':' || COALESCE(sum(hashtext(m.id || '/' || COALESCE(m.active, true)::text || COALESCE(m.online_booking_enabled, true)::text)), 0)::text
      FROM masters m) || '|' ||
   (SELECT count(*)::text || ':' || COALESCE(sum(hashtext(s.id || '/' || COALESCE(s.active, true)::text || (s.deleted_at IS NULL)::text
             || COALESCE(s.price::text, '') || COALESCE(s.duration_min::text, '') || COALESCE(s.name, '') || COALESCE(s.category, '')
             || COALESCE(s.is_material, false)::text)), 0)::text
      FROM services s) AS sig`;
const _sigMemo = new Map(); // tenantId → { sig, at }
async function catalogSig(pool, tid) {
  const m = _sigMemo.get(tid);
  if (m && Date.now() - m.at < 5000) return m.sig;
  let sig = null;
  try { sig = (await pool.query(CATALOG_SIG_SQL)).rows[0].sig; } catch (e) { console.error('[bookbot/catalog-sig]', e.message); }
  _sigMemo.set(tid, { sig, at: Date.now() });
  return sig;
}
function invalidateCatalog() { _catCache.clear(); _sigMemo.clear(); }
async function loadCatalog(pool) {
  const tid = String(getTenantId() || 'default');
  const hit = _catCache.get(tid);
  const sig = await catalogSig(pool, tid);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000 && (sig == null || hit.sig === sig)) return hit.data;
  const r = await pool.query(
    // Паритет з веб-формою (booking-catalog.js): показуємо послугу, якщо вона активна
    // і має хоча б одного онлайн-майстра. Раніше вимагали legacy_ref IS NOT NULL —
    // залишок від залежності від стара CRM; нативні послуги салону (без BP) були
    // невидимі боту (аудит v8, M6). Движок слотів працює по внутрішніх id, BP не потрібен.
    `SELECT s.id, s.legacy_ref AS bp_id, s.name,
            COALESCE(s.duration_min, 60) AS duration_min, s.price::float AS price, s.category
       FROM services s
      WHERE s.active IS NOT FALSE AND s.deleted_at IS NULL
        -- 04.11: рядки «матеріал …» — для каси/рахунку, клієнт їх окремо не бронює (було 19 у запису)
        AND s.is_material IS NOT TRUE
        AND EXISTS (SELECT 1 FROM master_services ms JOIN masters m ON m.id = ms.master_id
                     WHERE ms.service_id = s.id AND ms.active IS NOT FALSE
                       AND m.active IS NOT FALSE AND m.online_booking_enabled IS NOT FALSE)`
  );
  const services = r.rows.map(s => ({
    id: s.id, bp_id: s.bp_id, name: s.name,
    duration_min: s.duration_min, price: s.price, category: s.category,
  }));
  try { // робота процедури волосся → її варіант довжини (сума робота + матеріал)
    const procs = await hairVariants.loadProcedures(pool);
    const byWork = new Map();
    for (const p of procs) for (const v of p.variants) byWork.set(Number(v.work_service_id), v);
    for (const s of services) { const v = byWork.get(Number(s.id)); if (v) s.hair = v; }
  } catch (e) { console.error('[bookbot/hair-variants]', e.message); }
  const indexed = matcher.buildIndex(services);
  const byId = new Map(services.map(s => [s.id, s]));
  const data = { services, indexed, byId };
  _catCache.set(tid, { data, at: Date.now(), sig });
  return data;
}

// майстри, що надають УСІ вибрані послуги (внутрішні id — движок слотів працює по нашій CRM)
async function eligibleMasters(pool, serviceIds) {
  const r = await pool.query(
    `SELECT m.id,
            COALESCE(NULLIF(m.online_title,''), m.name) AS name,
            m.online_rank
       FROM masters m
      WHERE m.active IS NOT FALSE
        AND m.online_booking_enabled IS NOT FALSE
        AND NOT EXISTS (
          SELECT 1 FROM unnest($1::int[]) sid
           WHERE NOT EXISTS (
             SELECT 1 FROM master_services ms
              WHERE ms.master_id = m.id AND ms.service_id = sid AND ms.active IS NOT FALSE))
      ORDER BY m.online_rank NULLS LAST, name`,
    [serviceIds]
  );
  return r.rows.map(m => ({ id: Number(m.id), name: m.name }));
}

// останній візит клієнта за telegram_id → послуга + майстер (для «⚡ як минулого разу»)
async function lastVisit(pool, uid) {
  const r = await pool.query(
    `SELECT a.service_id, a.master_id
       FROM appointments a JOIN clients c ON c.id = a.client_id
      WHERE c.telegram_id = $1 AND a.service_id IS NOT NULL
        AND a.status IN ('done','arrived','confirmed','booked')
      ORDER BY a.starts_at DESC LIMIT 1`, [uid]);
  return r.rows[0] || null;
}

// Привітання відомого клієнта на /start: кнопка повтору минулого візиту (2 кліки до запису)
async function onStartKnown(msg, ctx, nm) {
  const uid = msg.from.id;
  let svcName = null;
  try {
    const lv = await lastVisit(ctx.pool, uid);
    if (lv) { const cat = await loadCatalog(ctx.pool); const s = cat.byId.get(lv.service_id); svcName = s && s.name; }
  } catch (e) { console.error('[bookbot/last-visit]', e.message); }
  // спершу оновлюємо постійне меню (витісняє меню старого бота в чаті)
  await ctx.tg('sendMessage', {
    chat_id: msg.chat.id, parse_mode: 'HTML',
    text: `З поверненням${nm ? ', ' + nm : ''}! 💛\nНапишіть послугу (напр. «манікюр» чи «фарбування в суботу після обіду») — одразу покажу найближчий вільний час.`,
    reply_markup: mainMenu(),
  });
  if (svcName) {
    await ctx.tg('sendMessage', {
      chat_id: msg.chat.id,
      text: 'Або повторіть минулий візит одним дотиком:',
      reply_markup: { inline_keyboard: [[{ text: `⚡ Як минулого разу: ${svcName.slice(0, 40)}`, callback_data: 'bk:again' }]] },
    });
  }
  return true;
}

// телефон уже привʼязаного клієнта (digits) + імʼя
async function getClient(pool, uid) {
  const r = await pool.query(
    `SELECT id, regexp_replace(phone,'\\D','','g') AS digits,
            COALESCE(NULLIF(name,''), tg_first_name) AS name
       FROM clients
      WHERE telegram_id = $1 AND phone IS NOT NULL AND phone <> '' LIMIT 1`,
    [uid]
  );
  return r.rows[0] || null;
}

// ── сесія ──────────────────────────────────────────────────────
async function loadSession(pool, uid) {
  const r = await pool.query(
    `SELECT chat_id, state, data FROM booking_sessions
      WHERE tg_user_id = $1 AND updated_at > NOW() - INTERVAL '${SESSION_TTL_MIN} minutes'`,
    [uid]
  );
  return r.rows[0] || null;
}
async function saveSession(pool, uid, chatId, state, data) {
  await pool.query(
    `INSERT INTO booking_sessions (tg_user_id, chat_id, state, data, updated_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (tg_user_id) DO UPDATE
       SET chat_id=$2, state=$3, data=$4, updated_at=NOW()`,
    [uid, chatId, state, JSON.stringify(data)]
  );
}
async function clearSession(pool, uid) {
  await pool.query(`DELETE FROM booking_sessions WHERE tg_user_id = $1`, [uid]);
}

// ── вільні слоти: ВЛАСНИЙ движок по CRM (master_schedule_days − appointments) ──
// стара CRM тут більше не потрібен: графік і зайнятість живуть у нашій БД.
function selectedMasterIds(session) {
  const all = (session.data.masters || []).map(m => Number(m.id));
  const sel = session.data.master;
  return (sel && sel !== 'any') ? all.filter(id => id === Number(sel)) : all;
}

// ── chunk кнопок у рядки ───────────────────────────────────────
function rows(btns, perRow) {
  const out = [];
  for (let i = 0; i < btns.length; i += perRow) out.push(btns.slice(i, i + perRow));
  return out;
}

// надіслати або відредагувати крок
async function respond(tg, target, text, keyboard) {
  const body = { text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  if (target.message_id) {
    body.chat_id = target.chat_id; body.message_id = target.message_id;
    const r = await tg('editMessageText', body);
    if (r && r.ok) return r;
    // edit не вдався (старе повідомлення) → надсилаємо нове
  }
  body.chat_id = target.chat_id; delete body.message_id;
  return tg('sendMessage', body);
}

// ═══════════════════════════════════════════════════════════════
//  КРОКИ ДІАЛОГУ
// ═══════════════════════════════════════════════════════════════

// підрахунок підсумку вибраних послуг
function summarize(session) {
  const chosen = session.data.parts.filter(p => p.pick).map(p => p.pick);
  const total = chosen.reduce((a, s) => a + (Number(s.price) || 0), 0);
  const dur = chosen.reduce((a, s) => a + (Number(s.duration_min) || 0), 0);
  return { chosen, total, dur };
}

// знайти наступну неоднозначну частину; якщо всі вирішені → перейти до дати
async function advance(ctx, uid, target, session) {
  const next = session.data.parts.findIndex(p => !p.pick && p.candidates.length > 1);
  if (next >= 0) {
    const part = session.data.parts[next];
    const btns = part.candidates.map((c, i) => [{
      text: `${c.name} · ${priceLabel(c)}`, callback_data: `bk:pick:${next}:${c.id}`,
    }]);
    btns.push([{ text: '✖ Скасувати', callback_data: 'bk:cancel' }]);
    await saveSession(ctx.pool, uid, target.chat_id, 'svc', session.data);
    return respond(ctx.tg, target,
      `Уточніть, що саме ви маєте на увазі під «<b>${part.query}</b>»:`, btns);
  }
  // усі частини вирішені — одразу найближчі вільні вікна (мінімум кліків)
  return showQuick(ctx, uid, target, session);
}

// ЕКРАН «НАЙБЛИЖЧІ ВІКНА»: послуга обрана → одразу конкретні часи по днях.
// Дата/майстер — не обовʼязкові кроки, а опції («Інший день» / «Обрати майстра»).
async function showQuick(ctx, uid, target, session) {
  const { chosen, total, dur } = summarize(session);
  if (!chosen.length) return restart(ctx, uid, target, 'Не вдалось визначити послугу.');
  if (!session.data.masters || !session.data.masters.length) {
    try { session.data.masters = await eligibleMasters(ctx.pool, chosen.map(s => s.id)); }
    catch (e) { console.error('[bookbot/masters]', e.message); session.data.masters = []; }
  }
  if (!session.data.master) session.data.master = 'any';
  const masterIds = selectedMasterIds(session);
  if (!masterIds.length) {
    // Комбо з різних спеціалізацій (напр. «масаж + педикюр») — жоден майстер не робить усе разом.
    // НЕ крутимо в коло: пропонуємо записатись на кожну послугу окремо.
    if (chosen.length > 1) {
      const bookable = [];
      for (const s of chosen) {
        const ms = await eligibleMasters(ctx.pool, [s.id]).catch(() => []);
        if (ms.length) bookable.push(s);
      }
      if (bookable.length) {
        const kb = bookable.map(s => [{ text: `Записатись: ${s.name.slice(0, 36)}`, callback_data: `bk:only:${s.id}` }]);
        kb.push([{ text: '✏️ Інша послуга', callback_data: 'bk:retry' }]);
        await saveSession(ctx.pool, uid, target.chat_id, 'quick', session.data);
        return respond(ctx.tg, target,
          'Ці послуги виконують <b>різні майстри</b>, тож разом онлайн не вийде.\nОберіть одну — запишу зараз, а другу додасте наступним записом:', kb);
      }
    }
    // Одиночна послуга без онлайн-майстра — не в коло, а чесна підказка.
    await clearSession(ctx.pool, uid);
    return respond(ctx.tg, { chat_id: target.chat_id },
      'На жаль, цю послугу поки не можна записати онлайн. Зателефонуйте, будь ласка, в салон — запишемо вручну. ☎️\n\nАбо напишіть іншу послугу.');
  }

  // побажання з тексту («в суботу», «після обіду», «о 15») звужують пошук
  const pref = session.data.pref || {};
  let quick = [];
  try {
    quick = await slotEngine.nearestSlots(ctx.pool, {
      masterIds, durationMin: dur || 60, limit: QUICK_LIMIT,
      days: pref.date ? 1 : MAX_DAYS,
      fromDate: pref.date || null,
      window: pref.win || null,
      perDay: pref.date ? QUICK_LIMIT : 3,
    });
    // на бажаний день/вікно нічого немає → чесно кажемо і показуємо без обмежень
    if (!quick.length && (pref.date || pref.win)) {
      session.data.prefMiss = true; session.data.pref = null;
      quick = await slotEngine.nearestSlots(ctx.pool, { masterIds, durationMin: dur || 60, days: MAX_DAYS, limit: QUICK_LIMIT });
    } else session.data.prefMiss = false;
  } catch (e) { console.error('[bookbot/quick]', e.message); }
  session.data.quick = quick;

  const lines = chosen.map(s => `• ${s.name} — ${priceLabel(s)}`).join('\n');
  const head = chosen.length > 1
    ? `🧩 <b>Комплекс</b>:\n${lines}\n\nРазом: <b>${totalLabel(chosen, total)}</b>, ~${fmtDur(dur)}`
    : `${lines}\n~${fmtDur(dur)}`;
  const mName = session.data.master !== 'any' ? masterNameOf(session, Number(session.data.master)) : null;

  const kb = [];
  if (quick.length) {
    const today = slotEngine.kyivToday(), tomorrow = slotEngine.addDays(today, 1);
    const btns = quick.map((s, i) => ({
      text: `${s.date === today ? 'Сьогодні' : s.date === tomorrow ? 'Завтра' : fmtDateKey(s.date)} ${s.label}`,
      callback_data: `bk:q:${i}`,
    }));
    rows(btns, 2).forEach(r => kb.push(r));
  }
  kb.push([{ text: '📅 Інший день', callback_data: 'bk:day' }, { text: '💇 Обрати майстра', callback_data: 'bk:pickmst' }]);
  kb.push([{ text: '✏️ Інша послуга', callback_data: 'bk:retry' }, { text: '✖ Скасувати', callback_data: 'bk:cancel' }]);

  await saveSession(ctx.pool, uid, target.chat_id, 'quick', session.data);
  const prefNote = session.data.prefMiss
    ? '\n\n😔 На бажаний час вільних вікон немає — ось найближчі:' : '';
  const whenTitle = (!session.data.prefMiss && pref.date)
    ? `⚡ <b>Вільні вікна на ${fmtDateKey(pref.date)}</b> — оберіть час:`
    : `⚡ <b>Найближчі вільні вікна</b> — оберіть час:`;
  const body = quick.length
    ? `${head}${mName ? `\n💇 Майстер: <b>${mName}</b>` : ''}${prefNote}\n\n${whenTitle}`
    : `${head}${mName ? `\n💇 Майстер: <b>${mName}</b>` : ''}\n\n😔 Найближчим часом вільних вікон немає. Спробуйте «Інший день» або іншого майстра.`;
  return respond(ctx.tg, target, body, kb);
}

async function showDates(ctx, uid, target, session) {
  const { chosen, total, dur } = summarize(session);
  if (!chosen.length) return restart(ctx, uid, target, 'Не вдалось визначити послугу.');
  const lines = chosen.map(s => `• ${s.name} — ${priceLabel(s)}`).join('\n');
  const head = chosen.length > 1
    ? `🧩 <b>Комплекс</b>:\n${lines}\n\nРазом: <b>${totalLabel(chosen, total)}</b>, ~${fmtDur(dur)}`
    : `${lines}\n~${fmtDur(dur)}`;

  // «Сьогодні» рахуємо в київському поясі, а не в UTC сервера (Render крутиться на UTC):
  // з 00:00 до 02:59 Kyiv UTC ще вчора → кнопка показувала вчорашню дату (аудит v8).
  // Якір — полудень UTC київської дати (безпечно від переходів DST).
  const kyivToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
  const [ky, km, kd] = kyivToday.split('-').map(Number);
  const base = new Date(Date.UTC(ky, km - 1, kd, 12, 0, 0));
  const btns = [];
  for (let i = 0; i < MAX_DAYS; i++) {
    const d = new Date(base); d.setUTCDate(base.getUTCDate() + i);
    const key = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const label = i === 0 ? 'Сьогодні' : i === 1 ? 'Завтра' : `${d.getUTCDate()} ${MM[d.getUTCMonth()]} (${DOW[d.getUTCDay()]})`;
    btns.push({ text: label, callback_data: `bk:date:${key}` });
  }
  const kb = rows(btns, 2);
  kb.push([{ text: '‹ Найближчі вікна', callback_data: 'bk:back:quick' }, { text: '✖ Скасувати', callback_data: 'bk:cancel' }]);
  await saveSession(ctx.pool, uid, target.chat_id, 'date', session.data);
  return respond(ctx.tg, target, `${head}\n\n📅 Оберіть дату:`, kb);
}

async function showMasters(ctx, uid, target, session) {
  const { chosen } = summarize(session);
  if (!session.data.masters || !session.data.masters.length) {
    try { session.data.masters = await eligibleMasters(ctx.pool, chosen.map(s => s.id)); }
    catch (e) { console.error('[bookbot/masters]', e.message); session.data.masters = []; }
  }
  const btns = [{ text: '⭐ Будь-який вільний майстер', callback_data: 'bk:mst:any' }];
  session.data.masters.forEach(m => btns.push({ text: m.name, callback_data: `bk:mst:${m.id}` }));
  const kb = rows(btns, 1);
  kb.push([{ text: '‹ Найближчі вікна', callback_data: 'bk:back:quick' }, { text: '✖', callback_data: 'bk:cancel' }]);
  await saveSession(ctx.pool, uid, target.chat_id, 'master', session.data);
  return respond(ctx.tg, target, `💇 Оберіть майстра — покажу його вільні вікна:`, kb);
}

// Кнопковий вхід у запис: категорія → послуги (щоб клієнт не друкував текст).
// Далі веде через існуючий bk:cat → вибір послуги → слоти.
const CAT_EMOJI = [
  [/нігт|ногт/i, '💅'], [/волос/i, '💇'], [/бров/i, '👁'], [/вій|вії|вія/i, '👀'],
  [/макіяж|макия/i, '💄'], [/масаж|тіло/i, '💆'], [/депіл|епіл/i, '🪒'],
];
const catEmoji = (c) => (CAT_EMOJI.find(([re]) => re.test(c)) || [, '✨'])[1];
async function showCategories(ctx, target) {
  const cat = await loadCatalog(ctx.pool);
  const cats = [...new Set(cat.services.map(s => s.category).filter(Boolean))];
  if (!cats.length) return respond(ctx.tg, target, 'Напишіть послугу — підберу час.');
  const kb = cats.map(c => [{ text: `${catEmoji(c)} ${c}`, callback_data: `bk:cat:${c.slice(0, 40)}` }]);
  return respond(ctx.tg, target, 'Оберіть напрям — покажу послуги з цінами:', kb);
}

function fmtDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${d} ${MM[m - 1]}, ${DOW[dt.getDay()]}`;
}

async function showSlots(ctx, uid, target, session) {
  const { dur } = summarize(session);
  const date = session.data.date;
  const masterIds = selectedMasterIds(session);
  if (!masterIds.length) return restart(ctx, uid, target, 'Немає доступних майстрів для цієї послуги.');

  // Аудит 13.08: раніше збій движка слотів давав slots=[] і клієнт бачив «вільних годин немає» —
  // технічна аварія виглядала як «салон зайнятий», записи тихо втрачались. Тепер клієнту чесно
  // кажемо про тимчасовий збій і пропонуємо повторити, а не відправляємо його до конкурентів.
  let slots = [];
  try {
    slots = await slotEngine.freeSlotsForDate(ctx.pool, { date, masterIds, durationMin: dur || 60 });
  } catch (e) {
    console.error('[bookbot/slots] ТЕХНІЧНИЙ ЗБІЙ (не показуємо як «немає годин»)', e.message);
    const kbErr = [[{ text: '↻ Спробувати ще раз', callback_data: 'bk:back:date' }],
                   [{ text: '✖ Скасувати', callback_data: 'bk:cancel' }]];
    await saveSession(ctx.pool, uid, target.chat_id, 'date', session.data);
    return respond(ctx.tg, target,
      '⚠️ Тимчасовий технічний збій — не вдалося отримати вільні години. Спробуйте ще раз за хвилину або зателефонуйте нам.', kbErr);
  }
  slots = slots.slice(0, MAX_SLOT_BTN);

  if (!slots.length) {
    const kb = [[{ text: '‹ Інша дата', callback_data: 'bk:back:date' }], [{ text: '✖ Скасувати', callback_data: 'bk:cancel' }]];
    await saveSession(ctx.pool, uid, target.chat_id, 'date', session.data);
    return respond(ctx.tg, target, `😔 На <b>${fmtDateKey(date)}</b> вільних годин немає. Оберіть іншу дату.`, kb);
  }
  session.data.slots = slots;
  const btns = slots.map((s, i) => ({ text: s.label, callback_data: `bk:slot:${i}` }));
  const kb = rows(btns, 4);
  kb.push([{ text: '‹ Інша дата', callback_data: 'bk:back:date' }, { text: '✖', callback_data: 'bk:cancel' }]);
  await saveSession(ctx.pool, uid, target.chat_id, 'slot', session.data);
  return respond(ctx.tg, target, `📅 ${fmtDateKey(date)}\n\n🕐 Оберіть час:`, kb);
}

async function showConfirm(ctx, uid, target, session) {
  const { chosen, total, dur } = summarize(session);
  const slot = session.data.sel;
  if (!slot) return restart(ctx, uid, target, 'Слот не знайдено, почнімо спочатку.');
  const masterName = masterNameOf(session, slot.masterId);
  const svcLines = chosen.map(s => `• ${s.name} — ${priceLabel(s)}`).join('\n');
  const text =
    `<b>Перевірте запис:</b>\n\n${svcLines}\n\n` +
    `💇 Майстер: <b>${masterName}</b>\n` +
    `📅 ${fmtDateKey(slot.date)}, <b>${slot.label}</b>\n` +
    `💰 Разом: <b>${totalLabel(chosen, total)}</b> · ~${fmtDur(dur)}`;
  const kb = [
    [{ text: '✅ Підтвердити запис', callback_data: 'bk:confirm' }],
    [{ text: '‹ Інший час', callback_data: 'bk:back:quick' }, { text: '✖ Скасувати', callback_data: 'bk:cancel' }],
  ];
  await saveSession(ctx.pool, uid, target.chat_id, 'confirm', session.data);
  return respond(ctx.tg, target, text, kb);
}

function masterNameOf(session, masterId) {
  const m = (session.data.masters || []).find(x => Number(x.id) === Number(masterId));
  return m ? m.name : 'Майстер салону';
}

async function restart(ctx, uid, target, why) {
  await clearSession(ctx.pool, uid);
  return respond(ctx.tg, { chat_id: target.chat_id },
    `${why ? why + '\n\n' : ''}Напишіть послугу, на яку хочете записатись (напр. «манікюр», «стрижка і фарбування»).`);
}

// ── фінальне бронювання: CRM-first (журнал салону = наша БД) ──
async function doBook(ctx, uid, chatId, session, phoneDigits, clientName) {
  const { chosen, total } = summarize(session);
  const slot = session.data.sel;
  if (!slot) {
    await clearSession(ctx.pool, uid);
    return ctx.tg('sendMessage', { chat_id: chatId, text: '⌛ Сесія застаріла. Напишіть послугу ще раз.' });
  }
  const masterId = Number(slot.masterId);
  const date = slot.date;
  const phone = '+' + phoneDigits;
  const name = clientName || 'Клієнт';

  // фінальна перевірка: слот могли щойно зайняти (перетин по appointments)
  try {
    const busy = await ctx.pool.query(
      `SELECT 1 FROM appointments
        WHERE master_id=$1 AND status = ANY($4::text[])
          AND starts_at < ${slotEngine.TS_EXPR(2, 5)} AND ends_at > ${slotEngine.TS_EXPR(2, 3)}
        LIMIT 1`,
      [masterId, date, slot.startMin, slotEngine.BUSY_STATUSES, slot.endMin]);
    if (busy.rowCount) {
      await ctx.tg('sendMessage', { chat_id: chatId, text: '😔 Цей час щойно зайняли. Оберіть інший.' });
      return showQuick(ctx, uid, { chat_id: chatId }, session);
    }
  } catch (e) { console.error('[bookbot/recheck]', e.message); }

  // клієнт: знайти за номером або створити
  let clientId = null;
  try {
    let cl = await ctx.pool.query(
      `SELECT id FROM clients WHERE regexp_replace(phone,'\\D','','g')=$1 LIMIT 1`, [phoneDigits]);
    if (cl.rows.length) {
      await ctx.pool.query(
        `UPDATE clients SET telegram_id=COALESCE(telegram_id,$2), name=COALESCE(NULLIF(name,''),$3) WHERE id=$1`,
        [cl.rows[0].id, uid, name]);
    } else {
      cl = await ctx.pool.query(
        `INSERT INTO clients (phone, name, telegram_id, source) VALUES ($1,$2,$3,'bot-chat')
         ON CONFLICT (tenant_id, phone) DO UPDATE SET telegram_id=COALESCE(clients.telegram_id,EXCLUDED.telegram_id)
         RETURNING id`, [require('./phone').normalizePhoneDb(phoneDigits), name, uid]); // канон 380... (#107)
    }
    clientId = cl.rows[0].id;
  } catch (e) {
    console.error('[bookbot/client]', e.message);
    await clearSession(ctx.pool, uid);
    return ctx.tg('sendMessage', { chat_id: chatId, text: '⚠️ Не вдалось створити запис. Адміністратор звʼяжеться з вами.' });
  }

  // записи в журнал салону: послідовні послуги одного майстра — через спільне ядро
  // (lib/booking-core.js: транзакція + advisory-лок майстра + тінь online_bookings; той самий
  // код використовує Mini App, тож гонки між ботом і мініапкою закриті одним локом).
  let apptIds = [];
  let bookingId = null;
  try {
    const res = await require('./booking-core').createBooking({
      pool: ctx.pool, clientId, masterId, masterName: masterNameOf(session, masterId),
      date, startMin: slot.startMin, services: chosen, name, phone, telegramId: uid,
      apptSource: 'bot-chat', obChannel: 'bot',
    });
    apptIds = res.apptIds; bookingId = res.bookingId;
  } catch (e) {
    console.error('[bookbot/appt]', e.message);
    await clearSession(ctx.pool, uid);
    const txt = e.slotTaken
      ? '😔 На жаль, цей час щойно зайняли. Оберіть, будь ласка, інший.'
      : '⚠️ Не вдалось створити запис. Адміністратор звʼяжеться з вами.';
    return ctx.tg('sendMessage', { chat_id: chatId, text: txt });
  }

  // перенос: нова бронь створена → старі записи скасовуємо
  let moved = false;
  if (Array.isArray(session.data.moveIds) && session.data.moveIds.length) {
    try {
      await require('./booking-core').cancelAppointments(ctx.pool, session.data.moveIds);
      moved = true;
    } catch (e) { console.error('[bookbot/move-cancel]', e.message); }
  }

  await clearSession(ctx.pool, uid);
  const masterName = masterNameOf(session, masterId);
  await ctx.tg('sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: `${moved ? '🔁 <b>Запис перенесено!</b>' : '✅ <b>Запис підтверджено!</b>'}\n\n📅 ${fmtDateKey(date)}, <b>${slot.label}</b>\n💇 ${masterName}\n💰 ${totalLabel(chosen, total)}\n\nЧекаємо вас у SVS Beauty Space 💛`,
    reply_markup: mainMenu(),
  });

  // Ненавʼязлива порада-допродаж (лише для нового запису, не для переносу)
  if (!moved) {
    try {
      const cross = await suggestCrossSell(ctx, chosen.map(s => s.name), Number(apptIds && apptIds[0]) || 0);
      if (cross) {
        await ctx.tg('sendMessage', {
          chat_id: chatId, parse_mode: 'HTML',
          text: `💡 ${cross.line}`,
          reply_markup: { inline_keyboard: [
            [{ text: '✨ Так, підібрати час', callback_data: `bk:add:${cross.svc.id}` }],
            [{ text: '🙂 Дякую, ні', callback_data: 'bk:dismiss' }],
          ] },
        });
      }
    } catch (e) { console.error('[bookbot/crosssell]', e.message); }
  }

  // передоплата Mono — fire-and-forget
  if (bookingId && process.env.MONO_TOKEN) {
    setImmediate(async () => {
      try {
        const monoPay = require('../routes/payments-mono');
        const inv = await monoPay.createInvoiceForBooking(bookingId);
        if (inv && inv.pageUrl) {
          await ctx.tg('sendMessage', {
            chat_id: chatId,
            text: `💳 Передоплата: ${inv.amount} грн`,
            reply_markup: { inline_keyboard: [[{ text: `Оплатити ${inv.amount} грн`, url: inv.pageUrl }]] },
          });
        }
      } catch (e) { console.error('[bookbot/prepay]', e.message); }
    });
  }
}

// ═══════════════════════════════════════════════════════════════
//  ПУБЛІЧНІ ХЕНДЛЕРИ (викликає routes/booking.js)
// ═══════════════════════════════════════════════════════════════

// Вільний текст: старт або уточнення послуги.
// Повертає true якщо повідомлення оброблено цим модулем.
// FAQ-відповіді з профілю салону (графік/адреса/телефон) — шар 2 «віртуального керуючого».
// Повертає текст відповіді або null, якщо питання не про FAQ.
async function tryFaq(text, ctx) {
  const t = text.toLowerCase();
  const isHours = /графік|час(и|у)? робот|коли (ви )?(працює|відкрит|зачинен)|режим робот|до котр|з котр|робочі години|когда (вы )?работа|во сколько/.test(t);
  const isAddr = /адрес|де ви|де знаход|доїхати|дістат|проїзд|як пройти|як знайти|локац|орієнтир|куди (їхати|йти|іти)|где (вы )?наход/.test(t);
  const isPhone = /телефон|номер|подзвон|зв.?яза|контакт|вайбер|viber|whats|зателеф/.test(t);
  if (!isHours && !isAddr && !isPhone) return null;
  let sp = {};
  try { sp = (await ctx.pool.query(`SELECT value FROM app_settings WHERE key='salon_profile'
    AND tenant_id IN (COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid), '00000000-0000-0000-0000-000000000001'::uuid)
    ORDER BY (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid)) DESC LIMIT 1`)).rows[0]?.value || {}; } catch (_) {}
  const out = [];
  if (sp.name) out.push(`<b>${sp.name}</b>`);
  if (isHours && sp.hours) out.push(`🕐 Графік роботи: <b>${sp.hours}</b>`);
  if (isAddr) {
    if (sp.address) out.push(`📍 Адреса: <b>${sp.address}</b>`);
    if (sp.landmarks) out.push(`🧭 ${sp.landmarks}`);
  }
  if (isPhone && sp.phones) out.push(`📞 Телефон: <b>${sp.phones}</b>`);
  if (out.length <= 1) return null; // профіль порожній по запитаному — не вдаємо, що відповіли
  const socials = salonSocialLinks(sp);
  if (socials) out.push(socials);
  out.push(`\nНапишіть назву послуги — підберу вільний час і запишу. 💛`);
  return out.join('\n');
}

/** Клікабельні соцмережі салону для повідомлень бота (Босс 17.07.2026). */
function salonSocialLinks(sp) {
  const links = [];
  const ig = String(sp.instagram || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/+$/, '');
  const tt = String(sp.tiktok || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/i, '').replace(/\/+$/, '');
  const fb = String(sp.facebook || '').trim();
  if (ig) links.push(`<a href="https://instagram.com/${ig}">Instagram</a>`);
  if (tt) links.push(`<a href="https://www.tiktok.com/@${tt}">TikTok</a>`);
  if (fb) links.push(`<a href="${/^https?:\/\//i.test(fb) ? fb : 'https://facebook.com/' + fb.replace(/^@/, '')}">Facebook</a>`);
  return links.length ? `✨ Ми в соцмережах: ${links.join(' · ')}` : '';
}

// ── постійне меню (замінює старе меню погашеного сервісу запису в чатах клієнтів)
// ── Mini App: посилання й кнопки ───────────────────────────────────────────
function miniappLink(ctx, q) {
  const u = String(ctx.miniappUrl || '');
  const qs = q ? new URLSearchParams(q).toString() : '';
  return qs ? u + (u.includes('?') ? '&' : '?') + qs : u;
}
function miniappKb(ctx) {
  return { inline_keyboard: [
    [{ text: '✨ Записатися онлайн', web_app: { url: miniappLink(ctx) } }],
    [{ text: '👤 Мій кабінет', web_app: { url: miniappLink(ctx, { screen: 'cabinet' }) } },
     { text: '🧚 Адміністратор', callback_data: 'bk:adm' }],
  ] };
}
// Кнопки старого нижнього меню в режимі мініапки: «Записатись/Кабінет/Мої записи» → мініапка,
// «Адміністратор» і «Приховати меню» — як були. Повертає true, якщо оброблено.
async function miniappMenuText(text, msg, ctx) {
  const chatId = msg.chat.id;
  const t = text.toLowerCase().replace(/[^а-яёіїєґa-z0-9 ']/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (/адміністратор/.test(t)) { await showAdminContact(ctx, chatId); return true; }
  if (/^приховати меню$|^сховати меню$|^згорнути меню$|^приховати$/.test(t)) {
    await ctx.tg('sendMessage', { chat_id: chatId, text: '✅ Меню приховано. Записатись можна кнопкою «Запис» внизу ліворуч від поля вводу.', reply_markup: { remove_keyboard: true } });
    return true;
  }
  const cab = /кабінет|мої записи|мої візити|бонус/.test(t);
  if (cab || /^записатись( на візит)?$|^запис(атися)?$|^меню$|^назад$|^головне меню$|^прайс( ?лист)?$|^послуги$/.test(t)) {
    // 04.11 (Босс: «зачем лишний раз клацать»): старе нижнє меню шле лише текст, а мініапку з нижньої
    // клавіатури відкривати не можна — Telegram тоді не передає підписаного клієнта (initData порожній).
    // Тому прибираємо старе меню ЦИМ ЖЕ повідомленням і чіпляємо до нього кнопку мініапки;
    // далі клієнт відкриває запис в один дотик кнопкою «Запис» зліва від поля вводу.
    const kb = cab
      ? { inline_keyboard: [[{ text: '👤 Відкрити кабінет', web_app: { url: miniappLink(ctx, { screen: 'cabinet' }) } }]] }
      : miniappKb(ctx);
    // 04.11 аудит: повідомлення з remove_keyboard Telegram редагувати НЕ дає («message can't be edited») —
    // старий варіант (edit → inline-кнопка) завжди падав і слав друге «👇». Тепер: службове повідомлення
    // прибирає клавіатуру й одразу видаляється, клієнт бачить ОДНЕ повідомлення з кнопкою застосунку.
    const r = await ctx.tg('sendMessage', { chat_id: chatId, text: '⏳', reply_markup: { remove_keyboard: true } });
    const mid = r && r.ok && r.result && r.result.message_id;
    if (mid) await ctx.tg('deleteMessage', { chat_id: chatId, message_id: mid });
    await ctx.tg('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: (cab ? '👤 Ваші записи, історія візитів і бонуси — у застосунку.' : '✨ Запис онлайн — оберіть послугу, майстра й час.')
        + '\nНадалі відкривайте одним дотиком: кнопка <b>«Запис»</b> зліва від поля вводу.',
      reply_markup: kb,
    });
    return true;
  }
  return false;
}
async function notifyStaffCancel(ctx, ids, how) {
  const r = await ctx.pool.query(
    `SELECT a.id, c.name, c.phone, COALESCE(NULLIF(m.online_title,''), m.name) AS master_name,
            s.name AS service_name, to_char(a.starts_at AT TIME ZONE 'Europe/Kyiv','DD.MM о HH24:MI') AS lbl
       FROM appointments a LEFT JOIN clients c ON c.id=a.client_id
       LEFT JOIN masters m ON m.id=a.master_id LEFT JOIN services s ON s.id=a.service_id
      WHERE a.id = ANY($1::int[]) ORDER BY a.starts_at LIMIT 1`, [ids]);
  const x = r.rows[0]; if (!x) return;
  const esc = (v) => String(v == null ? '' : v).replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
  await require('./booking-core').notifyStaff(ctx.pool, ctx.tg,
    `✖ <b>Клієнт скасував запис</b> (${esc(how)})\n👤 ${esc(x.name || 'Клієнт')} ${esc(fmtPhoneFull(x.phone))}\n💅 ${esc(x.service_name || '')}\n💇 ${esc(x.master_name || '')}\n📅 ${esc(x.lbl)}`);
}

function mainMenu() {
  // режим мініапки (за замовчуванням): старої нижньої клавіатури немає — запис кнопкою «Запис» біля поля вводу
  if (process.env.BOT_TEXT_BOOKING !== '1') return { remove_keyboard: true };
  return {
    keyboard: [
      [{ text: '🗓 Записатись' }],
      [{ text: '👤 Мій кабінет' }, { text: '🧚 Адміністратор' }],
      [{ text: '🔽 Приховати меню' }],
    ],
    resize_keyboard: true,
  };
}

// майбутні візити клієнта з кнопками перенести/скасувати (повторно використовує bk:r:*)
// ── Бот-консультант: ненавʼязливий крос-сел після запису ───────────────────
// Пропонуємо ЛИШЕ доповнюючу послугу до вже заброньованої, і лише якщо її реально
// можна записати (є онлайн-майстер). Багато варіацій фраз, щоб не повторюватись.
// Головне — не плутати клієнта: одна доречна пропозиція, легко відмовитись.
const CROSS_RULES = [
  { when: /манікюр/, target: /педикюр/, lines: [
    'До манікюру гарно додати педикюр — підібрати час?',
    'Багато клієнток роблять манікюр і педикюр разом. Показати вільний час на педикюр?',
    'Хочете, щоб і ніжки були доглянуті? Можу підказати час на педикюр 💅',
    'Часто беруть манікюр + педикюр в один візит — цікаво додати педикюр?' ] },
  { when: /педикюр/, target: /манікюр/, lines: [
    'До педикюру зазвичай додають манікюр — підібрати час?',
    'Зробимо руки й ніжки в парі? Показати вільний час на манікюр?',
    'Багато хто поєднує педикюр з манікюром — цікаво додати?' ] },
  { when: /стрижк/, target: /фарбуванн/, lines: [
    'До стрижки часто освіжають колір — підказати час на фарбування?',
    'Свіжа стрижка + фарбування = завершений образ. Показати вільні вікна?',
    'Хочете оновити й колір? Можу підібрати час на фарбування 💇' ] },
  { when: /фарбуванн|мелірува/, target: /стрижк/, lines: [
    'До фарбування гарно оновити форму — підказати час на стрижку?',
    'Освіжимо й кінчики? Показати вільний час на стрижку?',
    'Багато хто після фарбування робить стрижку — цікаво додати?' ] },
  { when: /брів|брови/, target: /(ламінування|нарощування)\s*вій/, lines: [
    'До брів гарно пасує ламінування вій — підібрати час?',
    'Брови + вії = виразний погляд. Показати вільний час на вії?',
    'Хочете підкреслити погляд? Можу підказати час на вії 👀' ] },
  { when: /вій|вії/, target: /(ламінування|корекц|фарбуванн)[а-яіїєґ ]*бр/, lines: [
    'До вій часто роблять корекцію брів — підібрати час?',
    'Вії + доглянуті брови — гарний дует. Показати вільний час на брови?',
    'Хочете завершити образ бровами? Можу підказати вільний час 👁' ] },
];
async function suggestCrossSell(ctx, bookedNames, seed) {
  const joined = (bookedNames || []).join(' ').toLowerCase();
  for (const rule of CROSS_RULES) {
    if (!rule.when.test(joined)) continue;
    if (rule.target.test(joined)) return null;      // вже беруть це — не пропонуємо те саме
    const cat = await loadCatalog(ctx.pool);
    const cand = cat.services.filter(s => rule.target.test((s.name || '').toLowerCase()));
    for (const s of cand) {
      try { const m = await eligibleMasters(ctx.pool, [s.id]); if (m.length) return { svc: s, line: rule.lines[Math.abs(seed || 0) % rule.lines.length] }; }
      catch (_) {}
    }
    return null;                                     // правило підійшло, та бронювати нічого — мовчимо
  }
  return null;
}

// ── Особистий кабінет клієнта ──────────────────────────────────────────────
async function showCabinet(ctx, uid, chatId) {
  const cl = await getClient(ctx.pool, uid);
  if (!cl) {
    return ctx.tg('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: '👤 <b>Мій кабінет</b>\n\nЩоб відкрити кабінет — поділіться номером, і я підтягну ваші записи, бонуси та сертифікати 💛',
      reply_markup: { keyboard: [[{ text: '📱 Поділитись номером', request_contact: true }]], one_time_keyboard: true, resize_keyboard: true },
    });
  }
  const st = (await ctx.pool.query(
    `SELECT COALESCE(total_visits,0) v, COALESCE(loyalty_points,0) pts FROM clients WHERE id=$1`, [cl.id])).rows[0] || {};
  const head = `👤 <b>${cl.name || 'Мій кабінет'}</b>\n` +
    `🎁 Бонусів: <b>${Math.round(st.pts)}</b> (= ${Math.round(st.pts)} ₴ знижки)\n` +
    (Number(st.v) ? `💛 Візитів: ${st.v}` : 'Раді вітати вас 💛'); // 04.11: суми витрат клієнту не показуємо
  const kb = [
    [{ text: '📅 Мої записи', callback_data: 'bk:cab:visits' }],
    [{ text: '🎁 Мої бонуси', callback_data: 'bk:cab:bonus' }],
    [{ text: '🎟 Мої сертифікати', callback_data: 'bk:cab:certs' }],
    [{ text: '👤 Профіль', callback_data: 'bk:cab:profile' }],
  ];
  return ctx.tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: head, reply_markup: { inline_keyboard: kb } });
}

const cabBack = { inline_keyboard: [[{ text: '‹ Кабінет', callback_data: 'bk:cab:home' }]] };

async function showBonuses(ctx, uid, chatId) {
  const cl = await getClient(ctx.pool, uid);
  if (!cl) return showCabinet(ctx, uid, chatId);
  const pts = Math.round((await ctx.pool.query(`SELECT COALESCE(loyalty_points,0) p FROM clients WHERE id=$1`, [cl.id])).rows[0].p);
  const out = [`🎁 <b>Ваші бонуси</b>\n\nБаланс: <b>${pts}</b> бонусів = <b>${pts} ₴</b> знижки`];
  try {
    const exp = (await ctx.pool.query(
      `SELECT COALESCE(SUM(remaining),0) s, MIN(expires_at) e FROM bonus_transactions
        WHERE client_id=$1 AND COALESCE(remaining,0)>0 AND expires_at IS NOT NULL AND expires_at>NOW()`, [cl.id])).rows[0];
    if (exp && exp.e && Number(exp.s) > 0) out.push(`⏳ ${Math.round(exp.s)} бонусів згорять ${new Date(exp.e).toLocaleDateString('uk-UA')} — встигніть використати`);
    const tx = (await ctx.pool.query(
      `SELECT amount, description, to_char(created_at AT TIME ZONE 'Europe/Kyiv','DD.MM.YY') d
         FROM bonus_transactions WHERE client_id=$1 ORDER BY created_at DESC LIMIT 6`, [cl.id])).rows;
    if (tx.length) { out.push('\n<b>Останні операції:</b>'); tx.forEach(t => { const plus = Number(t.amount) >= 0; out.push(`${plus ? '➕' : '➖'} ${Math.abs(Math.round(t.amount))} — ${t.description || (plus ? 'нараховано' : 'списано')} · ${t.d}`); }); }
    else out.push('\nБонуси нараховуються автоматично за кожен візит — і ними можна оплатити частину наступного 💛');
  } catch (e) { console.error('[bookbot/bonus]', e.message); }
  return ctx.tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: out.join('\n'), reply_markup: cabBack });
}

async function showCerts(ctx, uid, chatId) {
  const cl = await getClient(ctx.pool, uid);
  if (!cl) return showCabinet(ctx, uid, chatId);
  let certs = [];
  try {
    certs = (await ctx.pool.query(
      `SELECT code, remaining_amount, valid_until FROM gift_certificates
        WHERE regexp_replace(COALESCE(recipient_phone,buyer_phone,''),'\\D','','g') = $1
          AND COALESCE(status,'') NOT IN ('used','expired','cancelled') AND COALESCE(remaining_amount,0) > 0
        ORDER BY valid_until NULLS LAST LIMIT 10`, [cl.digits])).rows;
  } catch (e) { console.error('[bookbot/certs]', e.message); }
  if (!certs.length) return ctx.tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: '🎟 <b>Сертифікати</b>\n\nАктивних сертифікатів немає.\nПодарунковий сертифікат можна придбати в салоні 💛', reply_markup: cabBack });
  const lines = certs.map(c => `🎟 <code>${c.code}</code> — <b>${Math.round(c.remaining_amount)} ₴</b>${c.valid_until ? ` (до ${new Date(c.valid_until).toLocaleDateString('uk-UA')})` : ''}`);
  return ctx.tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `🎟 <b>Ваші сертифікати</b>\n\n${lines.join('\n')}\n\nНазвіть код адміністратору при оплаті.`, reply_markup: cabBack });
}

async function showProfile(ctx, uid, chatId) {
  const cl = await getClient(ctx.pool, uid);
  if (!cl) return showCabinet(ctx, uid, chatId);
  const c = (await ctx.pool.query(
    `SELECT name, phone, to_char(birthday,'DD.MM.YYYY') bday, COALESCE(total_visits,0) v,
            to_char(first_visit_at,'DD.MM.YYYY') fv FROM clients WHERE id=$1`, [cl.id])).rows[0];
  const out = ['👤 <b>Профіль</b>\n', `Імʼя: <b>${c.name || '—'}</b>`, `Телефон: ${fmtPhoneFull(c.phone)}`, `День народження: ${c.bday || 'не вказано'}`];
  if (Number(c.v)) out.push(`\n💛 З нами: ${c.v} візит(ів)${c.fv ? ` з ${c.fv}` : ''}`);
  const kb = [];
  if (!c.bday) kb.push([{ text: '🎂 Вказати день народження', callback_data: 'bk:cab:setbday' }]);
  kb.push([{ text: '‹ Кабінет', callback_data: 'bk:cab:home' }]);
  return ctx.tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: out.join('\n'), reply_markup: { inline_keyboard: kb } });
}

async function showMyVisits(ctx, uid, chatId) {
  const r = await ctx.pool.query(
    `SELECT a.id,
            to_char(a.starts_at AT TIME ZONE 'Europe/Kyiv', 'DD.MM о HH24:MI') AS label,
            s.name AS service_name,
            COALESCE(NULLIF(m.online_title,''), m.name) AS master_name
       FROM appointments a
       JOIN clients c ON c.id = a.client_id
       LEFT JOIN services s ON s.id = a.service_id
       LEFT JOIN masters m ON m.id = a.master_id
      WHERE c.telegram_id = $1 AND a.status IN ('booked','confirmed') AND a.starts_at > NOW()
      ORDER BY a.starts_at LIMIT 6`, [uid]);
  if (!r.rows.length) {
    return ctx.tg('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: 'У вас немає майбутніх записів.\nНапишіть послугу (напр. «манікюр») — підберу найближчий вільний час 💛',
      reply_markup: mainMenu(),
    });
  }
  const kb = [];
  const lines = r.rows.map((v, i) => {
    kb.push([{ text: `🔁 Перенести №${i + 1}`, callback_data: `bk:r:mv:${v.id}` },
             { text: `✖ Скасувати №${i + 1}`, callback_data: `bk:r:cn:${v.id}` }]);
    return `${i + 1}. <b>${v.label}</b> — ${v.service_name || 'візит'}${v.master_name ? ` (${v.master_name})` : ''}`;
  });
  return ctx.tg('sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: `<b>Ваші майбутні записи:</b>\n\n${lines.join('\n')}`,
    reply_markup: { inline_keyboard: kb },
  });
}

// контакти адміністратора з профілю салону
async function showAdminContact(ctx, chatId) {
  let sp = {};
  try { sp = (await ctx.pool.query(`SELECT value FROM app_settings WHERE key='salon_profile'
    AND tenant_id IN (COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid), '00000000-0000-0000-0000-000000000001'::uuid)
    ORDER BY (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid)) DESC LIMIT 1`)).rows[0]?.value || {}; } catch (_) {}
  // Telegram робить номер клікабельним лише у чистому форматі (без дужок).
  // «+380 (99) 128 33 75» → «+380991283375» — тапаєш прямо по цифрах і дзвониш.
  const firstPhoneRaw = String(sp.phones || '').split(/[,;/]/)[0].trim();
  const phoneDigits = firstPhoneRaw.replace(/[^\d+]/g, '');
  const phoneTap = phoneDigits.startsWith('+') ? phoneDigits : (phoneDigits ? '+' + phoneDigits.replace(/^\++/, '') : '');
  const out = ['🧚 <b>Адміністратор салону</b>'];
  if (phoneTap) out.push(`📞 ${phoneTap}`);
  else if (sp.phones) out.push(`📞 ${sp.phones}`);
  if (sp.address) out.push(`📍 ${sp.address}`);
  if (sp.hours) out.push(`🕐 ${sp.hours}`);
  const socials2 = salonSocialLinks(sp);
  if (socials2) out.push(socials2);
  out.push('\nТисніть на номер вище, щоб подзвонити, або напишіть питання прямо тут.');
  await ctx.tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: out.join('\n'), reply_markup: mainMenu() });

  // Клікабельний номер: окрема картка контакту з кнопкою «Подзвонити» (заметка Босса).
  // Беремо перший номер, лишаємо цифри та провідний «+» — Telegram зробить його дзвінким.
  const raw = String(sp.phones || '').split(/[,;/]/)[0].trim();
  const digits = raw.replace(/[^\d+]/g, '');
  const phone = digits.startsWith('+') ? digits : (digits ? '+' + digits.replace(/^\+*/, '') : '');
  if (phone && phone.replace(/\D/g, '').length >= 10) {
    try {
      await ctx.tg('sendContact', {
        chat_id: chatId,
        phone_number: phone,
        first_name: (sp.name || 'Салон') + ' — адміністратор',
      });
    } catch (e) { console.error('[bookbot/admin-contact]', e.message); }
  }
  return true;
}

// кнопки старого меню (лишились у чатах клієнтів) + нашого нового — обробка ДО матчера послуг
async function tryMenuButton(text, msg, ctx) {
  const uid = msg.from.id, chatId = msg.chat.id;
  // лишаємо ТІЛЬКИ кирилицю/латиницю/цифри (ℹ та інші емодзі Unicode вважає «буквами» — \p{L} не годиться)
  const t = text.toLowerCase().replace(/[^а-яёіїєґa-z0-9 ']/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return false;

  if (/^записатись( на візит)?$|^запис(атися)?$/.test(t)) {
    // кнопковий вхід: одразу категорії, друкувати не треба
    await showCategories(ctx, { chat_id: chatId });
    return true;
  }
  if (/^мій кабінет$|^кабінет$|^особистий кабінет$/.test(t)) { await showCabinet(ctx, uid, chatId); return true; }
  if (/^мої записи$/.test(t)) { await showMyVisits(ctx, uid, chatId); return true; }
  if (/адміністратор/.test(t)) { await showAdminContact(ctx, chatId); return true; }
  if (/^прайс( ?лист)?$/.test(t)) {
    const cat = await loadCatalog(ctx.pool);
    const cats = [...new Set(cat.services.map(s => s.category).filter(Boolean))];
    await ctx.tg('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: 'Оберіть напрям — покажу послуги з цінами:',
      reply_markup: { inline_keyboard: cats.map(c => [{ text: c, callback_data: `bk:cat:${c.slice(0, 40)}` }]) },
    });
    return true;
  }
  // «Назад» / «Меню» — повертаємо у ГОЛОВНЕ меню (owner або клієнт), а не заглушку.
  // Кнопка «Назад» лишилась у частині чатів від старого бота — раніше вела в «розділ оновлюється».
  if (/^назад$|^меню$|^☰ ?меню$|^головне меню$|^на головну$|^в меню$/.test(t)) {
    const owner = await ownerTgUser(ctx, uid);
    await ctx.tg('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: owner ? '☰ Головне меню керування' : 'Головне меню 💛\nОберіть дію нижче або напишіть послугу.',
      reply_markup: owner ? ownerMenu() : mainMenu(),
    });
    return true;
  }
  // «Приховати меню» — ховаємо нижню клавіатуру. Повернути: слово «меню» або команда /menu.
  if (/^приховати меню$|^сховати меню$|^згорнути меню$|^приховати$/.test(t)) {
    await ctx.tg('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: '✅ Меню приховано. Щоб відкрити знову — напишіть <b>меню</b> або /menu.',
      reply_markup: { remove_keyboard: true },
    });
    return true;
  }
  // функції старого бота, що переїхали/вимкнені — мʼякий фолбек, а не «не впізнав послугу»
  if (/^магазин косметики$|^отримати знижку$|^запросити подругу$|^мій графік$/.test(t)) {
    await ctx.tg('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: 'Цей розділ оновлюється 🛠\nЩоб записатись — напишіть послугу (напр. «манікюр»). З інших питань — 🧚 Адміністратор.',
      reply_markup: mainMenu(),
    });
    return true;
  }
  return false;
}

// ── МЕНЮ ВЛАСНИКА (ізольоване від клієнтів) ────────────────────────────────
// Власник = користувач салону з роллю owner/повним доступом, чий telegram_id
// збігається з відправником. Клієнт (є лише в clients) НІКОЛИ не бачить це меню.
async function ownerTgUser(ctx, uid) {
  if (!ctx || !ctx.tenantId) return null;
  try {
    const r = await ctx.pool.query(
      `SELECT u.id, u.display_name FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.telegram_id = $2 AND COALESCE(u.is_active, true) = true
          -- лише СПРАВЖНІЙ власник: роль owner або повний доступ (jsonb містить САМЕ '*');
          -- НЕ text LIKE '%*%' — "crm.*" адміна теж містить зірочку (витік фінансів)
          AND (r.code = 'owner' OR r.name ILIKE '%власн%' OR r.name ILIKE '%owner%'
               OR r.permissions::jsonb ? '*')
        LIMIT 1`, [ctx.tenantId, uid]);
    if (r.rows[0]) return r.rows[0];
    // Фолбек-автопривʼязка: власник уже відомий боту як КЛІЄНТ (шарив контакт раніше —
    // Telegram гарантував володіння номером), а телефон клієнтської картки збігається з
    // owner-обліковкою БЕЗ telegram_id → привʼязуємо. Кейс СВС: бот вітав як клієнта і
    // кнопку контакту не показував, привʼязатись не було чим.
    const link = await ctx.pool.query(
      `UPDATE users u SET telegram_id = $2, updated_at = NOW()
         FROM roles r, clients c
        WHERE r.id = u.role_id AND u.tenant_id = $1 AND u.telegram_id IS NULL
          AND COALESCE(u.is_active, true) = true
          AND c.tenant_id = $1 AND c.telegram_id = $2
          AND regexp_replace(COALESCE(u.phone,''), '\\D', '', 'g')
              = regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g')
          AND regexp_replace(COALESCE(u.phone,''), '\\D', '', 'g') <> ''
          AND (r.code = 'owner' OR r.name ILIKE '%власн%' OR r.name ILIKE '%owner%'
               OR r.permissions::jsonb ? '*')
        RETURNING u.id, u.display_name`, [ctx.tenantId, uid]);
    return link.rows[0] || null;
  } catch (_) { return null; }
}
function ownerMenu() {
  return {
    keyboard: [
      [{ text: '📊 Звіт сьогодні' }, { text: '📆 Звіт за місяць' }],
      [{ text: '💰 Каса' }, { text: '📅 Записи' }],
      [{ text: '👥 Майстри' }, { text: '📦 Залишки' }],
      [{ text: '🗓 Записатись' }],
      [{ text: '🔽 Приховати меню' }],
    ],
    resize_keyboard: true,
  };
}
// /start власника → вітання + його меню
async function tryOwnerStart(msg, ctx) {
  const owner = await ownerTgUser(ctx, msg.from.id);
  if (!owner) return false;
  await ctx.tg('sendMessage', {
    chat_id: msg.chat.id, parse_mode: 'HTML',
    text: `👑 Вітаю, <b>${owner.display_name || 'власник'}</b>!\nМеню керування салоном нижче.`,
    reply_markup: ownerMenu(),
  });
  return true;
}
// Обробка кнопок власника. Повертає true, якщо це була owner-кнопка.
async function handleOwnerButton(text, msg, ctx) {
  const send = (t) => ctx.tg('sendMessage', { chat_id: msg.chat.id, parse_mode: 'HTML', text: t, reply_markup: ownerMenu() });
  const { buildDailyReport, formatReport, money } = require('./owner-report');
  const tid = ctx.tenantId;
  if (/^📊\s*Звіт/i.test(text)) {
    await send(formatReport(await buildDailyReport(ctx.pool, tid, null), 'Звіт за сьогодні'));
    return true;
  }
  if (/^📆\s*Звіт/i.test(text)) {
    const { buildMonthlyReport, formatMonthlyReport } = require('./owner-report');
    await send(formatMonthlyReport(await buildMonthlyReport(ctx.pool, tid)));
    return true;
  }
  if (/^💰\s*Каса/i.test(text)) {
    const r = await buildDailyReport(ctx.pool, tid, null);
    await send(`💰 <b>Каса сьогодні: ${money(r.revenue)}</b> (${r.checks} чек.)\n   • Послуги ${money(r.services)} · Косметика ${money(r.cosmetics)}\n   • Готівка ${money(r.cash)} · Безнал ${money(r.cashless)}\n💸 Витрати: ${money(r.expenses)}\n🏦 Залишок: ${money(r.balance)}`);
    return true;
  }
  if (/^📅\s*Записи/i.test(text)) {
    const r = await buildDailyReport(ctx.pool, tid, null);
    await send(`📅 <b>Записи</b>\n👥 Сьогодні клієнтів: ${r.clients.total} (🆕 ${r.clients.new} · 🔁 ${r.clients.repeat})${r.clients.noshow ? `\n⚠️ Не прийшли: ${r.clients.noshow}` : ''}\n🕓 Вільно завтра: ${r.freeTomorrowH} год\n➡️ На 7 днів: ${r.forward.count} записів на ${money(r.forward.revenue)}`);
    return true;
  }
  if (/^👥\s*Майстри/i.test(text)) {
    const r = await buildDailyReport(ctx.pool, tid, null);
    let t = '👥 <b>Завантаженість майстрів сьогодні</b>\n';
    if (r.load && r.load.length) for (const m of r.load) {
      const pct = m.work_min > 0 ? Math.round(m.busy_min / m.work_min * 100) : 0;
      t += `   • ${m.name}: ${pct}%\n`;
    } else t += 'Сьогодні ніхто не працює за графіком.\n';
    if (r.bestMaster) t += `🏆 Кращий сьогодні: ${r.bestMaster.name} — ${money(r.bestMaster.revenue)}`;
    await send(t);
    return true;
  }
  if (/^📦\s*Залишк/i.test(text)) {
    let rows = [];
    try {
      rows = (await ctx.pool.query(
        `SELECT name, COALESCE(stock_qty, inventory, 0)::numeric q FROM products
          WHERE tenant_id = $1 AND COALESCE(stock_qty, inventory, 0) <= COALESCE(min_qty, 3)
          ORDER BY q ASC LIMIT 15`, [tid])).rows;
    } catch (_) { rows = []; }
    if (!rows.length) await send('📦 <b>Залишки</b>\nВсе гаразд — нічого критично не закінчується.');
    else await send('📦 <b>Закінчується (дозамовити):</b>\n' + rows.map(x => `   • ${x.name} — ${Number(x.q)}`).join('\n'));
    return true;
  }
  return false; // не owner-кнопка (напр. «🗓 Записатись») → звичайний потік
}

async function onText(msg, ctx) {
  const uid = msg.from.id, chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) return false; // команди — не сюди

  // Гілка власника: відправник — власник салону і натиснув owner-кнопку →
  // обробляємо і виходимо. Клієнтський потік нижче не зачіпається.
  {
    const owner = await ownerTgUser(ctx, uid);
    if (owner && await handleOwnerButton(text, msg, ctx)) return true;
  }

  // РЕЖИМ MINI APP (ctx.miniappUrl задає routes/booking.js; відкат — env BOT_TEXT_BOOKING=1):
  // текстового запису немає — кнопки старого меню й вільний текст ведуть у мініапку.
  if (ctx.miniappUrl) {
    if (await miniappMenuText(text, msg, ctx)) return true;
  } else if (await tryMenuButton(text, msg, ctx)) return true; // кнопки меню — ДО матчера

  // FAQ перед розпізнаванням послуги: графік/адреса/телефон
  const faq = await tryFaq(text, ctx);
  if (faq) {
    await ctx.tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: faq,
      ...(ctx.miniappUrl ? { reply_markup: miniappKb(ctx) } : {}) });
    return true;
  }

  // Введення дати народження з кабінету (стан сесії 'bday')
  {
    const bs = await loadSession(ctx.pool, uid);
    if (bs && bs.state === 'bday') {
      const m = text.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/);
      if (!m) { await ctx.tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: 'Не впізнав дату. Напишіть у форматі <b>ДД.ММ.РРРР</b>, напр. 25.12.1990.' }); return true; }
      const [_, dd, mm, yy] = m;
      const iso = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      const ok = !isNaN(Date.parse(iso)) && +mm >= 1 && +mm <= 12 && +dd >= 1 && +dd <= 31;
      if (!ok) { await ctx.tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: 'Дата виглядає некоректною. Спробуйте ще раз: <b>ДД.ММ.РРРР</b>.' }); return true; }
      try {
        await ctx.pool.query(`UPDATE clients SET birthday=$1, updated_at=NOW() WHERE telegram_id=$2`, [iso, uid]);
        await clearSession(ctx.pool, uid);
        await ctx.tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `✅ Дякуємо! День народження збережено (${dd}.${mm}.${yy}). Чекайте приємний сюрприз 🎂💛`, reply_markup: mainMenu() });
      } catch (e) { console.error('[bookbot/bday]', e.message); await ctx.tg('sendMessage', { chat_id: chatId, text: 'Не вдалось зберегти зараз, спробуйте пізніше.' }); }
      return true;
    }
  }

  // Mini App: будь-який інший текст — НЕ запускаємо старий діалог, а ввічливо ведемо в мініапку
  if (ctx.miniappUrl) {
    await ctx.tg('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: 'Дякуємо за повідомлення 💛\nЗапис тепер — у зручному застосунку: оберіть послугу, майстра й час у кілька дотиків. Там же ваш кабінет і записи.\n\nЯкщо потрібна людина — натисніть «Адміністратор».',
      reply_markup: miniappKb(ctx),
    });
    return true;
  }

  // «комплекс/все разом/пакет» — це не окрема послуга, а набір. Підказуємо назвати конкретні,
  // бо матчер поверне «не впізнав». Одразу пояснюємо як записатись на кілька послуг разом.
  if (/^(комплекс(но|на|не)?|комбо|все\s*разом|усе\s*разом|пакет|набір)$/i.test(text.replace(/[.!?]/g, '').trim())) {
    await ctx.tg('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: 'Напишіть, які саме послуги хочете разом — я підберу час на все.\nНапр. «<b>манікюр + педикюр</b>» або «<b>стрижка і фарбування</b>».',
      reply_markup: mainMenu(),
    });
    return true;
  }

  // «хочу в суботу пофарбуватись після обіду» → дата/вікно окремо, послуга окремо.
  // Парсер детермінований (без ШІ): що не розпізнав на 100% — клієнт обере кнопками.
  const intent = require('./date-intent').parse(text);
  const svcText = intent.cleaned || text;

  const cat = await loadCatalog(ctx.pool);
  const result = matcher.match(svcText, cat.indexed);
  const parts = result.parts
    .map(p => ({
      query: p.query,
      candidates: p.matches.map(m => cat.byId.get(m.id)).filter(Boolean),
    }))
    .filter(p => p.candidates.length);

  if (!parts.length) {
    // нічого не впізнали → пропонуємо категорії
    const cats = [...new Set(cat.services.map(s => s.category).filter(Boolean))];
    const btns = cats.map(c => [{ text: c, callback_data: `bk:cat:${c.slice(0, 40)}` }]);
    await ctx.tg('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: `Не впізнав послугу «<b>${text}</b>». Оберіть категорію або напишіть інакше:`,
      reply_markup: { inline_keyboard: btns },
    });
    return true;
  }

  // авто-вибір однозначних частин
  parts.forEach(p => { if (p.candidates.length === 1) p.pick = p.candidates[0]; });
  const session = { data: { parts, date: null, master: null } };
  if (intent.date || intent.win) session.data.pref = { date: intent.date, win: intent.win };
  await advance(ctx, uid, { chat_id: chatId }, session);
  return true;
}

// Натискання inline-кнопки.
async function onCallback(cq, ctx) {
  const uid = cq.from.id;
  const chatId = cq.message ? cq.message.chat.id : uid;
  const msgId = cq.message ? cq.message.message_id : null;
  const target = { chat_id: chatId, message_id: msgId };
  const data = cq.data || '';
  const ack = () => ctx.tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});

  if (data === 'bk:adm') { await ack(); await showAdminContact(ctx, chatId); return true; }

  // Лист очікування: клієнт відповідає на пропозицію вільного слота (wl:confirm/decline:ID)
  if (data.startsWith('wl:')) {
    const [, act, wid] = data.split(':');
    await ack();
    try {
      const wl = (await ctx.pool.query(`SELECT * FROM waitlist WHERE id=$1 AND status='offered'`, [+wid])).rows[0];
      if (!wl) { await respond(ctx.tg, target, 'Ця пропозиція вже неактуальна.'); return true; }
      if (act === 'decline') {
        await ctx.pool.query(`UPDATE waitlist SET status='waiting', offered_slot=NULL, offered_at=NULL, updated_at=NOW() WHERE id=$1`, [wl.id]);
        await respond(ctx.tg, target, 'Гаразд, лишаємо вас у черзі — запропонуємо інший вільний час.');
        return true;
      }
      // confirm → створюємо запис на запропонований слот, конкретний майстер, source='waitlist'
      const ins = await ctx.pool.query(
        `INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, status, source, notes)
         VALUES ($1,$2,$3,$4, COALESCE($5, $4::timestamptz + interval '1 hour'),'booked','waitlist',$6)
         RETURNING id`,
        [wl.client_id, Number(wl.offered_master_id) || null, wl.service_id, wl.offered_slot, wl.offered_ends,
         `З листа очікування #${wl.id}`]).catch(e => { console.error('[wl:confirm:appt]', e.message); return null; });
      if (!ins || !ins.rows[0]) { await respond(ctx.tg, target, 'На жаль, цей час щойно зайняли. Лишаємо вас у черзі.');
        await ctx.pool.query(`UPDATE waitlist SET status='waiting', updated_at=NOW() WHERE id=$1`, [wl.id]).catch(()=>{}); return true; }
      await ctx.pool.query(`UPDATE waitlist SET status='confirmed', confirmed_at=NOW(), appointment_id=$2, updated_at=NOW() WHERE id=$1`, [wl.id, ins.rows[0].id]);
      await respond(ctx.tg, target, `✅ Записано! ${wl.service_name || 'Послуга'} у ${wl.offered_master_name || 'майстра'}, ${new Date(wl.offered_slot).toLocaleString('uk-UA',{timeZone:'Europe/Kyiv',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}. Чекаємо вас!`);
      // алерт адміну: підтверджено з черги (щоб підсвітити/підтвердити)
      try {
        const oc = (await ctx.pool.query(`SELECT owner_chat_id FROM tenant_bot_settings WHERE tenant_id=current_tenant_id() AND owner_chat_id IS NOT NULL LIMIT 1`)).rows[0];
        if (oc) await ctx.tg('sendMessage', { chat_id: oc.owner_chat_id, text: `✅ Клієнт ${wl.client_name || wl.client_phone} записався З ЧЕРГИ на ${new Date(wl.offered_slot).toLocaleString('uk-UA',{timeZone:'Europe/Kyiv',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})} (${wl.offered_master_name || ''}). Підтвердіть у журналі.` });
      } catch (_) {}
    } catch (e) { console.error('[wl:callback]', e.message); await respond(ctx.tg, target, 'Помилка, спробуйте ще раз.'); }
    return true;
  }

  if (!data.startsWith('bk:')) return false;

  try {
    // категорія з фолбеку "не впізнав"
    if (data.startsWith('bk:cat:')) {
      const catName = data.slice(7);
      const cat = await loadCatalog(ctx.pool);
      const list = cat.services.filter(s => s.category && s.category.startsWith(catName)).slice(0, 8);
      if (!list.length) { await ack(); return true; }
      const session = { data: { parts: [{ query: catName, candidates: list }], date: null, master: null } };
      await ack();
      await advance(ctx, uid, target, session);
      return true;
    }

    // Особистий кабінет — усі розділи працюють БЕЗ booking-сесії
    if (data.startsWith('bk:cab:')) {
      const sec = data.slice(7);
      await ack();
      if (sec === 'home') await showCabinet(ctx, uid, chatId);
      else if (sec === 'visits') await showMyVisits(ctx, uid, chatId);
      else if (sec === 'bonus') await showBonuses(ctx, uid, chatId);
      else if (sec === 'certs') await showCerts(ctx, uid, chatId);
      else if (sec === 'profile') await showProfile(ctx, uid, chatId);
      else if (sec === 'book') await showCategories(ctx, { chat_id: chatId });
      else if (sec === 'setbday') {
        await saveSession(ctx.pool, uid, chatId, 'bday', {});
        await respond(ctx.tg, target, '🎂 Напишіть вашу дату народження у форматі <b>ДД.ММ.РРРР</b> (напр. 25.12.1990) — і ми привітаємо вас та подаруємо бонус до дня народження 💛');
      }
      return true;
    }

    // «Так, підібрати час» з поради-допродажу → нова сесія на цю послугу, БЕЗ старої сесії
    if (data.startsWith('bk:add:')) {
      const sId = Number(data.slice(7));
      const cat = await loadCatalog(ctx.pool);
      const svc = cat.byId.get(sId);
      await ack();
      if (!svc) { await respond(ctx.tg, target, 'Напишіть послугу — підберу час.'); return true; }
      const session = { data: { parts: [{ query: svc.name, candidates: [svc], pick: svc }], master: null } };
      try { session.data.masters = await eligibleMasters(ctx.pool, [svc.id]); } catch (_) {}
      await showQuick(ctx, uid, target, session);
      return true;
    }
    // «Дякую, ні» — мʼяко закриваємо пораду, без нав'язування
    if (data === 'bk:dismiss') {
      await ack();
      await respond(ctx.tg, target, 'Добре! Якщо захочете — просто напишіть послугу або зайдіть у «👤 Мій кабінет» 💛');
      return true;
    }

    // повтор минулого візиту — працює БЕЗ сесії (кнопка з привітання /start)
    if (data === 'bk:again') {
      await ack();
      const lv = await lastVisit(ctx.pool, uid).catch(() => null);
      const cat = await loadCatalog(ctx.pool);
      const svc = lv && cat.byId.get(lv.service_id);
      if (!svc) { await respond(ctx.tg, target, 'Напишіть послугу — підберу вільний час.'); return true; }
      const session = { data: { parts: [{ query: svc.name, candidates: [svc], pick: svc }], master: null } };
      try {
        session.data.masters = await eligibleMasters(ctx.pool, [svc.id]);
        // той самий майстер, якщо він досі надає цю послугу онлайн
        if (lv.master_id && session.data.masters.some(m => Number(m.id) === Number(lv.master_id))) {
          session.data.master = Number(lv.master_id);
        }
      } catch (e) { console.error('[bookbot/again]', e.message); }
      await showQuick(ctx, uid, target, session);
      return true;
    }

    // Оцінка візиту клієнтом (264, Босс 13.07): bk:rate:<id.id>:<n> — зірки майстру,
    // bk:rates:<id.id>:<n> — зірки салону (другий крок). Без сесії. 1-3⭐ → алерт власнику.
    if (data.startsWith('bk:rate:') || data.startsWith('bk:rates:')) {
      const salonStep = data.startsWith('bk:rates:');
      const p = data.split(':'); // [bk, rate|rates, idsKey, n]
      const rIds = String(p[2] || '').split('.').map(Number).filter(Boolean);
      const stars = Math.min(5, Math.max(1, Number(p[3]) || 0));
      await ack();
      if (!rIds.length || !stars) return true;
      // 04.11: спільна логіка з мініапом (lib/visit-loyalty.rateVisit): лише власний
      // ОПЛАЧЕНИЙ візит, одна оцінка на візит, змінити можна 24 год, 1–3⭐ → тихе
      // сповіщення власнику (одне на натискання, не на кожен візит групи).
      const VL = require('./visit-loyalty');
      const notify = VL.ownerNotifier(ctx.tg, ctx.pool);
      const own = { rows: [] };
      let lastErr = null;
      for (const rid of rIds) {
        const r = await VL.rateVisit({ apptId: rid, telegramId: uid, stars, field: salonStep ? 'salon' : 'master',
          ownerNotify: own.rows.length ? null : notify }, ctx.pool);
        if (r.ok) own.rows.push({ id: rid }); else lastErr = r;
      }
      if (!own.rows.length) {
        await respond(ctx.tg, target, (lastErr && lastErr.message) || 'Цей візит вже неактуальний.');
        return true;
      }
      if (!salonStep) {
        const idsKey = own.rows.map(r => r.id).join('.');
        await respond(ctx.tg, target,
          `Дякуємо! Оцінку майстру ${'⭐'.repeat(stars)} записали.\nА як вам салон загалом?`,
          [[1, 2, 3, 4, 5].map(n => ({ text: `${n}⭐`, callback_data: `bk:rates:${idsKey}:${n}` }))]);
      } else {
        await respond(ctx.tg, target, `Дякуємо за відгук! 💛 Ваша думка допомагає нам ставати кращими.`);
      }
      return true;
    }

    // кнопки з нагадувань (bk:r:ok|mv|cn:<id.id>) — працюють без сесії
    if (data.startsWith('bk:r:')) {
      const [, , act, idsKey] = data.split(':');
      const ids = String(idsKey || '').split('.').map(Number).filter(Boolean);
      await ack();
      if (!ids.length) return true;
      // безпека: керувати можна ТІЛЬКИ власними записами
      const own = await ctx.pool.query(
        `SELECT a.id, a.master_id, a.service_id FROM appointments a
          JOIN clients c ON c.id = a.client_id
         WHERE a.id = ANY($1::int[]) AND c.telegram_id = $2
           AND a.status IN ('booked','confirmed')`, [ids, uid]);
      if (!own.rows.length) { await respond(ctx.tg, target, 'Цей запис вже неактуальний.'); return true; }

      if (act === 'ok') {
        await respond(ctx.tg, target, '✅ Дякуємо за підтвердження! Чекаємо вас 💛');
        return true;
      }
      if (act === 'cn') {
        const cnIds = own.rows.map(r => r.id);
        await ctx.pool.query(
          `UPDATE appointments SET status='cancelled', cancelled_at=COALESCE(cancelled_at,NOW()), updated_at=NOW()
            WHERE id = ANY($1::int[]) AND status IN ('booked','confirmed')`,
          [cnIds]);
        // дзеркалимо у online_bookings → адмінка почує «розбитий кришталь» + спливне вікно (заметка #117)
        try {
          await ctx.pool.query(
            `UPDATE online_bookings SET status='cancelled', updated_at=NOW()
              WHERE legacy_appointment_ref = ANY($1::text[]) AND COALESCE(status,'') <> 'cancelled'`,
            [cnIds.map(String)]);
        } catch (e) { console.error('[bookbot/ob-cancel]', e.message); }
        notifyStaffCancel(ctx, cnIds, 'з нагадування в Telegram').catch(() => {});
        await respond(ctx.tg, target, ctx.miniappUrl
          ? '✖ Запис скасовано. Будемо раді бачити вас іншим разом 💛'
          : '✖ Запис скасовано. Будемо раді бачити вас іншим разом 💛\nЩоб записатись знову — просто напишіть послугу.',
          ctx.miniappUrl ? [[{ text: '✨ Записатися знову', web_app: { url: miniappLink(ctx) } }]] : undefined);
        return true;
      }
      if (act === 'mv' && ctx.miniappUrl) {
        const moveIds = own.rows.map(r => r.id).join('.');
        await respond(ctx.tg, target, '🔁 Оберіть новий час у застосунку — старий запис скасується автоматично, щойно підтвердите новий.',
          [[{ text: '🔁 Обрати новий час', web_app: { url: miniappLink(ctx, { move: moveIds }) } }]]);
        return true;
      }
      if (act === 'mv') {
        const cat = await loadCatalog(ctx.pool);
        const parts = own.rows.map(r => cat.byId.get(r.service_id)).filter(Boolean)
          .map(s => ({ query: s.name, candidates: [s], pick: s }));
        if (!parts.length) { await respond(ctx.tg, target, 'Напишіть послугу — підберу новий час.'); return true; }
        const session = { data: { parts, master: null, moveIds: own.rows.map(r => r.id) } };
        try {
          session.data.masters = await eligibleMasters(ctx.pool, parts.map(p => p.pick.id));
          const mid = own.rows[0].master_id;
          if (mid && session.data.masters.some(m => Number(m.id) === Number(mid))) session.data.master = Number(mid);
        } catch (e) { console.error('[bookbot/mv]', e.message); }
        await showQuick(ctx, uid, target, session);
        return true;
      }
      return true;
    }

    if (data === 'bk:cancel') {
      await clearSession(ctx.pool, uid);
      await ack();
      await respond(ctx.tg, target, '✖ Запис скасовано. Напишіть послугу, щоб почати знову.');
      return true;
    }
    if (data === 'bk:retry') {
      await clearSession(ctx.pool, uid);
      await ack();
      await respond(ctx.tg, target, 'Напишіть послугу, на яку хочете записатись.');
      return true;
    }

    const session = await loadSession(ctx.pool, uid);
    if (!session) {
      await ack();
      await respond(ctx.tg, target, '⌛ Сесія застаріла. Напишіть послугу ще раз.');
      return true;
    }
    // нормалізуємо форму data
    session.data = session.data || {};

    if (data.startsWith('bk:pick:')) {
      const [, , pIdx, sId] = data.split(':');
      const part = session.data.parts[Number(pIdx)];
      if (part) part.pick = part.candidates.find(c => String(c.id) === sId) || part.candidates[0];
      await ack();
      await advance(ctx, uid, target, session);
      return true;
    }
    // «Записатись: <послуга>» з комбо різних спеціалізацій → лишаємо одну послугу
    if (data.startsWith('bk:only:')) {
      const sId = Number(data.slice(8));
      const cat = await loadCatalog(ctx.pool);
      const svc = cat.byId.get(sId);
      await ack();
      if (!svc) return showQuick(ctx, uid, target, session);
      session.data.parts = [{ query: svc.name, candidates: [svc], pick: svc }];
      session.data.masters = null; session.data.master = null; session.data.quick = null;
      await showQuick(ctx, uid, target, session);
      return true;
    }
    // швидкий слот з екрана «найближчі вікна» → одразу підтвердження
    if (data.startsWith('bk:q:')) {
      const slot = (session.data.quick || [])[Number(data.slice(5))];
      await ack();
      if (!slot) return showQuick(ctx, uid, target, session);
      session.data.sel = slot;
      await showConfirm(ctx, uid, target, session);
      return true;
    }
    if (data === 'bk:day') { await ack(); await showDates(ctx, uid, target, session); return true; }
    if (data === 'bk:pickmst') { await ack(); await showMasters(ctx, uid, target, session); return true; }
    if (data.startsWith('bk:date:')) {
      session.data.date = data.slice(8);
      await ack();
      await showSlots(ctx, uid, target, session);
      return true;
    }
    if (data.startsWith('bk:mst:')) {
      session.data.master = data.slice(7); // внутрішній id | 'any'
      await ack();
      await showQuick(ctx, uid, target, session);
      return true;
    }
    if (data.startsWith('bk:slot:')) {
      const slot = (session.data.slots || [])[Number(data.slice(8))];
      await ack();
      if (!slot) return showSlots(ctx, uid, target, session);
      session.data.sel = slot;
      await showConfirm(ctx, uid, target, session);
      return true;
    }
    if (data.startsWith('bk:back:')) {
      const to = data.slice(8);
      await ack();
      if (to === 'quick') return showQuick(ctx, uid, target, session);
      if (to === 'date') return showDates(ctx, uid, target, session);
      if (to === 'master') return showMasters(ctx, uid, target, session);
      if (to === 'slot') return showSlots(ctx, uid, target, session);
      return true;
    }
    if (data === 'bk:confirm') {
      await ack();
      const cl = await getClient(ctx.pool, uid);
      if (cl && cl.digits) {
        await respond(ctx.tg, target, '⏳ Створюю запис…');
        await doBook(ctx, uid, chatId, session, cl.digits, cl.name);
      } else {
        // немає номера → просимо поділитись, бронюємо після контакту
        await saveSession(ctx.pool, uid, chatId, 'await_contact', session.data);
        await ctx.tg('sendMessage', {
          chat_id: chatId,
          text: 'Залишився останній крок — поділіться номером для звʼязку, і я підтверджу запис:',
          reply_markup: {
            keyboard: [[{ text: '📱 Поділитись номером', request_contact: true }]],
            one_time_keyboard: true, resize_keyboard: true,
          },
        });
      }
      return true;
    }

    await ack();
    return true;
  } catch (e) {
    console.error('[bookbot/callback]', e.message);
    await ack();
    return true;
  }
}

// Контакт: якщо чекали номер для завершення запису — бронюємо. Інакше false.
async function onContact(msg, ctx) {
  const uid = msg.from.id, chatId = msg.chat.id;
  const session = await loadSession(ctx.pool, uid);
  if (!session || session.state !== 'await_contact') return false;
  if (msg.contact.user_id !== msg.from.id) {
    await ctx.tg('sendMessage', { chat_id: chatId, text: '❌ Поділіться, будь ласка, власним номером.' });
    return true;
  }
  const digits = msg.contact.phone_number.replace(/\D/g, '');
  const name = msg.contact.first_name || msg.from.first_name || 'Клієнт';
  // привʼязуємо номер до клієнта (як у link-флоу)
  try {
    const tgUser = msg.from.username || null;
    const tgLast = msg.contact.last_name || msg.from.last_name || null;
    await ctx.pool.query(
      `UPDATE clients SET telegram_id=$1, tg_first_name=COALESCE($3,tg_first_name),
         tg_last_name=COALESCE($4,tg_last_name), tg_username=COALESCE($5,tg_username)
       WHERE regexp_replace(phone,'\\D','','g')=$2 AND (telegram_id IS NULL OR telegram_id=$1)`,
      [uid, digits, name, tgLast, tgUser]);
  } catch (e) { console.error('[bookbot/contact-link]', e.message); }
  await ctx.tg('sendMessage', { chat_id: chatId, text: '⏳ Дякую! Створюю запис…', reply_markup: { remove_keyboard: true } });
  await doBook(ctx, uid, chatId, session, digits, name);
  return true;
}

module.exports = { onText, onCallback, onContact, onStartKnown, mainMenu, tryOwnerStart, ownerMenu, loadCatalog, invalidateCatalog, eligibleMasters, showAdminContact, miniappKb, miniappLink, notifyStaffCancel, priceLabel, totalLabel };
