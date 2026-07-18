/* routes/wellness.js — вертикаль ВЕЛНЕС (Phase B, 18.07.2026).
   ТЗ: tz_modules/v2/vertical-03-wellness.md. Монтируется в shop-api.js ТОЛЬКО под
   requireVertical('wellness') → для beauty/fitness/dental модуля «не существует» (404).

   Принцип: велнес = салонное ядро (клиенты/записи/касса/пакеты=subscriptions/
   сертификаты/medical) + комнаты как ресурс расписания (booking-guard.roomBusy,
   уже встроено в /api/schedule) + парные (couples) брони — этот файл.

   Состав: couples-бронь (2 записи одной транзакцией в одном кабинете, capacity>=2)
   · связка booking_groups (отмена группы гасит обе записи) · требования услуг к
   кабинетам (service_room_requirements — включает room-логику слотов/гварда). */
const express = require('express');
const { getPool, applyTenant } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const { requireFeature } = require('../lib/feature-gate');
const bg = require('../lib/booking-guard');

const router = express.Router();
const pool = getPool();

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'booking.read' : 'booking.write';
  return requirePerm(perm)(req, res, next);
});

const err500 = (res, e) => { console.error('[wellness]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); };

/* ── Требования услуг к кабинетам (включают room-логику записи/слотов) ────── */
router.get('/service-rooms', requireFeature('wellness.rooms'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.id AS service_id, s.name, s.duration_min,
              COALESCE(srr.requires_room, false) AS requires_room, srr.preferred_room_id
         FROM services s
         LEFT JOIN service_room_requirements srr ON srr.service_id = s.id
        WHERE COALESCE(s.active, true) ORDER BY s.name`);
    res.json({ ok: true, items: r.rows });
  } catch (e) { err500(res, e); }
});

router.put('/service-rooms/:serviceId', requireFeature('wellness.rooms'), async (req, res) => {
  try {
    const sid = Number(req.params.serviceId);
    const requires = req.body?.requires_room === true;
    const preferred = req.body?.preferred_room_id ? Number(req.body.preferred_room_id) : null;
    const sv = await pool.query(`SELECT id FROM services WHERE id=$1`, [sid]);
    if (!sv.rows.length) return res.status(404).json({ error: 'service-not-found' });
    if (!requires) {
      await pool.query(`DELETE FROM service_room_requirements WHERE service_id=$1`, [sid]);
      return res.json({ ok: true, requires_room: false });
    }
    await pool.query(
      `INSERT INTO service_room_requirements (service_id, requires_room, preferred_room_id)
       VALUES ($1, true, $2)
       ON CONFLICT (service_id) DO UPDATE SET requires_room=true, preferred_room_id=$2`,
      [sid, preferred]);
    res.json({ ok: true, requires_room: true, preferred_room_id: preferred });
  } catch (e) { err500(res, e); }
});

/* ── Couples: парная бронь ─────────────────────────────────────────────────
   POST /couples { starts_at, room_id?, notes?, items:[{master_id, service_id,
     client_id? | client_name?+client_phone?}, {…}] } — ровно 2 позиции.
   Одна транзакция (applyTenant! урок 18.07): advisory-lock обоих мастеров →
   проверка вместимости мастеров → кабинет capacity>=2 (переданный или автоподбор)
   → 2 INSERT → booking_groups + items. Любой конфликт = 409, ничего не создано. */
router.post('/couples', requireFeature('wellness.couples'), async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (items.length !== 2) return res.status(400).json({ error: 'need-exactly-2-items' });
  if (!b.starts_at) return res.status(400).json({ error: 'starts_at-required' });
  const startDate = new Date(b.starts_at);
  if (isNaN(startDate)) return res.status(400).json({ error: 'bad-starts_at' });
  if (items.some(i => !i.master_id || !i.service_id)) {
    return res.status(400).json({ error: 'master_id+service_id required in each item' });
  }
  if (Number(items[0].master_id) === Number(items[1].master_id)) {
    return res.status(400).json({ error: 'masters-must-differ', message: 'Парна бронь — два різні майстри' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await applyTenant(client);
    // сериализация конкурентных броней обоих мастеров (в стабильном порядке — без дедлока)
    const mids = items.map(i => Number(i.master_id)).sort((a, z) => a - z);
    for (const m of mids) await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [String(m)]);

    // длительности/цены услуг; конец пары = максимум из двух
    const enriched = [];
    for (const it of items) {
      const sv = await client.query(`SELECT id, price, duration_min FROM services WHERE id=$1`, [Number(it.service_id)]);
      if (!sv.rows.length) throw Object.assign(new Error('service-not-found'), { http: 400 });
      const dur = Number(sv.rows[0].duration_min) || 60;
      enriched.push({ ...it, price: sv.rows[0].price, ends: new Date(startDate.getTime() + dur * 60000) });
    }
    const groupEnd = new Date(Math.max(...enriched.map(e => +e.ends)));

    // мастера свободны?
    for (const it of enriched) {
      const cap = await bg.wouldExceedParallel(
        { masterId: Number(it.master_id), startsAt: startDate, endsAt: it.ends }, client);
      if (cap.exceeds) {
        throw Object.assign(new Error('master-busy'), { http: 409,
          payload: { error: 'slot-busy', master_id: Number(it.master_id), message: 'У майстра вже є запис на цей час' } });
      }
    }

    // кабинет: переданный (с проверкой на 2 места) или автоподбор capacity>=2
    let roomId = b.room_id ? Number(b.room_id) : null;
    if (roomId) {
      const busy = await bg.roomBusy({ roomId, startsAt: startDate, endsAt: groupEnd, needCapacity: 2 }, client);
      if (busy) throw Object.assign(new Error('room-busy'), { http: 409,
        payload: { error: busy.reason || 'room-busy', message: 'Кабінет не вміщує пару на цей час' } });
    } else {
      roomId = await bg.findFreeRoom({ startsAt: startDate, endsAt: groupEnd, needCapacity: 2 }, client);
      if (!roomId) throw Object.assign(new Error('no-room'), { http: 409,
        payload: { error: 'no-room-available', message: 'Немає вільного кабінету на 2 місця (перевірте «місткість» кабінету)' } });
    }

    // клиенты: id / телефон (найти-создать) / имя
    const { normalizePhoneDb } = require('../lib/phone');
    const apptIds = [];
    for (const it of enriched) {
      let cid = it.client_id ? Number(it.client_id) : null;
      if (!cid && it.client_phone) {
        const canon = normalizePhoneDb(it.client_phone);
        if (canon) {
          const ex = await client.query(`SELECT id FROM clients WHERE phone=$1`, [canon]);
          if (ex.rows.length) cid = ex.rows[0].id;
          else cid = (await client.query(
            `INSERT INTO clients (phone, name, source, consent_given_at, consent_source)
             VALUES ($1,$2,'salon',NOW(),'admin')
             ON CONFLICT (tenant_id, phone) DO UPDATE SET name = COALESCE(NULLIF(clients.name,''), EXCLUDED.name)
             RETURNING id`, [canon, it.client_name || null])).rows[0].id;
        }
      } else if (!cid && it.client_name) {
        cid = (await client.query(`INSERT INTO clients (name, source) VALUES ($1,'salon') RETURNING id`, [it.client_name])).rows[0].id;
      }
      const r = await client.query(
        `INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, status, price, source, room_id, notes)
         VALUES ($1,$2,$3,$4,$5,'booked',$6,'admin',$7,$8) RETURNING id`,
        [cid, Number(it.master_id), Number(it.service_id), startDate.toISOString(), it.ends.toISOString(),
         it.price, roomId, b.notes || null]);
      apptIds.push(r.rows[0].id);
    }

    const grp = await client.query(
      `INSERT INTO booking_groups (kind, room_id, notes) VALUES ('couples',$1,$2) RETURNING id`,
      [roomId, b.notes || null]);
    for (const aid of apptIds) {
      await client.query(`INSERT INTO booking_group_items (group_id, appointment_id) VALUES ($1,$2)`, [grp.rows[0].id, aid]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, group_id: grp.rows[0].id, room_id: roomId, appointment_ids: apptIds });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.http) return res.status(e.http).json(e.payload || { error: e.message });
    err500(res, e);
  } finally { client.release(); }
});

// Состав парной брони
router.get('/couples/:groupId', requireFeature('wellness.couples'), async (req, res) => {
  try {
    const g = await pool.query(`SELECT * FROM booking_groups WHERE id=$1`, [Number(req.params.groupId)]);
    if (!g.rows.length) return res.status(404).json({ error: 'group-not-found' });
    const a = await pool.query(
      `SELECT a.id, a.master_id, a.service_id, a.client_id, a.starts_at, a.ends_at, a.status, a.room_id,
              c.name AS client_name, s.name AS service_name
         FROM booking_group_items i
         JOIN appointments a ON a.id = i.appointment_id
         LEFT JOIN clients c ON c.id = a.client_id
         LEFT JOIN services s ON s.id = a.service_id
        WHERE i.group_id=$1 ORDER BY a.id`, [Number(req.params.groupId)]);
    res.json({ ok: true, group: g.rows[0], appointments: a.rows });
  } catch (e) { err500(res, e); }
});

// Отмена всей пары (обе записи). Отмена ОДНОЙ записи через /api/schedule группу не рвёт.
router.post('/couples/:groupId/cancel', requireFeature('wellness.couples'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await applyTenant(client);
    const g = await client.query(`SELECT id FROM booking_groups WHERE id=$1`, [Number(req.params.groupId)]);
    if (!g.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'group-not-found' }); }
    const r = await client.query(
      `UPDATE appointments SET status='cancelled'
        WHERE id IN (SELECT appointment_id FROM booking_group_items WHERE group_id=$1)
          AND status NOT IN ('cancelled','completed') RETURNING id`, [Number(req.params.groupId)]);
    await client.query('COMMIT');
    res.json({ ok: true, cancelled: r.rows.map(x => x.id) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    err500(res, e);
  } finally { client.release(); }
});

// Занятость кабинетов на день (для страницы «Кабінети»): реюз rooms + appointments
router.get('/rooms-day', requireFeature('wellness.rooms'), async (req, res) => {
  try {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date
      : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev' }).format(new Date());
    const rooms = await pool.query(
      `SELECT id, name, color, capacity FROM rooms WHERE COALESCE(active,true) ORDER BY COALESCE(sort_order,999), id`);
    const appts = await pool.query(
      `SELECT a.id, a.room_id, a.starts_at, a.ends_at, a.status, c.name AS client_name, s.name AS service_name,
              m.name AS master_name
         FROM appointments a
         LEFT JOIN clients c ON c.id = a.client_id
         LEFT JOIN services s ON s.id = a.service_id
         LEFT JOIN masters m ON m.id = a.master_id
        WHERE a.room_id IS NOT NULL AND a.status NOT IN ('cancelled','noshow')
          AND (a.starts_at AT TIME ZONE 'Europe/Kiev')::date = $1::date
        ORDER BY a.starts_at`, [day]);
    res.json({ ok: true, date: day, rooms: rooms.rows, appointments: appts.rows });
  } catch (e) { err500(res, e); }
});

module.exports = router;
