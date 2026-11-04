/* ═══════════════════════════════════════════════════════════════
   Telegram Mini App онлайн-запису SVS Beauty Space (Босс 03.11).
   Сторінка: /p/app.html (public/app.html). API: /api/miniapp/*.

   БЕЗПЕКА: кожен запит несе заголовок X-Telegram-Init-Data — підписаний
   Telegram рядок initData. Перевіряємо HMAC токеном бота (lib/tg-initdata),
   свіжість ≤ 24 год. Клієнта визначаємо ЛИШЕ за перевіреним user.id
   (clients.telegram_id) — жодних client_id з тіла запиту.
   Бронь — спільне ядро lib/booking-core (той самий лок/схема, що в бота).
   ═══════════════════════════════════════════════════════════════ */
const { groupCatalog } = require('../lib/miniapp-catalog');
const express = require('express');
const hairVariants = require('../lib/hair-variants');
const { getPool } = require('../db-pg');
const slotEngine = require('../lib/slot-engine');
const initData = require('../lib/tg-initdata');
const core = require('../lib/booking-core');
const { DEFAULT_TENANT_ID, runAs } = require('../lib/tenant');
const { normalizePhoneDb, fmtPhoneFull } = require('../lib/phone');
const masterLink = require('../lib/master-link');
const combo = require('../lib/combo-plan');

const router = express.Router();
const MAX_AGE_SEC = 24 * 3600;
const DAYS_MAX = 14;
const NAME_MAX = 100;

