/* routes/fitness.js — вертикаль ФИТНЕС (18.07.2026, приказ Босса).
   Монтируется в shop-api.js ТОЛЬКО под requireVertical('fitness') → для beauty/dental
   модуля «не существует» (404). Таблицы fitness_* (миграция 273), RLS per-tenant.

   Членства = существующий модуль абонементов (/api/subscriptions): продажа, заморозка,
   касса — там. Здесь только ЧТЕНИЕ subscriptions для допуска + атомарное списание
   визита по паттерну subscriptions.js POST /:id/use (условный UPDATE — без гонок).

   Состав: типы занятий · занятия (конфликты тренер/зал) · записи с вместимостью и
   листом ожидания (автопродвижение + уведомление) · посещаемость со списанием ·
   шаблоны недели с идемпотентным генератором · чек-ин (QR/вручную) с журналом отказов. */
const express = require('express');
const crypto = require('crypto');
const { getPool, applyTenant } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const { requireFeature } = require('../lib/feature-gate');
const hub = require('../lib/notification-hub');

const router = express.Router();
const pool = getPool();

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'booking.read' : 'booking.write';
  return requirePerm(perm)(req, res, next);
});

const err500 = (res, e) => { console.error('[fitness]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); };
const kyivToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev' }).format(new Date());

/* ── Допуск по абонементу (общая механика чек-ина и посещаемости) ─────────── */
async function findAdmission(clientId) {
  // Активный абонемент, покрывающий сегодня. Заморозка/просрочка/ноль визитов → отказ с причиной.
  const rows = (await pool.query(
    `SELECT s.id, s.status, s.visits_remaining, s.minutes_remaining, s.expires_at, p.type AS plan_type, p.name AS plan_name
       FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.client_id = $1 ORDER BY s.expires_at DESC NULLS LAST, s.id DESC LIMIT 5`, [clientId])).rows;
  if (!rows.length) return { allowed: false, reason: 'no_membership' };
  const today = kyivToday();
  for (const s of rows) {
    if (!['active', 'trial'].includes(s.status)) continue;
    if (s.expires_at && String(s.expires_at).slice(0, 10) < today) continue;
    if (s.plan_type === 'visits' && Number(s.visits_remaining) <= 0) continue;
    return { allowed: true, sub: s };
  }
  const frozen = rows.find((s) => s.status === 'frozen');
  if (frozen) return { allowed: false, reason: 'frozen', sub: frozen };
  const noVisits = rows.find((s) => ['active', 'trial'].includes(s.status) && s.plan_type === 'visits' && Number(s.visits_remaining) <= 0);
  if (noVisits) return { allowed: false, reason: 'no_visits', sub: noVisits };
  return { allowed: false, reason: 'expired', sub: rows[0] };
}

// Атомарное списание визита (паттерн subscriptions.js /use, аудит v6: гонки закрыты
// условным UPDATE). Идемпотентность — по метке в usage.notes (uniq-ключ операции).
async function consumeVisit(sub, clientId, usageKey, performedBy) {
  if (sub.plan_type === 'time') return { ok: true, balance: null }; // безлимит — нечего списывать
  const col = sub.plan_type === 'minutes' ? 'minutes_remaining' : 'visits_remaining';
  const dup = await pool.query(`SELECT balance_after FROM subscription_usage WHERE subscription_id=$1 AND notes=$2 LIMIT 1`, [sub.id, usageKey]);
  if (dup.rows[0]) return { ok: true, balance: Number(dup.rows[0].balance_after), already: true };
  const upd = await pool.query(
    `UPDATE subscriptions SET ${col} = ${col} - 1,
            status = CASE WHEN ${col} - 1 <= 0 THEN 'expired' ELSE status END, updated_at = NOW()
      WHERE id = $1 AND ${col} >= 1 AND status IN ('active','trial') RETURNING ${col} AS bal`, [sub.id]);
  if (!upd.rows[0]) return { ok: false, error: 'insufficient-balance' };
  await pool.query(
    `INSERT INTO subscription_usage (subscription_id, client_id, type, quantity, balance_after, performed_by, notes)
     VALUES ($1,$2,$3,1,$4,$5,$6)`,
    [sub.id, clientId, sub.plan_type === 'minutes' ? 'minutes' : 'visit', Number(upd.rows[0].bal), performedBy || null, usageKey]);
  return { ok: true, balance: Number(upd.rows[0].bal) };
}

/* ── Типы занятий ──────────────────────────────────────────────────────────── */
router.get('/class-types', requireFeature('fitness.classes'), async (_req, res) => {
  try { res.json({ ok: true, items: (await pool.query(`SELECT * FROM fitness_class_types ORDER BY sort_order, id`)).rows }); }
  catch (e) { err500(res, e); }
});

router.post('/class-types', requireFeature('fitness.classes'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name-required' });
    const r = await pool.query(
      `INSERT INTO fitness_class_types (name, color, duration_min, default_capacity, sort_order)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [String(b.name).trim(), b.color || '#7c5cff', +b.duration_min || 60, +b.default_capacity || 10, +b.sort_order || 0]);
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { err500(res, e); }
});

router.patch('/class-types/:id', requireFeature('fitness.classes'), async (req, res) => {
  try {
    const b = req.body || {}; const sets = []; const vals = []; let i = 1;
    for (const f of ['name', 'color', 'duration_min', 'default_capacity', 'active', 'sort_order']) {
      if (b[f] !== undefined) { sets.push(`${f}=$${i++}`); vals.push(b[f]); }
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing-to-update' });
    vals.push(+req.params.id);
    const r = await pool.query(`UPDATE fitness_class_types SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { err500(res, e); }
});

/* ── Занятия ───────────────────────────────────────────────────────────────── */
// Конфликт тренера/зала внутри fitness_classes (салонные гварды не трогаем — изоляция)
async function classConflict({ trainerId, roomId, startsAt, endsAt, excludeId }) {
  const r = await pool.query(
    `SELECT id, trainer_id, room_id FROM fitness_classes
      WHERE status='scheduled' AND tstzrange(starts_at, ends_at) && tstzrange($1::timestamptz, $2::timestamptz)
        AND ($3::bigint IS NULL OR id <> $3)
        AND ((trainer_id IS NOT NULL AND trainer_id = $4::bigint) OR (room_id IS NOT NULL AND room_id = $5::bigint))
      LIMIT 1`, [startsAt, endsAt, excludeId || null, trainerId || null, roomId || null]);
  return r.rows[0] || null;
}

router.get('/classes', requireFeature('fitness.classes'), async (req, res) => {
  try {
    const from = req.query.from || kyivToday();
    const to = req.query.to || from;
    const r = await pool.query(
      `SELECT c.*, t.name AS type_name, t.color, m.name AS trainer_name, rm.name AS room_name,
              (SELECT COUNT(*) FROM fitness_class_bookings b WHERE b.class_id=c.id AND b.status IN ('booked','attended'))::int AS booked,
              (SELECT COUNT(*) FROM fitness_class_bookings b WHERE b.class_id=c.id AND b.status='waitlist')::int AS waitlist
         FROM fitness_classes c
         JOIN fitness_class_types t ON t.id = c.class_type_id
         LEFT JOIN masters m ON m.id = c.trainer_id
         LEFT JOIN rooms rm ON rm.id = c.room_id
        WHERE c.starts_at >= $1::date AND c.starts_at < ($2::date + 1)
        ORDER BY c.starts_at`, [from, to]);
    res.json({ ok: true, items: r.rows });
  } catch (e) { err500(res, e); }
});

router.get('/classes/:id', requireFeature('fitness.classes'), async (req, res) => {
  try {
    const c = (await pool.query(
      `SELECT c.*, t.name AS type_name, t.color, m.name AS trainer_name, rm.name AS room_name
         FROM fitness_classes c JOIN fitness_class_types t ON t.id=c.class_type_id
         LEFT JOIN masters m ON m.id=c.trainer_id LEFT JOIN rooms rm ON rm.id=c.room_id
        WHERE c.id=$1`, [+req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'not-found' });
    const bookings = (await pool.query(
      `SELECT b.*, cl.name AS client_name, cl.phone AS client_phone
         FROM fitness_class_bookings b JOIN clients cl ON cl.id=b.client_id
        WHERE b.class_id=$1 ORDER BY (b.status='waitlist'), b.waitlist_pos NULLS FIRST, b.created_at`, [c.id])).rows;
    res.json({ ok: true, item: c, bookings });
  } catch (e) { err500(res, e); }
});

router.post('/classes', requireFeature('fitness.classes'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.class_type_id || !b.starts_at) return res.status(400).json({ error: 'class_type_id and starts_at required' });
    const t = (await pool.query(`SELECT * FROM fitness_class_types WHERE id=$1`, [+b.class_type_id])).rows[0];
    if (!t) return res.status(404).json({ error: 'class-type-not-found' });
    const durMin = +b.duration_min || t.duration_min;
    const startsAt = new Date(b.starts_at);
    const endsAt = new Date(startsAt.getTime() + durMin * 60000);
    const conflict = await classConflict({ trainerId: b.trainer_id, roomId: b.room_id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });
    if (conflict) return res.status(409).json({ error: 'conflict', message: 'Тренер або зал зайняті в цей час іншим заняттям', conflict_id: conflict.id });
    const r = await pool.query(
      `INSERT INTO fitness_classes (class_type_id, trainer_id, room_id, starts_at, ends_at, capacity, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [+b.class_type_id, b.trainer_id || null, b.room_id || null, startsAt.toISOString(), endsAt.toISOString(), +b.capacity || t.default_capacity, b.note || null]);
    logAction({ user: req.user, action: 'fitness.class.create', entity: 'fitness_classes', entity_id: r.rows[0].id, ip: req.ip }).catch(() => {});
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { err500(res, e); }
});

router.patch('/classes/:id', requireFeature('fitness.classes'), async (req, res) => {
  try {
    const id = +req.params.id; const b = req.body || {};
    const cur = (await pool.query(`SELECT * FROM fitness_classes WHERE id=$1`, [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'not-found' });
    // Отмена занятия: живые записи → cancelled + уведомляем записанных
    if (b.status === 'cancelled' && cur.status !== 'cancelled') {
      await pool.query(`UPDATE fitness_classes SET status='cancelled', updated_at=NOW() WHERE id=$1`, [id]);
      const affected = (await pool.query(
        `UPDATE fitness_class_bookings SET status='cancelled', updated_at=NOW()
          WHERE class_id=$1 AND status IN ('booked','waitlist') RETURNING client_id`, [id])).rows;
      const when = new Date(cur.starts_at).toLocaleString('uk-UA', { timeZone: 'Europe/Kiev', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      for (const a of affected) {
        hub.enqueue({ clientId: a.client_id, body: `На жаль, заняття ${when} скасовано. Оберіть, будь ласка, інший час.`,
          priority: 'high', category: 'transactional', source: 'fitness', dedupKey: `fitclass:${id}:cancel:${a.client_id}` }).catch(() => {});
      }
      logAction({ user: req.user, action: 'fitness.class.cancel', entity: 'fitness_classes', entity_id: id, ip: req.ip, meta: { notified: affected.length } }).catch(() => {});
      return res.json({ ok: true, cancelled_bookings: affected.length });
    }
    const sets = []; const vals = []; let i = 1;
    for (const f of ['trainer_id', 'room_id', 'capacity', 'note', 'status', 'starts_at', 'ends_at']) {
      if (b[f] !== undefined) { sets.push(`${f}=$${i++}`); vals.push(b[f]); }
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing-to-update' });
    if (b.starts_at || b.trainer_id !== undefined || b.room_id !== undefined) {
      const conflict = await classConflict({
        trainerId: b.trainer_id !== undefined ? b.trainer_id : cur.trainer_id,
        roomId: b.room_id !== undefined ? b.room_id : cur.room_id,
        startsAt: b.starts_at || cur.starts_at, endsAt: b.ends_at || cur.ends_at, excludeId: id });
      if (conflict) return res.status(409).json({ error: 'conflict', message: 'Тренер або зал зайняті в цей час', conflict_id: conflict.id });
    }
    vals.push(id);
    const r = await pool.query(`UPDATE fitness_classes SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${i} RETURNING *`, vals);
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { err500(res, e); }
});

/* ── Записи на занятие: вместимость + лист ожидания ────────────────────────── */
router.post('/classes/:id/book', requireFeature('fitness.classes'), async (req, res) => {
  const client = await pool.connect();
  try {
    const classId = +req.params.id; const clientId = +req.body?.client_id;
    if (!clientId) return res.status(400).json({ error: 'client_id-required' });
    await client.query('BEGIN');
    // КРИТИЧНО: ручной client идёт мимо AsyncLocalStorage-обёртки пула → без applyTenant
    // строки писались бы в дефолтный тенант (смешивание данных). Урок E2E 18.07.
    await applyTenant(client);
    // FOR UPDATE класса = сериализация записей на одно занятие (нет гонки за последнее место)
    const c = (await client.query(`SELECT * FROM fitness_classes WHERE id=$1 FOR UPDATE`, [classId])).rows[0];
    if (!c || c.status !== 'scheduled') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'class-unavailable' }); }
    const cnt = (await client.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('booked','attended'))::int AS booked,
              COALESCE(MAX(waitlist_pos), 0) AS maxpos
         FROM fitness_class_bookings WHERE class_id=$1`, [classId])).rows[0];
    const isWait = cnt.booked >= c.capacity;
    const r = await client.query(
      `INSERT INTO fitness_class_bookings (class_id, client_id, subscription_id, status, waitlist_pos, note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [classId, clientId, req.body?.subscription_id || null, isWait ? 'waitlist' : 'booked',
       isWait ? Number(cnt.maxpos) + 1 : null, req.body?.note || null]);
    await client.query('COMMIT');
    logAction({ user: req.user, action: 'fitness.book', entity: 'fitness_class_bookings', entity_id: r.rows[0].id, ip: req.ip, meta: { waitlist: isWait } }).catch(() => {});
    res.json({ ok: true, item: r.rows[0], waitlist: isWait });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (String(e.message).includes('uq_fcb_class_client_live')) return res.status(409).json({ error: 'already-booked', message: 'Клієнт вже записаний на це заняття' });
    err500(res, e);
  } finally { client.release(); }
});

// Отмена записи → автопродвижение первого из листа ожидания + уведомление
router.post('/bookings/:id/cancel', requireFeature('fitness.classes'), async (req, res) => {
  try {
    const b = (await pool.query(
      `UPDATE fitness_class_bookings SET status='cancelled', updated_at=NOW()
        WHERE id=$1 AND status IN ('booked','waitlist') RETURNING *`, [+req.params.id])).rows[0];
    if (!b) return res.status(404).json({ error: 'not-found-or-final' });
    let promoted = null;
    if (b.status === 'cancelled' && b.waitlist_pos === null) { // освободилось живое место
      promoted = (await pool.query(
        `UPDATE fitness_class_bookings SET status='booked', waitlist_pos=NULL, updated_at=NOW()
          WHERE id = (SELECT id FROM fitness_class_bookings WHERE class_id=$1 AND status='waitlist'
                       ORDER BY waitlist_pos NULLS LAST, created_at LIMIT 1)
          RETURNING *`, [b.class_id])).rows[0] || null;
      if (promoted) {
        const c = (await pool.query(
          `SELECT c.starts_at, t.name FROM fitness_classes c JOIN fitness_class_types t ON t.id=c.class_type_id WHERE c.id=$1`, [b.class_id])).rows[0];
        const when = c ? new Date(c.starts_at).toLocaleString('uk-UA', { timeZone: 'Europe/Kiev', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
        hub.enqueue({ clientId: promoted.client_id, body: `Гарна новина! Звільнилось місце на «${c?.name || 'заняття'}» ${when} — вас записано.`,
          priority: 'high', category: 'transactional', source: 'fitness', dedupKey: `fitbook:${promoted.id}:promoted` }).catch(() => {});
      }
    }
    res.json({ ok: true, promoted: promoted ? { booking_id: promoted.id, client_id: promoted.client_id } : null });
  } catch (e) { err500(res, e); }
});

// Посещаемость: attended → чек-ин + списание визита с абонемента (идемпотентно)
router.post('/bookings/:id/attend', requireFeature('fitness.classes'), async (req, res) => {
  try {
    const b = (await pool.query(
      `SELECT b.*, c.status AS class_status FROM fitness_class_bookings b
        JOIN fitness_classes c ON c.id=b.class_id WHERE b.id=$1`, [+req.params.id])).rows[0];
    if (!b) return res.status(404).json({ error: 'not-found' });
    if (!['booked', 'waitlist', 'noshow'].includes(b.status)) return res.status(409).json({ error: 'bad-status', status: b.status });
    let consumed = null;
    if (req.body?.consume !== false) {
      const adm = b.subscription_id
        ? { allowed: true, sub: (await pool.query(`SELECT s.*, p.type AS plan_type FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.id=$1`, [b.subscription_id])).rows[0] }
        : await findAdmission(b.client_id);
      if (adm.allowed && adm.sub) {
        const c = await consumeVisit(adm.sub, b.client_id, `class:${b.id}`, req.user?.display_name);
        if (!c.ok) return res.status(409).json({ error: c.error, message: 'На абонементі не лишилось візитів' });
        consumed = { subscription_id: adm.sub.id, balance: c.balance };
      } else if (!req.body?.allow_without_membership) {
        return res.status(409).json({ error: 'no-valid-membership', reason: adm.reason,
          message: 'У клієнта немає дійсного абонемента. Прийміть разову оплату через касу або підтвердіть відвідування без абонемента.' });
      }
    }
    await pool.query(`UPDATE fitness_class_bookings SET status='attended', updated_at=NOW() WHERE id=$1`, [b.id]);
    await pool.query(
      `INSERT INTO fitness_checkins (client_id, subscription_id, source, class_booking_id, performed_by)
       VALUES ($1,$2,'class',$3,$4)`, [b.client_id, consumed?.subscription_id || null, b.id, req.user?.display_name || null]);
    res.json({ ok: true, consumed });
  } catch (e) { err500(res, e); }
});

router.post('/bookings/:id/noshow', requireFeature('fitness.classes'), async (req, res) => {
  try {
    const r = await pool.query(`UPDATE fitness_class_bookings SET status='noshow', updated_at=NOW() WHERE id=$1 AND status='booked' RETURNING id`, [+req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found-or-final' });
    res.json({ ok: true });
  } catch (e) { err500(res, e); }
});

/* ── Шаблоны недели + идемпотентный генератор ──────────────────────────────── */
router.get('/templates', requireFeature('fitness.classes'), async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT tp.*, t.name AS type_name, t.duration_min, m.name AS trainer_name, rm.name AS room_name
         FROM fitness_class_templates tp JOIN fitness_class_types t ON t.id=tp.class_type_id
         LEFT JOIN masters m ON m.id=tp.trainer_id LEFT JOIN rooms rm ON rm.id=tp.room_id
        WHERE tp.active ORDER BY tp.day_of_week, tp.time_start`);
    res.json({ ok: true, items: r.rows });
  } catch (e) { err500(res, e); }
});

router.post('/templates', requireFeature('fitness.classes'), async (req, res) => {
  try {
    const b = req.body || {};
    if (b.day_of_week === undefined || !b.time_start || !b.class_type_id) return res.status(400).json({ error: 'day_of_week, time_start, class_type_id required' });
    const r = await pool.query(
      `INSERT INTO fitness_class_templates (day_of_week, time_start, class_type_id, trainer_id, room_id, capacity)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [+b.day_of_week, b.time_start, +b.class_type_id, b.trainer_id || null, b.room_id || null, b.capacity || null]);
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { err500(res, e); }
});

router.delete('/templates/:id', requireFeature('fitness.classes'), async (req, res) => {
  try {
    await pool.query(`UPDATE fitness_class_templates SET active=false WHERE id=$1`, [+req.params.id]);
    res.json({ ok: true });
  } catch (e) { err500(res, e); }
});

// Генерация занятий из шаблонов на N недель вперёд. Идемпотентно: существующее
// занятие того же типа в то же время не создаётся повторно.
router.post('/templates/generate', requireFeature('fitness.classes'), async (req, res) => {
  try {
    const weeks = Math.min(Math.max(+req.body?.weeks || 1, 1), 8);
    const fromStr = req.body?.from || kyivToday();
    const tpls = (await pool.query(
      `SELECT tp.*, t.duration_min, t.default_capacity FROM fitness_class_templates tp
        JOIN fitness_class_types t ON t.id=tp.class_type_id WHERE tp.active`)).rows;
    let created = 0, skipped = 0;
    const from = new Date(fromStr + 'T00:00:00');
    for (let d = 0; d < weeks * 7; d++) {
      const day = new Date(from.getTime() + d * 86400000);
      const dow = (day.getDay() + 6) % 7; // 0=понедельник
      for (const tp of tpls.filter((t) => t.day_of_week === dow)) {
        const dateStr = day.toISOString().slice(0, 10);
        const startsAt = `${dateStr}T${tp.time_start}+03:00`; // Киев (летнее)
        const dur = tp.duration_min || 60;
        const exists = await pool.query(
          `SELECT 1 FROM fitness_classes WHERE class_type_id=$1 AND starts_at=$2::timestamptz LIMIT 1`, [tp.class_type_id, startsAt]);
        if (exists.rows[0]) { skipped++; continue; }
        const endsAt = new Date(new Date(startsAt).getTime() + dur * 60000).toISOString();
        await pool.query(
          `INSERT INTO fitness_classes (class_type_id, trainer_id, room_id, starts_at, ends_at, capacity)
           VALUES ($1,$2,$3,$4::timestamptz,$5,$6)`,
          [tp.class_type_id, tp.trainer_id, tp.room_id, startsAt, endsAt, tp.capacity || tp.default_capacity]);
        created++;
      }
    }
    logAction({ user: req.user, action: 'fitness.generate', entity: 'fitness_classes', ip: req.ip, meta: { created, skipped, weeks } }).catch(() => {});
    res.json({ ok: true, created, skipped });
  } catch (e) { err500(res, e); }
});

/* ── Чек-ин на входе (QR / вручную) ───────────────────────────────────────── */
const qrSecret = () => process.env.QR_SECRET || process.env.SESSION_SECRET || 'svs-fitness-qr';
const qrSign = (cid) => crypto.createHmac('sha256', qrSecret()).update(`fit:${cid}`).digest('hex').slice(0, 24);

router.get('/checkin/qr/:client_id', requireFeature('fitness.checkin'), async (req, res) => {
  const cid = +req.params.client_id;
  res.json({ ok: true, token: `${cid}.${qrSign(cid)}` });
});

router.get('/checkin/status/:client_id', requireFeature('fitness.checkin'), async (req, res) => {
  try {
    const cid = +req.params.client_id;
    const adm = await findAdmission(cid);
    const recent = (await pool.query(
      `SELECT at, source, denied, deny_reason FROM fitness_checkins WHERE client_id=$1 ORDER BY at DESC LIMIT 10`, [cid])).rows;
    res.json({ ok: true, allowed: adm.allowed, reason: adm.reason || null, subscription: adm.sub || null, recent });
  } catch (e) { err500(res, e); }
});

const DENY_TEXT = {
  no_membership: 'Немає абонемента. Запропонуйте оформити.',
  expired: 'Абонемент прострочений. Запропонуйте продовжити.',
  frozen: 'Абонемент заморожений. Розморозьте в розділі «Абонементи».',
  no_visits: 'Візити вичерпано. Запропонуйте новий пакет.',
};

router.post('/checkin', requireFeature('fitness.checkin'), async (req, res) => {
  try {
    let clientId = +req.body?.client_id || null;
    if (!clientId && req.body?.qr_token) {
      const [cid, sig] = String(req.body.qr_token).split('.');
      if (qrSign(+cid) !== sig) return res.status(400).json({ error: 'bad-qr' });
      clientId = +cid;
    }
    if (!clientId) return res.status(400).json({ error: 'client_id-or-qr-required' });
    const cl = (await pool.query(`SELECT id, name FROM clients WHERE id=$1`, [clientId])).rows[0];
    if (!cl) return res.status(404).json({ error: 'client-not-found' });
    const source = req.body?.qr_token ? 'qr' : 'manual';
    const adm = await findAdmission(clientId);
    if (!adm.allowed) {
      await pool.query(
        `INSERT INTO fitness_checkins (client_id, subscription_id, source, denied, deny_reason, performed_by)
         VALUES ($1,$2,$3,true,$4,$5)`, [clientId, adm.sub?.id || null, source, adm.reason, req.user?.display_name || null]);
      return res.json({ ok: true, allowed: false, client: cl, reason: adm.reason, message: DENY_TEXT[adm.reason] || 'Відмова' });
    }
    let consumed = null;
    if (req.body?.consume_visit && adm.sub.plan_type !== 'time') {
      const key = `checkin:${clientId}:${kyivToday()}:${Date.now()}`;
      const c = await consumeVisit(adm.sub, clientId, key, req.user?.display_name);
      if (!c.ok) return res.status(409).json({ error: c.error });
      consumed = { balance: c.balance };
    }
    const r = await pool.query(
      `INSERT INTO fitness_checkins (client_id, subscription_id, source, performed_by)
       VALUES ($1,$2,$3,$4) RETURNING id, at`, [clientId, adm.sub.id, source, req.user?.display_name || null]);
    res.json({ ok: true, allowed: true, client: cl, subscription: { id: adm.sub.id, plan: adm.sub.plan_name, type: adm.sub.plan_type, visits_remaining: adm.sub.visits_remaining, expires_at: adm.sub.expires_at }, consumed, checkin: r.rows[0] });
  } catch (e) { err500(res, e); }
});

module.exports = router;
