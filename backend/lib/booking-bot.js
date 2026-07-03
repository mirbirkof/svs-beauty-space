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

// ── каталог послуг (кеш 5 хв) ──────────────────────────────────
let _catCache = null, _catAt = 0;
async function loadCatalog(pool) {
  if (_catCache && Date.now() - _catAt < 5 * 60 * 1000) return _catCache;
  const r = await pool.query(
    `SELECT id, beautypro_id AS bp_id, name,
            COALESCE(duration_min, 60) AS duration_min, price::float AS price, category
       FROM services
      WHERE active IS NOT FALSE AND deleted_at IS NULL AND beautypro_id IS NOT NULL`
  );
  const services = r.rows.map(s => ({
    id: s.id, bp_id: s.bp_id, name: s.name,
    duration_min: s.duration_min, price: s.price, category: s.category,
  }));
  const indexed = matcher.buildIndex(services);
  const byId = new Map(services.map(s => [s.id, s]));
  _catCache = { services, indexed, byId };
  _catAt = Date.now();
  return _catCache;
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
// BeautyPro тут більше не потрібен: графік і зайнятість живуть у нашій БД.
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
      text: `${c.name} · ${fmtPrice(c.price)}`, callback_data: `bk:pick:${next}:${c.id}`,
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
  if (!masterIds.length) return restart(ctx, uid, target, 'Немає майстрів, що надають цю послугу онлайн.');

  let quick = [];
  try { quick = await slotEngine.nearestSlots(ctx.pool, { masterIds, durationMin: dur || 60, days: MAX_DAYS, limit: QUICK_LIMIT }); }
  catch (e) { console.error('[bookbot/quick]', e.message); }
  session.data.quick = quick;

  const lines = chosen.map(s => `• ${s.name} — ${fmtPrice(s.price)}`).join('\n');
  const head = chosen.length > 1
    ? `🧩 <b>Комплекс</b>:\n${lines}\n\nРазом: <b>${fmtPrice(total)}</b>, ~${fmtDur(dur)}`
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
  const body = quick.length
    ? `${head}${mName ? `\n💇 Майстер: <b>${mName}</b>` : ''}\n\n⚡ <b>Найближчі вільні вікна</b> — оберіть час:`
    : `${head}${mName ? `\n💇 Майстер: <b>${mName}</b>` : ''}\n\n😔 Найближчим часом вільних вікон немає. Спробуйте «Інший день» або іншого майстра.`;
  return respond(ctx.tg, target, body, kb);
}