const esc = (v) => String(v == null ? '' : v).replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
const pad = (n) => String(n).padStart(2, '0');
const DOW_UA = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'];
const MON_UA = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
function fmtDateUa(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${d} ${MON_UA[m - 1]}, ${DOW_UA[dt.getUTCDay()]}`;
}
const minLabel = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
function fmtDur(min) { const h = Math.floor(min / 60), m = min % 60; return h ? (m ? `${h} год ${m} хв` : `${h} год`) : `${m} хв`; }
function fmtPrice(p) { const n = Math.round(Number(p) || 0); return n > 0 ? `${n} грн` : 'за прайсом'; }
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
// фото майстра: лише через НАШ сервер (/api/files/<uuid>); зовнішні адреси не віддаємо
function safeAvatar(a) {
  const m = String(a || '').match(/\/api\/files\/([0-9a-f-]{36})(?:$|[/?#])/i);
  return m ? `/api/files/${m[1]}` : null;
}
function botTg() { return require('./booking').tg; }
const bot = () => require('../lib/booking-bot');

// ── auth: перевірка initData ─────────────────────────────────────
function auth(req, res, next) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(503).json({ error: 'bot_not_configured' });
  const tid = req.tenant_id || DEFAULT_TENANT_ID;
  if (String(tid) !== DEFAULT_TENANT_ID) return res.status(403).json({ error: 'tenant_not_supported' });
  const v = initData.verify(req.get('x-telegram-init-data') || '', token, MAX_AGE_SEC);
  if (!v.ok || !v.user || !Number.isSafeInteger(Number(v.user.id))) {
    return res.status(401).json({ error: 'unauthorized', reason: v.ok ? 'no_user' : v.reason });
  }
  req.tgUser = { id: Number(v.user.id), first_name: v.user.first_name || '', last_name: v.user.last_name || '', username: v.user.username || null };
  next();
}
router.use(auth);

async function clientOf(uid) {
  const r = await getPool().query(
    `SELECT id, COALESCE(NULLIF(name,''), tg_first_name) AS name, phone,
            COALESCE(loyalty_points,0)::float AS points, COALESCE(total_visits,0)::int AS visits
       FROM clients WHERE telegram_id = $1 AND deleted_at IS NULL LIMIT 1`, [uid]);
  const c = r.rows[0] || null;
  if (c && !String(c.phone || '').replace(/\D/g, '')) c.phone = null;
  return c;
}

// ── профіль ───────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const c = await clientOf(req.tgUser.id);
    res.json({
      user: { first_name: req.tgUser.first_name },
      client: c ? { name: c.name || req.tgUser.first_name, has_phone: !!c.phone, phone: c.phone ? fmtPhoneFull(c.phone) : null,
        points: c.points, visits: c.visits } : null,
      salon: { name: 'SVS Beauty Space' },
      master: await masterState(req.tgUser.id),
    });
  } catch (e) { console.error('[miniapp/me]', e.message); res.status(500).json({ error: 'server' }); }
});

// ── номер телефону: підписаний requestContact або ручне введення ──
const manualPhoneRate = new Map(); // uid → [timestamps] ручних введень номера
function manualPhoneOk(uid) {
  const now = Date.now();
  const arr = (manualPhoneRate.get(uid) || []).filter(t => now - t < 600000);
  arr.push(now); manualPhoneRate.set(uid, arr);
  if (manualPhoneRate.size > 5000) manualPhoneRate.clear();
  return arr.length <= 5;
}
router.post('/contact', async (req, res) => {
  const uid = req.tgUser.id;
  const pool = getPool();
  try {
    let digits = null, verified = false, cname = null;
    if (typeof req.body?.contact === 'string' && req.body.contact) {
      // відповідь WebApp.requestContact — той самий формат підпису, що й initData
      const v = initData.verify(req.body.contact, process.env.TELEGRAM_BOT_TOKEN, MAX_AGE_SEC);
      if (!v.ok) return res.status(401).json({ error: 'bad_contact_sign' });
      let ct = null; try { ct = JSON.parse(v.data.contact || 'null'); } catch (_) {}
      if (!ct || Number(ct.user_id) !== uid || !ct.phone_number) return res.status(400).json({ error: 'not_own_contact' });
      digits = String(ct.phone_number).replace(/\D/g, '');
      cname = [ct.first_name, ct.last_name].filter(Boolean).join(' ') || null;
      verified = true;
    } else if (typeof req.body?.phone === 'string') {
      // 04.11 фінальний аудит: ручне введення — до 5 спроб / 10 хв на TG (захист від перебору номерів бази)
      if (!manualPhoneOk(uid)) return res.status(429).json({ error: 'too_many', message: 'Забагато спроб. Скористайтеся кнопкою «Поділитися номером з Telegram» або спробуйте пізніше.' });
      digits = req.body.phone.replace(/\D/g, '');
      if (digits.length === 10 && digits.startsWith('0')) digits = '38' + digits;
      if (!/^380\d{9}$/.test(digits)) return res.status(400).json({ error: 'bad_phone', message: 'Введіть номер у форматі +380XXXXXXXXX' });
    } else return res.status(400).json({ error: 'no_phone' });
    const name = String(req.body?.name || cname || req.tgUser.first_name || 'Клієнт').trim() || 'Клієнт';
    if (name.length > NAME_MAX) return res.status(400).json({ error: 'bad_name', message: 'Імʼя задовге' });

    // Режим майстра (Босс 04.11): ЛИШЕ підтверджений Telegram-номер; ручне введення прав не дає.
    // Підтверджений номер запамʼятовуємо на картці (tg_verified_phone) — якщо номер майстра внесуть у CRM
    // пізніше, /me сам повторить розпізнавання без повторного запиту номера.
    const reply = async (o, status) => {
      let master = null;
      try {
        if (verified) {
          await pool.query(`UPDATE clients SET tg_verified_phone=$2, phone_verified_at=NOW() WHERE telegram_id=$1 AND deleted_at IS NULL`,
            [uid, masterLink.canonPhone(digits)]);
        }
        master = await masterState(uid, verified ? digits : null);
      } catch (e) { console.error('[miniapp/contact master]', e.message); }
      return res.status(status || 200).json(Object.assign(o, { master }));
    };
    const mine = await clientOf(uid);
    if (mine && mine.phone) return reply({ ok: true, already: true });

    const canon = normalizePhoneDb(digits);
    const ex = (await pool.query(
      `SELECT id, telegram_id FROM clients WHERE regexp_replace(phone,'\\D','','g') IN ($1,$2) AND deleted_at IS NULL LIMIT 1`,
      [digits, String(canon || digits).replace(/\D/g, '')])).rows[0];
    if (ex) {
      if (ex.telegram_id && Number(ex.telegram_id) !== uid) {
        // режим майстра не залежить від клієнтської картки: reply сам звірить підтверджений номер
        return reply({ error: 'phone_linked_other', message: 'Цей номер уже привʼязано до іншого Telegram. Звʼяжіться з адміністратором.' }, 409);
      }
      // Існуюча картка салону: привʼязуємо ЛИШЕ підтвердженим Telegram-номером (захист від захоплення чужої картки)
      if (!verified) {
        return res.status(409).json({ error: 'need_verified', message: 'Цей номер уже є в базі салону. Підтвердіть його кнопкою «Поділитися номером з Telegram».' });
      }
      if (mine && !mine.phone) await pool.query(`UPDATE clients SET telegram_id=NULL WHERE id=$1 AND (phone IS NULL OR phone='')`, [mine.id]);
      await pool.query(
        `UPDATE clients SET telegram_id=$1, tg_first_name=COALESCE(tg_first_name,$3), tg_username=COALESCE(tg_username,$4),
                name=COALESCE(NULLIF(name,''),$5), updated_at=NOW() WHERE id=$2`,
        [uid, ex.id, req.tgUser.first_name || null, req.tgUser.username, name]);
      return reply({ ok: true, linked: true });
    }
    if (mine) {
      await pool.query(`UPDATE clients SET phone=$1, name=COALESCE(NULLIF(name,''),$2), updated_at=NOW() WHERE id=$3`, [canon, name, mine.id]);
    } else {
      await pool.query(
        `INSERT INTO clients (phone, name, telegram_id, tg_first_name, tg_username, source) VALUES ($1,$2,$3,$4,$5,'miniapp')`,
        [canon, name, uid, req.tgUser.first_name || null, req.tgUser.username]);
    }
    return reply({ ok: true, created: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'phone_linked_other', message: 'Цей номер уже використовується. Звʼяжіться з адміністратором.' });
    console.error('[miniapp/contact]', e.message); res.status(500).json({ error: 'server' });
  }
});

// ── режим майстра (Босс 04.11: визначається автоматично, без кнопки «Я майстер») ──
// is_master — Telegram привʼязаний до обліковки «Майстер» працюючого майстра. Якщо ні, але людина колись
// підтвердила номер через Telegram, — повторно звіряємо цей номер з CRM (номер майстра могли додати пізніше,
// майстра могли повернути на роботу). Звільнений → masterUserByTg порожній → клієнтський режим.
async function masterState(uid, verifiedPhone) {
  const pool = getPool();
  let u = await masterLink.masterUserByTg(pool, DEFAULT_TENANT_ID, uid);
  if (u) return { is_master: true, name: u.master_name || u.display_name };
  let phone = verifiedPhone || null;
  if (!phone) {
    const c = await pool.query(
      `SELECT tg_verified_phone FROM clients WHERE telegram_id=$1 AND deleted_at IS NULL AND tg_verified_phone IS NOT NULL
        ORDER BY phone_verified_at DESC NULLS LAST LIMIT 1`, [uid]).catch(() => ({ rows: [] }));
    phone = c.rows[0] ? c.rows[0].tg_verified_phone : null;
  }
  if (!phone) return { is_master: false };
  const r = await masterLink.recognize(pool, DEFAULT_TENANT_ID, uid, phone);
  if (!r.master) return { is_master: false };
  u = await masterLink.masterUserByTg(pool, DEFAULT_TENANT_ID, uid);
  return u ? { is_master: true, name: u.master_name || u.display_name, just_linked: true } : { is_master: false };
}

// Сесія майстра: звичайний Bearer-токен CRM з правами ролі «Майстер» (12 год), лише за перевіреним initData.
const sessRate = new Map();
router.post('/master/session', async (req, res) => {
  const uid = req.tgUser.id;
  const now = Date.now();
  const hits = (sessRate.get(uid) || []).filter((t) => now - t < 3600e3);
  if (hits.length >= 20) return res.status(429).json({ error: 'rate' });
  hits.push(now); sessRate.set(uid, hits);
  try {
    const s = await masterLink.issueMasterSession(getPool(), DEFAULT_TENANT_ID, uid, req);
    if (!s) return res.status(403).json({ error: 'not_master', message: 'Цей Telegram не привʼязаний до майстра салону.' });
    res.json({ ok: true, token: s.token, expires_at: s.expiresAt, master: { id: s.master_id, name: s.name } });
  } catch (e) { console.error('[miniapp/master/session]', e.message); res.status(500).json({ error: 'server' }); }
});

// ── каталог: категорії → послуги (лише з онлайн-майстром) ─────────
// Вітрина каталогу: синоніми категорій злиті («Перукарські послуги» → «Волосся»), великі категорії — з підгрупами.
// Назви/категорії в БД не змінюються (lib/miniapp-catalog.js).
router.get('/catalog', async (req, res) => {
  try {
    const cat = await bot().loadCatalog(getPool());
    // price-materials-0411: волосся — одна картка «від X ₴ · робота + матеріал» замість робіт/матеріалів окремо
    let procs = [];
    try { procs = await hairVariants.loadProcedures(getPool()); } catch (e) { console.error('[miniapp/catalog] procs', e.message); }
    res.json({ categories: groupCatalog(hairVariants.applyProcedures(cat.services, procs)) });
  } catch (e) { console.error('[miniapp/catalog]', e.message); res.status(500).json({ error: 'server' }); }
});

async function mastersFor(serviceId) {
  const pool = getPool();
  const sids = Array.isArray(serviceId) ? serviceId : (serviceId ? [serviceId] : null);
  const base = sids
    ? await bot().eligibleMasters(pool, sids)
    // Босс 04.11: у «Наших майстрах» лише ті, хто реально обслуговує клієнтів — без власника й адмінів
    : (await pool.query(`SELECT id FROM masters WHERE active IS NOT FALSE AND online_booking_enabled IS NOT FALSE
                            AND provides_services IS NOT FALSE AND COALESCE(staff_role,'master') = 'master'
                          ORDER BY online_rank NULLS LAST, name`)).rows.map(r => ({ id: Number(r.id) }));
  if (!base.length) return [];
  const ids = base.map(m => m.id);
  const r = await pool.query(
    `SELECT m.id, COALESCE(NULLIF(m.online_title,''), m.name) AS name,
            NULLIF(m.specialty,'') AS specialty, m.avatar,
            (SELECT count(*) FROM visit_ratings v WHERE v.master_id = m.id AND v.master_stars IS NOT NULL)::int AS n_rates,
            (SELECT AVG(v.master_stars)::float FROM visit_ratings v WHERE v.master_id = m.id AND v.master_stars IS NOT NULL) AS rating
       FROM masters m WHERE m.id = ANY($1::int[])`, [ids]);
  const by = new Map(r.rows.map(x => [Number(x.id), x]));
  return ids.map(id => by.get(id)).filter(Boolean).map(x => ({
    id: Number(x.id), name: x.name, specialty: x.specialty || null,
    avatar: safeAvatar(x.avatar),
    // рейтинг — ЛИШЕ коли є реальні оцінки клієнтів
    rating: x.n_rates > 0 && x.rating ? Math.round(x.rating * 10) / 10 : null, reviews: x.n_rates,
  }));
}
// combo-0411: послуги з query — services=1,2,3 (комплекс) або service=1 (як раніше)
function parseServiceIds(src) {
  const raw = src.services != null && src.services !== '' ? src.services
    : (src.service_ids != null ? src.service_ids : (src.service != null ? src.service : src.service_id));
  if (raw == null || raw === '') return null;
  const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map(x => Number(String(x).trim()));
  if (!list.length || list.length > combo.MAX_ITEMS || list.some(n => !Number.isInteger(n) || n <= 0)) return null;
  if (new Set(list).size !== list.length) return null;
  return list;
}
// майстри, у яких Є графік у межах горизонту запису (без графіка — клієнту нема куди записатись)
async function scheduledSet(ids) {
  if (!ids.length) return new Set();
  // вікно — до 31 дня (не весь горизонт): «є години найближчим місяцем» = клієнт реально запишеться
  const st = await slotEngine.getSettings(getPool());
  return slotEngine.mastersWithHours(getPool(), ids, slotEngine.kyivToday(), Math.min(31, st.horizonDays));
}
router.get('/masters', async (req, res) => {
  try {
    if (!req.query.service && !req.query.services) return res.json({ masters: await mastersFor(null) }); // «Наші майстри»
    const ids = parseServiceIds(req.query);
    if (!ids) return res.status(400).json({ error: 'bad_service' });
    // combo-0411 п.1: майстер без графіка не показуємо у виборі (тупик «вільного часу немає»),
    // але рахуємо — клієнт бачить «графік ще складається», а не порожнечу
    const all = await mastersFor(ids);
    const sched = await scheduledSet(all.map(m => m.id));
    const masters = all.filter(m => sched.has(m.id));
    let split = false;
    if (ids.length > 1) { // комплекс: чи можна зібрати ланцюжком у різних майстрів
      split = true;
      for (const id of ids) {
        const e = await bot().eligibleMasters(getPool(), [id]);
        const ss = await scheduledSet(e.map(m => m.id));
        if (!e.some(m => ss.has(m.id))) { split = false; break; }
      }
    }
    res.json({ masters, split, waiting: all.length - masters.length });
  } catch (e) { console.error('[miniapp/masters]', e.message); res.status(500).json({ error: 'server' }); }
});

// спільна валідація service/master → { svc, masterIds, names }
// combo-0411: одна послуга — як було; кілька — items у порядку виконання, eligBy — майстри кожної послуги
async function resolveSel(q) {
  const ids = parseServiceIds(q);
  if (!ids) return { err: 'bad_service' };
  const cat = await bot().loadCatalog(getPool());
  const items = ids.map(id => cat.byId.get(id));
  if (items.some(x => !x)) return { err: 'service_unavailable' };
  const elig = await bot().eligibleMasters(getPool(), ids);
  const eligBy = ids.length > 1 ? await Promise.all(ids.map(id => bot().eligibleMasters(getPool(), [id]))) : [elig];
  const names = new Map();
  for (const m of [elig, ...eligBy].flat()) names.set(m.id, m.name);
  let masterIds = elig.map(m => m.id), fixed = null;
  // price-cards-0411: картка з топ-майстром (нігті) — базова послуга в одних майстрів, топ-послуга в топ-майстра.
  // Одна картка = обидві групи: слоти й бронь — кожна зі СВОЄЮ послугою/тривалістю.
  let groups = null;
  if (ids.length === 1) {
    let pairs = [];
    try { pairs = hairVariants.topPairsFor(await hairVariants.loadProcedures(getPool()), ids[0]); } catch (e) { console.error('[miniapp/top-pairs]', e.message); }
    const pr = pairs[0], topSvc = pr && cat.byId.get(pr.topId);
    if (topSvc) {
      const te = (await bot().eligibleMasters(getPool(), [pr.topId])).filter(m => pr.topMasterIds.includes(Number(m.id)));
      if (te.length) {
        for (const m of te) names.set(m.id, m.name);
        const topIds = te.map(m => m.id);
        const baseIds = masterIds.filter(id => !topIds.includes(id));
        groups = [{ svc: items[0], masterIds: baseIds }, { svc: topSvc, masterIds: topIds }].filter(g => g.masterIds.length);
        masterIds = [...baseIds, ...topIds];
      }
    }
  }
  if (q.master != null && q.master !== '' && q.master !== 'any') {
    const mid = Number(q.master);
    if (!masterIds.includes(mid)) return { err: 'master_unavailable' };
    masterIds = [mid]; fixed = mid;
    if (groups) groups = groups.filter(g => g.masterIds.includes(mid)).map(g => ({ ...g, masterIds: [mid] }));
  }
  const isCombo = ids.length > 1;
  const chainOk = isCombo && fixed == null && eligBy.every(e => e.length);
  if (!masterIds.length && !chainOk) return { err: 'no_masters' };
  const svc = isCombo
    ? { id: null, name: items.map(s => s.name).join(' + '),
        duration_min: items.reduce((a, s) => a + (Number(s.duration_min) || 60), 0),
        price: items.reduce((a, s) => a + (Number(s.price) || 0), 0) }
    : (groups && fixed != null ? groups[0].svc : items[0]); // фіксований топ-майстер → його послуга
  return { svc, items, ids, isCombo, fixed, masterIds, eligBy: eligBy.map(e => e.map(m => m.id)), names, groups };
}
// вільні слоти на дату для вибору (одна послуга або комплекс) — у форматі API
async function slotsFor(sel, date) {
  if (!sel.isCombo && sel.groups && sel.groups.length > 1) {
    // базова група першою (дешевше), топ-майстер — на час, де базові зайняті; один слот на час
    const seen = new Set(), out = [];
    for (const g of sel.groups) {
      const sl = await slotEngine.freeSlotsForDate(getPool(), { date, masterIds: g.masterIds, durationMin: Number(g.svc.duration_min) || 60 });
      for (const s of sl) if (!seen.has(s.startMin)) { seen.add(s.startMin); out.push(s); }
    }
    out.sort((a, b) => a.startMin - b.startMin);
    return out.map(s => ({ label: s.label, start_min: s.startMin, master_id: Number(s.masterId), master_name: sel.names.get(Number(s.masterId)) || null }));
  }
  if (!sel.isCombo) {
    const sl = await slotEngine.freeSlotsForDate(getPool(), { date, masterIds: sel.masterIds, durationMin: Number(sel.svc.duration_min) || 60 });
    return sl.map(s => ({ label: s.label, start_min: s.startMin, master_id: Number(s.masterId), master_name: sel.names.get(Number(s.masterId)) || null }));
  }
  const sl = await combo.comboSlots(getPool(), { date, items: sel.items, eligAll: sel.masterIds, eligBy: sel.eligBy, fixedMaster: sel.fixed });
  return sl.map(s => ({
    label: s.label, start_min: s.startMin, master_id: s.legs[0].master_id, master_name: sel.names.get(s.legs[0].master_id) || null,
    legs: s.legs.map(l => ({ master_id: l.master_id, master_name: sel.names.get(l.master_id) || null, start_min: l.start_min,
      dur: l.dur, service_ids: l.items.map(it => it.id), services: l.items.map(it => it.name) })),
  }));
}

router.get('/days', async (req, res) => {
  try {
    const sel = await resolveSel(req.query);
    if (sel.err) return res.status(400).json({ error: sel.err });
    const today = slotEngine.kyivToday();
    const from = isDate(req.query.from) && req.query.from >= today ? req.query.from : today;
    const n = Math.min(Math.max(Number(req.query.n) || 7, 1), DAYS_MAX);
    const st = await slotEngine.getSettings(getPool());
    const days = [];
    for (let i = 0; i < n; i++) {
      const date = slotEngine.addDays(from, i);
      const ahead = Math.round((Date.parse(date) - Date.parse(today)) / 86400000);
      if (ahead > st.horizonDays) { days.push({ date, count: 0 }); continue; }
      const sl = await slotsFor(sel, date);
      days.push({ date, count: sl.length });
    }
    res.json({ today, days });
  } catch (e) { console.error('[miniapp/days]', e.message); res.status(500).json({ error: 'server' }); }
});

router.get('/slots', async (req, res) => {
  try {
    const sel = await resolveSel(req.query);
    if (sel.err) return res.status(400).json({ error: sel.err });
    if (!isDate(req.query.date) || req.query.date < slotEngine.kyivToday()) return res.status(400).json({ error: 'bad_date' });
    res.json({ date: req.query.date, slots: await slotsFor(sel, req.query.date) });
  } catch (e) { console.error('[miniapp/slots]', e.message); res.status(500).json({ error: 'server' }); }
});

// ── бронь ─────────────────────────────────────────────────────────
const inflight = new Map();      // ключ (uid|master|date|start|service) → Promise — подвійний тап = одна бронь
const rate = new Map();          // uid → [timestamps]
function rateOk(uid) {
  const now = Date.now();
  const arr = (rate.get(uid) || []).filter(t => now - t < 60000);
  arr.push(now); rate.set(uid, arr);
  if (rate.size > 5000) rate.clear();
  return arr.length <= 10;
}

async function ownActive(clientId, ids) {
  const list = (Array.isArray(ids) ? ids : String(ids || '').split(/[.,]/)).map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!list.length || list.length > 10) return [];
  const r = await getPool().query(
    `SELECT id FROM appointments WHERE id = ANY($1::int[]) AND client_id=$2
        AND status IN ('booked','confirmed') AND starts_at > NOW()`, [list, clientId]);
  return r.rows.map(x => Number(x.id));
}

const TAKEN = { status: 409, body: { error: 'slot_taken', message: 'Час щойно зайняли, оберіть інший' } };

async function doBook(req) {
  const uid = req.tgUser.id;
  const b = req.body || {};
  const c = await clientOf(uid);
  if (!c || !c.phone) return { status: 412, body: { error: 'need_phone' } };
  if (Array.isArray(b.service_ids) && b.service_ids.length > 1) return doBookCombo(req, c);
  if (b.master_id == null || b.master_id === 'any') return { status: 400, body: { error: 'need_master' } };
  const sel = await resolveSel({ service: b.service_id != null ? b.service_id : (Array.isArray(b.service_ids) ? b.service_ids[0] : null), master: b.master_id });
  if (sel.err) return { status: 400, body: { error: sel.err } };
  const masterId = sel.masterIds[0];
  const masterName = sel.names.get(masterId) || '';
  const date = b.date, startMin = Number(b.start_min);
  if (!isDate(date) || !Number.isInteger(startMin) || startMin < 0 || startMin >= 24 * 60) return { status: 400, body: { error: 'bad_slot' } };
  const dur = Number(sel.svc.duration_min) || 60;
  // price-materials-0411: варіант довжини (робота + матеріал). У візит іде РОБОТА; матеріал — оцінкою й підказкою адміну.
  let hv = null, est = null;
  if (b.variant_id != null && b.variant_id !== '') {
    hv = await hairVariants.variantFor(getPool(), b.variant_id, sel.svc.id);
    if (!hv) return { status: 400, body: { error: 'bad_variant', message: 'Ціни щойно оновилися — оберіть довжину ще раз.' } };
    // price-cards-0411: у топ-майстра — його послуга CRM; ціна прайсу — за майстром; опції — лише з процедури
    if (hairVariants.serviceFor(hv.proc, hv.v, masterId) !== Number(sel.svc.id)) return { status: 400, body: { error: 'bad_variant', message: 'Ціни щойно оновилися — оберіть послугу ще раз.' } };
    est = hairVariants.estimateOf(hv.proc, hv.v, { unknown: b.length_unknown === true, masterId, addons: hairVariants.pickAddons(hv.proc, b.addons) });
  }
  const single = hv && hv.proc.variants.length === 1 && hv.proc.variant_kind !== 'length';
  const svcTitle = hv ? (single ? hv.proc.title : `${hv.proc.title} · ${est.length_unknown ? 'довжину визначить майстер' : hv.v.label + (hv.v.cm ? ' (' + hv.v.cm + ')' : '')}`)
    + (est.addons && est.addons.length ? ' + ' + est.addons.map(a => a.label).join(', ') : '') : sel.svc.name;
  const services = [{ id: sel.svc.id, name: sel.svc.name, duration_min: dur, price: sel.svc.price }];
  const moveIds = b.move_ids ? await ownActive(c.id, b.move_ids) : [];
  if (b.move_ids && !moveIds.length) return { status: 409, body: { error: 'move_gone', message: 'Запис, який ви переносите, вже неактуальний.' } };

  const clientName = c.name || req.tgUser.first_name || 'Клієнт';
  const bookArgs = { pool: getPool(), clientId: c.id, masterId, masterName, date, startMin, services,
    name: clientName, phone: fmtPhoneFull(c.phone), telegramId: uid, apptSource: 'miniapp', obChannel: 'miniapp', dedupeClient: true };

  // слот має бути реальним вільним слотом движка (години роботи, lead, перерви)
  const free = await slotEngine.freeSlotsForDate(getPool(), { date, masterIds: [masterId], durationMin: dur });
  let result;
  try {
    if (!free.some(s => s.startMin === startMin)) {
      // не вільний: можливо, це повтор того ж клієнта (тап після успіху) → createBooking з dedupe поверне його запис;
      // інакше — нічого не створюємо, «час зайняли»
      const ex = await getPool().query(
        `SELECT 1 FROM appointments WHERE client_id=$1 AND master_id=$2 AND status IN ('booked','confirmed')
            AND starts_at = ${slotEngine.TS_EXPR(3, 4)} LIMIT 1`, [c.id, masterId, date, startMin]);
      if (!ex.rows.length) return TAKEN;
      result = await core.createBooking(bookArgs);
      if (!result.existing) throw new Error('unexpected-new-booking');
    } else {
      result = await core.createBooking(bookArgs);
    }
  } catch (e) {
    if (e.slotTaken) return TAKEN;
    throw e;
  }
  const out = {
    ids: result.apptIds, existing: !!result.existing, date, date_label: fmtDateUa(date),
    time: `${minLabel(startMin)}–${minLabel(startMin + dur)}`, master: masterName, service: svcTitle,
    price: Number(sel.svc.price) || 0, duration: fmtDur(dur),
  };
  if (est) {
    out.estimate = est; out.estimate_text = hairVariants.estimateText(est);
    out.price_note = est.list ? (est.hint || (est.from ? 'точну суму назве майстер після огляду' : '')) : 'орієнтовно, точну суму назве майстер після огляду';
  }
  if (result.existing) return { status: 200, body: { ok: true, booking: out } };

  const pool = getPool();
  if (est && result.apptIds.length) {
    // візит = робота; оцінка (робота+матеріал, довжина) — у price_estimate, підказка адміну — у нотатку візиту
    const hint = '💡 ' + hairVariants.adminHint(est);
    await pool.query(
      `UPDATE appointments SET length_variant_id=$2, price_estimate=$3::jsonb,
              notes = CASE WHEN COALESCE(notes,'') LIKE '%' || $4 || '%' THEN notes
                           ELSE NULLIF(concat_ws(E'\n', NULLIF(notes,''), $4::text), '') END
        WHERE id = ANY($1::int[])`,
      [result.apptIds, hv.v.id, JSON.stringify(est), hint]).catch(e => console.error('[miniapp/estimate]', e.message));
  }
  if (b.remind24 === false && result.apptIds.length) {
    // клієнт вимкнув «Нагадати за 24 год» → позначаємо 24h як уже оброблене (нагадування за 2 год лишається)
    await pool.query(
      `INSERT INTO booking_reminders (appointment_id, kind)
       SELECT x, '24h' FROM unnest($1::int[]) AS x
        WHERE NOT EXISTS (SELECT 1 FROM booking_reminders r WHERE r.appointment_id = x AND r.kind = '24h')`,
      [result.apptIds]).catch(e => console.error('[miniapp/remind24]', e.message));
  }
  let moved = false;
  if (moveIds.length) {
    try { await core.cancelAppointments(pool, moveIds); moved = true; } catch (e) { console.error('[miniapp/move-cancel]', e.message); }
  }
  out.moved = moved;
  const tg = botTg();
  setImmediate(() => runAs(DEFAULT_TENANT_ID, async () => {
    const miniUrl = (require('../lib/public-url').getPublicBase() || '') + '/p/app.html';
    try {
      await tg('sendMessage', {
        chat_id: uid, parse_mode: 'HTML',
        text: `${moved ? '🔁 <b>Запис перенесено!</b>' : '✅ <b>Запис підтверджено!</b>'}\n\n💅 ${esc(svcTitle)}\n💇 ${esc(masterName)}\n📅 ${esc(out.date_label)}, <b>${out.time}</b>\n💰 ${est ? (est.list ? esc(out.estimate_text) + (out.price_note ? '\n' + esc(out.price_note) : '') : 'орієнтовно ' + esc(out.estimate_text) + '\nТочну суму назве майстер після огляду.') : fmtPrice(out.price)}\n\n${b.remind24 === false ? 'Нагадаємо за 2 години до візиту.' : 'Нагадаємо за 24 і за 2 години до візиту.'}\nЧекаємо вас у SVS Beauty Space 💛`,
        reply_markup: { inline_keyboard: [[{ text: '👤 Мої записи', web_app: { url: miniUrl + '?screen=cabinet' } }]] },
      });
    } catch (e) { console.error('[miniapp/notify-client]', e.message); }
    try {
      await core.notifyStaff(pool, tg,
        `${moved ? '🔁 <b>Перенесення запису</b>' : '🆕 <b>Новий онлайн-запис</b>'} (Telegram-застосунок)\n👤 ${esc(clientName)} ${esc(fmtPhoneFull(c.phone))}\n💅 ${esc(est ? svcTitle : sel.svc.name)}\n💇 ${esc(masterName)}\n📅 ${esc(out.date_label)}, ${out.time}\n💰 ${est ? 'робота ' + fmtPrice(out.price) + ' · клієнту показано ' + esc(out.estimate_text) + '\n💡 ' + esc(hairVariants.adminHint(est)) : fmtPrice(out.price)}`);
    } catch (e) { console.error('[miniapp/notify-staff]', e.message); }
    // передоплата Mono — та сама логіка, що в бота (інвойс лише якщо налаштовано правилами салону)
    if (result.bookingId && process.env.MONO_TOKEN) {
      try {
        const inv = await require('./payments-mono').createInvoiceForBooking(result.bookingId);
        if (inv && inv.pageUrl) {
          await tg('sendMessage', { chat_id: uid, text: `💳 Передоплата: ${inv.amount} грн`,
            reply_markup: { inline_keyboard: [[{ text: `Оплатити ${inv.amount} грн`, url: inv.pageUrl }]] } });
        }
      } catch (e) { console.error('[miniapp/prepay]', e.message); }
    }
  }).catch(e => console.error('[miniapp/after-book]', e.message)));
  return { status: 200, body: { ok: true, booking: out } };
}

// ── combo-0411: комплекс (кілька послуг підряд) ─────────────────────
// Сервер САМ перераховує розклад на обраний старт; якщо він не збігся з тим, що клієнт бачив
// (майстри по ногах), — «час щойно зайняли», без тихої підміни майстра.
async function doBookCombo(req, c) {
  const uid = req.tgUser.id;
  const b = req.body || {};
  if (b.move_ids) return { status: 400, body: { error: 'combo_move', message: 'Перенесення працює для одного запису.' } };
  const sel = await resolveSel({ services: b.service_ids, master: b.master_id });
  if (sel.err) return { status: 400, body: { error: sel.err } };
  const date = b.date, startMin = Number(b.start_min);
  if (!isDate(date) || !Number.isInteger(startMin) || startMin < 0 || startMin >= 24 * 60) return { status: 400, body: { error: 'bad_slot' } };
  // варіанти довжини (волосся) — по кожній послузі окремо
  const ests = new Map();
  for (const v of (Array.isArray(b.variants) ? b.variants : [])) {
    const sid = Number(v && v.service_id);
    if (!sel.ids.includes(sid) || v.variant_id == null || v.variant_id === '') continue;
    const hv = await hairVariants.variantFor(getPool(), v.variant_id, sid);
    if (!hv) return { status: 400, body: { error: 'bad_variant', message: 'Ціни щойно оновилися — оберіть довжину ще раз.' } };
    ests.set(sid, { hv, unknown: v.length_unknown === true, addons: hairVariants.pickAddons(hv.proc, v.addons),
      est: hairVariants.estimateOf(hv.proc, hv.v, { unknown: v.length_unknown === true }) });
  }
  const plan = (await combo.comboSlots(getPool(), { date, items: sel.items, eligAll: sel.masterIds, eligBy: sel.eligBy, fixedMaster: sel.fixed }))
    .find(s => s.startMin === startMin);
  if (!plan) return TAKEN;
  if (Array.isArray(b.legs) && b.legs.length) {
    const want = b.legs.map(l => `${Number(l.master_id)}@${Number(l.start_min)}`).join(',');
    const got = plan.legs.map(l => `${l.master_id}@${l.start_min}`).join(',');
    if (want !== got) return { status: 409, body: { error: 'slot_taken', message: 'Розклад щойно змінився — оберіть час ще раз' } };
  }
  const legs = plan.legs.map(l => Object.assign({}, l, { master_name: sel.names.get(l.master_id) || '' }));
  // price-cards-0411: ціна прайсу — за майстром ноги (топ/інші) + опції
  for (const l of legs) for (const it of l.items) {
    const x = ests.get(Number(it.id));
    if (x) x.est = hairVariants.estimateOf(x.hv.proc, x.hv.v, { unknown: x.unknown, masterId: l.master_id, addons: x.addons });
  }
  const clientName = c.name || req.tgUser.first_name || 'Клієнт';
  let result;
  try {
    result = await combo.bookCombo({ pool: getPool(), core, legs, date,
      base: { pool: getPool(), clientId: c.id, name: clientName, phone: fmtPhoneFull(c.phone), telegramId: uid,
        apptSource: 'miniapp', obChannel: 'miniapp', dedupeClient: false } });
  } catch (e) {
    if (e.slotTaken) return TAKEN;
    throw e;
  }
  const pool = getPool();
  // appointment id кожної послуги (порядок ніг і послуг у нозі = порядок createBooking)
  const apptOf = new Map();
  legs.forEach((l, i) => l.items.forEach((it, j) => { const id = result.perLeg[i].apptIds[j]; if (id) apptOf.set(Number(it.id), id); }));
  for (const [sid, x] of ests) {
    const aid = apptOf.get(sid); if (!aid) continue;
    const hint = '💡 ' + hairVariants.adminHint(x.est);
    await pool.query(
      `UPDATE appointments SET length_variant_id=$2, price_estimate=$3::jsonb,
              notes = CASE WHEN COALESCE(notes,'') LIKE '%' || $4 || '%' THEN notes
                           ELSE NULLIF(concat_ws(E'\n', NULLIF(notes,''), $4::text), '') END
        WHERE id = $1`, [aid, x.hv.v.id, JSON.stringify(x.est), hint]).catch(e => console.error('[miniapp/combo-estimate]', e.message));
  }
  if (b.remind24 === false && result.apptIds.length) {
    await pool.query(
      `INSERT INTO booking_reminders (appointment_id, kind)
       SELECT x, '24h' FROM unnest($1::int[]) AS x
        WHERE NOT EXISTS (SELECT 1 FROM booking_reminders r WHERE r.appointment_id = x AND r.kind = '24h')`,
      [result.apptIds]).catch(e => console.error('[miniapp/remind24]', e.message));
  }
  const titleOf = (it) => { const x = ests.get(Number(it.id)); return x ? `${x.hv.proc.title} · ${x.est.length_unknown ? 'довжину визначить майстер' : x.hv.v.label}` : it.name; };
  const priceOf = (it) => { const x = ests.get(Number(it.id)); if (!x) return Number(it.price) || 0;
    const e = x.est; if (e.list) return e.length_unknown ? e.range[0] : e.total;
    return e.length_unknown ? e.range[0] : (e.material_mode === 'extra' || !e.material_known ? e.work : e.total); };
  const total = sel.items.reduce((a, it) => a + priceOf(it), 0);
  const dur = Number(sel.svc.duration_min);
  const masters = [...new Set(legs.map(l => l.master_name))];
  const out = {
    ids: result.apptIds, existing: false, combo: true, date, date_label: fmtDateUa(date),
    time: `${minLabel(startMin)}–${minLabel(startMin + dur)}`, master: masters.join(', '),
    service: sel.items.map(titleOf).join(' + '), price: total, duration: fmtDur(dur),
    legs: legs.map(l => ({ master: l.master_name, time: `${minLabel(l.start_min)}–${minLabel(l.start_min + l.dur)}`, services: l.items.map(titleOf) })),
  };
  if (ests.size) { out.estimate_text = `≈ ${total} грн (орієнтовно)`; out.price_note = 'орієнтовно, точну суму назве майстер після огляду'; }
  const lines = out.legs.map(l => `• ${l.time} — ${esc(l.services.join(' + '))} (${esc(l.master)})`).join('\n');
  const tg = botTg();
  setImmediate(() => runAs(DEFAULT_TENANT_ID, async () => {
    const miniUrl = (require('../lib/public-url').getPublicBase() || '') + '/p/app.html';
    try {
      await tg('sendMessage', {
        chat_id: uid, parse_mode: 'HTML',
        text: `✅ <b>Запис підтверджено!</b> Комплекс за один візит\n\n📅 ${esc(out.date_label)}, <b>${out.time}</b>\n${lines}\n💰 ${ests.size ? 'орієнтовно ' : ''}${fmtPrice(total)}\n\n${b.remind24 === false ? 'Нагадаємо за 2 години до візиту.' : 'Нагадаємо за 24 і за 2 години до візиту.'}\nЧекаємо вас у SVS Beauty Space 💛`,
        reply_markup: { inline_keyboard: [[{ text: '👤 Мої записи', web_app: { url: miniUrl + '?screen=cabinet' } }]] },
      });
    } catch (e) { console.error('[miniapp/notify-client]', e.message); }
    try {
      const hints = [...ests.values()].map(x => '💡 ' + esc(hairVariants.adminHint(x.est))).join('\n');
      await core.notifyStaff(pool, tg,
        `🆕 <b>Новий онлайн-запис — комплекс</b> (Telegram-застосунок)\n👤 ${esc(clientName)} ${esc(fmtPhoneFull(c.phone))}\n📅 ${esc(out.date_label)}, ${out.time}\n${lines}\n💰 ${fmtPrice(total)}${hints ? '\n' + hints : ''}`);
    } catch (e) { console.error('[miniapp/notify-staff]', e.message); }
    if (process.env.MONO_TOKEN) {
      for (const bid of result.bookingIds) {
        try {
          const inv = await require('./payments-mono').createInvoiceForBooking(bid);
          if (inv && inv.pageUrl) {
            await tg('sendMessage', { chat_id: uid, text: `💳 Передоплата: ${inv.amount} грн`,
              reply_markup: { inline_keyboard: [[{ text: `Оплатити ${inv.amount} грн`, url: inv.pageUrl }]] } });
          }
        } catch (e) { console.error('[miniapp/prepay]', e.message); }
      }
    }
  }).catch(e => console.error('[miniapp/after-book]', e.message)));
  return { status: 200, body: { ok: true, booking: out } };
}

router.post('/book', async (req, res) => {
  const uid = req.tgUser.id;
  const b = req.body || {};
  const key = [uid, b.master_id, b.date, b.start_min, Array.isArray(b.service_ids) ? b.service_ids.join(',') : b.service_id, b.variant_id || '', b.length_unknown ? 'u' : '',
    Array.isArray(b.addons) ? b.addons.join(',') : '', // price-cards-0411: інші опції = інша бронь
    Array.isArray(b.move_ids) ? b.move_ids.join(',') : String(b.move_ids || '')].join('|'); // перенос ≠ нова бронь
  try {
    let p = inflight.get(key);
    if (!p) {
      if (!rateOk(uid)) return res.status(429).json({ error: 'too_many', message: 'Забагато спроб, зачекайте хвилину' });
      p = doBook(req).finally(() => setTimeout(() => inflight.delete(key), 3000));
      inflight.set(key, p);
    }
    const r = await p;
    res.status(r.status).json(r.body);
  } catch (e) {
    console.error('[miniapp/book]', e.message);
    res.status(500).json({ error: 'server', message: 'Не вдалось створити запис. Спробуйте ще раз або напишіть адміністратору.' });
  }
});

// ── кабінет ───────────────────────────────────────────────────────
router.get('/my', async (req, res) => {
  try {
    const c = await clientOf(req.tgUser.id);
    if (!c) return res.json({ client: null, upcoming: [], history: [] });
    const q = (where, order, lim = 20) => getPool().query(
      `SELECT a.id, a.status, a.service_id, a.master_id,
              (a.pay_settled_at IS NOT NULL) AS paid, COALESCE(a.pay_bonus_accrued,0)::float AS bonus_accrued,
              vr.master_stars, (vr.created_at IS NULL OR vr.created_at > NOW() - interval '24 hours') AS rate_open,
              to_char(a.starts_at AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS date,
              to_char(a.starts_at AT TIME ZONE 'Europe/Kyiv','HH24:MI') AS t1,
              to_char(a.ends_at AT TIME ZONE 'Europe/Kyiv','HH24:MI') AS t2,
              COALESCE(s.name, '') AS service, COALESCE(NULLIF(m.online_title,''), m.name, '') AS master
         FROM appointments a LEFT JOIN services s ON s.id=a.service_id LEFT JOIN masters m ON m.id=a.master_id
         LEFT JOIN visit_ratings vr ON vr.appointment_id=a.id
        WHERE a.client_id=$1 AND ${where} ORDER BY a.starts_at ${order} LIMIT ${Number(lim)}`, [c.id]);
    const up = await q(`a.status IN ('booked','confirmed') AND a.starts_at > NOW()`, 'ASC');
    const hist = await q(`(a.status IN ('done','arrived') OR (a.status IN ('booked','confirmed') AND a.starts_at <= NOW()))`, 'DESC', 300); // 04.11: історія без обрізки до 20 (у клієнта 121 візит)
    const map = (r) => ({ id: Number(r.id), date: r.date, date_label: fmtDateUa(r.date), time: r.t2 ? `${r.t1}–${r.t2}` : r.t1,
      service: r.service, master: r.master, service_id: r.service_id, master_id: r.master_id,
      // 04.11 (Босс): клієнту НЕ віддаємо суми витрат (ні ціну візиту, ні «витрачено»).
      // Лише: оплачено, скільки бонусів нараховано за візит, оцінка і чи можна її поставити/змінити.
      paid: !!r.paid, bonus_accrued: Number(r.bonus_accrued) || 0,
      rating: r.master_stars != null ? Number(r.master_stars) : null,
      can_rate: !!r.paid && !['cancelled', 'no_show'].includes(r.status) && !!r.rate_open });
    const history = hist.rows.map(map);
    // 04.11 Рахунок візиту (послуги + товари з CRM − знижки/сертифікат/бонуси/передоплата) — та сама
    // функція, що рахує каса (lib/visit-bill). Тільки для візитів, які вже почались, за останні 30 днів:
    // неоплачений → сума і кнопка «Оплатити», оплачений → «Оплачено».
    const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    for (const h of history) {
      if (h.date < since) continue;
      try { h.bill = billView(await VB.loadVisitBill(getPool(), h.id)); } catch (e) { console.error('[miniapp/my bill]', h.id, e.message); }
    }
    res.json({
      client: { name: c.name, phone: c.phone ? fmtPhoneFull(c.phone) : null, points: c.points, visits: c.visits },
      upcoming: up.rows.map(map), history,
    });
  } catch (e) { console.error('[miniapp/my]', e.message); res.status(500).json({ error: 'server' }); }
});

const VB = require('../lib/visit-bill');
// Що бачить клієнт: лише рядки рахунку і підсумок (без собівартості, без внутрішніх полів).
function billView(b) {
  if (!b) return null;
  // 04.11 (Босс): по оплаченому візиту клієнт бачить лише «Оплачено» — без сум і рядків
  // (історія витрат прихована). Суму і рядки показуємо тільки для рахунку ДО СПЛАТИ.
  if (b.paid) return { paid: true, can_pay: false };
  return { paid: !!b.paid, paid_amount: b.paid ? b.paid_amount : 0, amount: b.paid ? b.paid_amount : VB.round2(b.final || 0),
    can_pay: !b.paid && !['cancelled', 'no_show'].includes(b.status) && Number(b.final) > 0,
    lines: (b.lines || []).map(l => ({ label: l.label, amount: VB.round2(l.amount) })) };
}
// Рахунок свого візиту. Чужий / неіснуючий → 403 (не розкриваємо, чи існує запис).
async function ownBill(req, res) {
  const c = await clientOf(req.tgUser.id);
  const id = Number(req.params.id);
  if (!c || !Number.isSafeInteger(id) || id <= 0) { res.status(403).json({ error: 'forbidden' }); return null; }
  const b = await VB.loadVisitBill(getPool(), id).catch(() => null);
  if (!b || Number(b.client_id) !== Number(c.id)) { res.status(403).json({ error: 'forbidden' }); return null; }
  return b;
}
router.get('/appointments/:id/bill', async (req, res) => {
  try { const b = await ownBill(req, res); if (b) res.json({ ok: true, bill: billView(b) }); }
  catch (e) { console.error('[miniapp/bill]', e.message); res.status(500).json({ error: 'server' }); }
});
// «Оплатити» → Mono-інвойс (Apple Pay / Google Pay / картка). Сума ТІЛЬКИ з сервера.
router.post('/appointments/:id/pay', async (req, res) => {
  try {
    const b = await ownBill(req, res); if (!b) return;
    if (b.paid) return res.json({ ok: true, already_paid: true, bill: billView(b) });
    const kyiv = (d) => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
    if (kyiv(b.starts_at) > kyiv(Date.now())) return res.status(409).json({ error: 'future-visit', message: 'Оплата відкриється в день візиту.' });
    const r = await require('./payments-mono').createInvoiceForAppointment(b.appointment_id);
    if (r.alreadyPaid) return res.json({ ok: true, already_paid: true });
    if (r.nothingToPay) return res.json({ ok: true, nothing_to_pay: true });
    res.json({ ok: true, page_url: r.pageUrl, amount: r.amount });
  } catch (e) {
    console.error('[miniapp/pay]', e.message);
    const st = Number.isInteger(e.code) && e.code >= 400 && e.code < 500 ? e.code : 500;
    res.status(st).json({ error: st === 500 ? 'server' : e.message,
      message: st === 409 ? 'Цей запис не можна оплатити онлайн. Зверніться до адміністратора.' : 'Не вдалося створити оплату. Спробуйте ще раз або оплатіть у салоні.' });
  }
});

// 04.11 Оцінка майстра після ОПЛАЧЕНОГО візиту (та сама логіка, що й у боті): 1–5⭐,
// одна оцінка на візит, змінити можна 24 год, 1–3⭐ → тихе сповіщення власнику.
router.post('/appointments/:id/rate', async (req, res) => {
  try {
    const c = await clientOf(req.tgUser.id);
    const id = Number(req.params.id);
    if (!c || !Number.isSafeInteger(id) || id <= 0) return res.status(403).json({ error: 'forbidden' });
    const VL = require('../lib/visit-loyalty');
    const r = await VL.rateVisit({ apptId: id, clientId: c.id, stars: req.body && req.body.stars, field: 'master',
      ownerNotify: VL.ownerNotifier(botTg(), getPool()) }, getPool());
    if (r.error) return res.status(r.error === 'not-found' ? 403 : r.error === 'bad-stars' ? 400 : 409).json(r);
    res.json({ ok: true, rating: r.stars });
  } catch (e) { console.error('[miniapp/rate]', e.message); res.status(500).json({ error: 'server' }); }
});

router.post('/cancel', async (req, res) => {
  try {
    const c = await clientOf(req.tgUser.id);
    if (!c) return res.status(404).json({ error: 'no_client' });
    const ids = await ownActive(c.id, req.body && req.body.ids);
    if (!ids.length) return res.status(404).json({ error: 'not_found', message: 'Запис уже неактуальний.' });
    // дані для сповіщення — ДО скасування
    const info = (await getPool().query(
      `SELECT to_char(a.starts_at AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS date, to_char(a.starts_at AT TIME ZONE 'Europe/Kyiv','HH24:MI') AS t,
              s.name AS service, COALESCE(NULLIF(m.online_title,''), m.name) AS master
         FROM appointments a LEFT JOIN services s ON s.id=a.service_id LEFT JOIN masters m ON m.id=a.master_id
        WHERE a.id = ANY($1::int[]) ORDER BY a.starts_at LIMIT 1`, [ids])).rows[0] || {};
    await core.cancelAppointments(getPool(), ids);
    const tg = botTg(); const pool = getPool(); const uid = req.tgUser.id;
    setImmediate(() => runAs(DEFAULT_TENANT_ID, async () => {
      const when = info.date ? `${fmtDateUa(info.date)}, ${info.t}` : '';
      try { await tg('sendMessage', { chat_id: uid, parse_mode: 'HTML', text: `✖ <b>Запис скасовано</b>\n💅 ${esc(info.service || '')}\n📅 ${esc(when)}\n\nБудемо раді бачити вас іншим разом 💛` }); }
      catch (e) { console.error('[miniapp/cancel-client]', e.message); }
      try { await core.notifyStaff(pool, tg, `✖ <b>Клієнт скасував запис</b> (Telegram-застосунок)\n👤 ${esc(c.name || '')} ${esc(fmtPhoneFull(c.phone))}\n💅 ${esc(info.service || '')}\n💇 ${esc(info.master || '')}\n📅 ${esc(when)}`); }
      catch (e) { console.error('[miniapp/cancel-staff]', e.message); }
    }).catch(() => {}));
    res.json({ ok: true, cancelled: ids });
  } catch (e) { console.error('[miniapp/cancel]', e.message); res.status(500).json({ error: 'server' }); }
});

// 04.11 «Звʼязатися з адміністратором» (Босс: після прибирання нижнього меню зникла кнопка «Адміністратор»).
// Бот шле в чат ту саму картку салону, що й раніше кнопка «Адміністратор»: номер, по якому дзвонять одним дотиком,
// адреса, години, соцмережі. Не частіше разу на 15 с на людину — щоб не засмічувати чат подвійними тапами.
const _adminTapAt = new Map();
router.post('/admin-contact', async (req, res) => {
  const uid = req.tgUser.id; const now = Date.now();
  if (now - (_adminTapAt.get(uid) || 0) < 15000) return res.json({ ok: true, repeated: true });
  _adminTapAt.set(uid, now);
  if (_adminTapAt.size > 5000) _adminTapAt.clear();
  try {
    await runAs(DEFAULT_TENANT_ID, () => bot().showAdminContact({ pool: getPool(), tg: botTg(), tenantId: DEFAULT_TENANT_ID }, uid));
    res.json({ ok: true });
  } catch (e) { _adminTapAt.delete(uid); console.error('[miniapp/admin-contact]', e.message); res.status(500).json({ error: 'server' }); }
});

// дані для переносу: що саме переносимо (послуга+майстер) — лише свої активні записи
router.get('/move-info', async (req, res) => {
  try {
    const c = await clientOf(req.tgUser.id);
    if (!c) return res.status(404).json({ error: 'no_client' });
    const ids = await ownActive(c.id, req.query.ids);
    if (!ids.length) return res.status(404).json({ error: 'not_found', message: 'Запис уже неактуальний.' });
    const r = (await getPool().query(
      `SELECT a.service_id, a.length_variant_id, (a.price_estimate->>'length_unknown')::boolean AS length_unknown, a.master_id, to_char(a.starts_at AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS date,
              to_char(a.starts_at AT TIME ZONE 'Europe/Kyiv','HH24:MI') AS t, s.name AS service
         FROM appointments a LEFT JOIN services s ON s.id=a.service_id
        WHERE a.id = ANY($1::int[]) ORDER BY a.starts_at LIMIT 1`, [ids])).rows[0];
    res.json({ ids, service_id: r.service_id, variant_id: r.length_variant_id || null, length_unknown: !!r.length_unknown, master_id: r.master_id, date: r.date, time: r.t, service: r.service });
  } catch (e) { console.error('[miniapp/move-info]', e.message); res.status(500).json({ error: 'server' }); }
});

module.exports = router;