async function showDates(ctx, uid, target, session) {
  const { chosen, total, dur } = summarize(session);
  if (!chosen.length) return restart(ctx, uid, target, 'Не вдалось визначити послугу.');
  const lines = chosen.map(s => `• ${s.name} — ${fmtPrice(s.price)}`).join('\n');
  const head = chosen.length > 1
    ? `🧩 <b>Комплекс</b>:\n${lines}\n\nРазом: <b>${fmtPrice(total)}</b>, ~${fmtDur(dur)}`
    : `${lines}\n~${fmtDur(dur)}`;

  const base = new Date(); base.setHours(0, 0, 0, 0);
  const btns = [];
  for (let i = 0; i < MAX_DAYS; i++) {
    const d = new Date(base); d.setDate(base.getDate() + i);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const label = i === 0 ? 'Сьогодні' : i === 1 ? 'Завтра' : `${d.getDate()} ${MM[d.getMonth()]} (${DOW[d.getDay()]})`;
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

  let slots = [];
  try { slots = await slotEngine.freeSlotsForDate(ctx.pool, { date, masterIds, durationMin: dur || 60 }); }
  catch (e) { console.error('[bookbot/slots]', e.message); }
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
  const svcLines = chosen.map(s => `• ${s.name} — ${fmtPrice(s.price)}`).join('\n');
  const text =
    `<b>Перевірте запис:</b>\n\n${svcLines}\n\n` +
    `💇 Майстер: <b>${masterName}</b>\n` +
    `📅 ${fmtDateKey(slot.date)}, <b>${slot.label}</b>\n` +
    `💰 Разом: <b>${fmtPrice(total)}</b> · ~${fmtDur(dur)}`;
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

  // записи в журнал салону: послідовні послуги одного майстра
  const apptIds = [];
  try {
    let cur = slot.startMin;
    for (const s of chosen) {
      const d = Number(s.duration_min) || 60;
      const r = await ctx.pool.query(
        `INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, price, status, source, client_name)
         VALUES ($1,$2,$3, ${slotEngine.TS_EXPR(4, 5)}, ${slotEngine.TS_EXPR(4, 6)}, $7, 'confirmed', 'bot-chat', $8)
         RETURNING id`,
        [clientId, masterId, s.id, date, cur, cur + d, Number(s.price) || null, name]);
      apptIds.push(r.rows[0].id);
      cur += d;
    }
  } catch (e) {
    console.error('[bookbot/appt]', e.message);
    await clearSession(ctx.pool, uid);
    return ctx.tg('sendMessage', { chat_id: chatId, text: '⚠️ Не вдалось створити запис. Адміністратор звʼяжеться з вами.' });
  }

  // журнал online_bookings (історія онлайн-каналу)
  let bookingId = null;
  try {
    const ob = await ctx.pool.query(
      `INSERT INTO online_bookings
         (client_id, client_phone, client_name, service_id, service_name, master_id, master_name,
          date_from, date_to, channel, bp_appointment_id, status, telegram_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7, ${slotEngine.TS_EXPR(8, 9)}, ${slotEngine.TS_EXPR(8, 10)},
               'bot-chat',$11,'confirmed',$12) RETURNING id`,
      [clientId, phone, name, String(chosen[0].id), chosen.map(s => s.name).join(' + '),
       String(masterId), masterNameOf(session, masterId),
       date, slot.startMin, slot.startMin + chosen.reduce((a, s) => a + (Number(s.duration_min) || 60), 0),
       String(apptIds[0] || ''), uid]);
    bookingId = ob.rows[0].id;
  } catch (e) { console.error('[bookbot/log]', e.message); }

  await clearSession(ctx.pool, uid);
  const masterName = masterNameOf(session, masterId);
  await ctx.tg('sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: `✅ <b>Запис підтверджено!</b>\n\n📅 ${fmtDateKey(date)}, <b>${slot.label}</b>\n💇 ${masterName}\n💰 ${fmtPrice(total)}\n\nЧекаємо вас у SVS Beauty Space 💛`,
    reply_markup: { remove_keyboard: true },
  });

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
  try { sp = (await ctx.pool.query(`SELECT value FROM app_settings WHERE key='salon_profile'`)).rows[0]?.value || {}; } catch (_) {}
  const out = [];
  if (sp.name) out.push(`<b>${sp.name}</b>`);
  if (isHours && sp.hours) out.push(`🕐 Графік роботи: <b>${sp.hours}</b>`);
  if (isAddr) {
    if (sp.address) out.push(`📍 Адреса: <b>${sp.address}</b>`);
    if (sp.landmarks) out.push(`🧭 ${sp.landmarks}`);
  }
  if (isPhone && sp.phones) out.push(`📞 Телефон: <b>${sp.phones}</b>`);
  if (out.length <= 1) return null; // профіль порожній по запитаному — не вдаємо, що відповіли
  out.push(`\nНапишіть назву послуги — підберу вільний час і запишу. 💛`);
  return out.join('\n');
}

async function onText(msg, ctx) {
  const uid = msg.from.id, chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) return false; // команди — не сюди

  // FAQ перед розпізнаванням послуги: графік/адреса/телефон
  const faq = await tryFaq(text, ctx);
  if (faq) { await ctx.tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: faq }); return true; }

  const cat = await loadCatalog(ctx.pool);
  const result = matcher.match(text, cat.indexed);
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
  if (!data.startsWith('bk:')) return false;
  const ack = () => ctx.tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});

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

module.exports = { onText, onCallback, onContact };
