/* routes/pipeline.js — CRM-08 Visit Pipeline (воронка візита).
   Канбан-доска візитів на день поверх існуючих статусів appointments.
   Стадії = реальні статуси записів (booked/confirmed/done/noshow/cancelled) —
   жодної ризикованої міграції, повна сумісність з журналом і розкладом.
   Ручний перехід стадії робиться існуючим PATCH /api/schedule/appointments/:id
   (він списує розхідники при 'done') — тут лише читання дошки + статистика.
   Доступ: schedule.read (як журнал). */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
// Публікація доменних подій у шину INF-01 (опційно — не валить перехід якщо шини нема)
let emit = async () => {}; try { ({ emit } = require('../lib/event-bus')); } catch { /* optional */ }

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

// GET — schedule.read; мутації — schedule.write (та сама модель доступу, що й журнал)
router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'schedule.read' : 'schedule.write';
  return requirePerm(perm)(req, res, next);
});

// Стадії воронки = колонки канбану (порядок зліва направо)
const STAGES = [
  { code: 'booked',    name: 'Заплановані',  color: '#6366f1' },
  { code: 'confirmed', name: 'Підтверджені', color: '#0ea5e9' },
  { code: 'done',      name: 'Завершені',    color: '#16a34a' },
  { code: 'noshow',    name: 'Не прийшли',   color: '#dc2626' },
  { code: 'cancelled', name: 'Скасовані',    color: '#94a3b8' },
];

// Київська дата "сьогодні" якщо не передали date
function kyivToday() {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' });
  return dtf.format(new Date()); // YYYY-MM-DD
}

// GET /api/pipeline/board?date=YYYY-MM-DD&master_id=
// Канбан на день: колонки-стадії з картками візитів.
router.get('/board', async (req, res) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : kyivToday();
    const masterId = req.query.master_id ? Number(req.query.master_id) : null;

    const rows = await pool.query(
      `SELECT a.id, a.status, a.starts_at, a.ends_at, a.price, a.updated_at,
              COALESCE(NULLIF(a.client_name,''), c.name, 'Клієнт') AS client_name,
              COALESCE(NULLIF(a.services_text,''), s.name, '—')   AS service_name,
              m.name AS master_name,
              EXTRACT(EPOCH FROM (NOW() - a.starts_at))/60 AS mins_since_start
         FROM appointments a
         LEFT JOIN clients  c ON c.id = a.client_id
         LEFT JOIN services s ON s.id = a.service_id
         LEFT JOIN masters  m ON m.id = a.master_id
        WHERE (a.starts_at AT TIME ZONE 'Europe/Kiev')::date = $1::date
          AND ($2::int IS NULL OR a.master_id = $2)
          AND a.bp_state IS DISTINCT FROM 'bp_deleted'
        ORDER BY a.starts_at`,
      [date, masterId]
    );

    // SLA «зависання»: booked/confirmed і час початку вже минув >15 хв → червоний
    const STUCK_AFTER_MIN = 15;
    const byStage = {};
    for (const st of STAGES) byStage[st.code] = [];
    for (const r of rows.rows) {
      const code = byStage[r.status] ? r.status : null;
      if (!code) continue; // незнайомий статус — пропускаємо
      const mins = Math.round(Number(r.mins_since_start) || 0);
      const stuck = (r.status === 'booked' || r.status === 'confirmed') && mins > STUCK_AFTER_MIN;
      byStage[code].push({
        id: r.id,
        client_name: r.client_name,
        service_name: r.service_name,
        master_name: r.master_name || '—',
        starts_at: r.starts_at,
        price: r.price != null ? Math.round(Number(r.price)) : null,
        mins_since_start: mins,
        stuck,
      });
    }

    res.json({
      date,
      stages: STAGES.map(st => ({ ...st, count: byStage[st.code].length, appointments: byStage[st.code] })),
    });
  } catch (e) {
    console.error('[pipeline:board]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// GET /api/pipeline/stats?from=&to= — конверсія воронки + no-show за період
router.get('/stats', async (req, res) => {
  try {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')   ? req.query.to   : null;
    const where = [];
    const params = [];
    if (from) { params.push(from); where.push(`(starts_at AT TIME ZONE 'Europe/Kiev')::date >= $${params.length}::date`); }
    if (to)   { params.push(to);   where.push(`(starts_at AT TIME ZONE 'Europe/Kiev')::date <= $${params.length}::date`); }
    if (!from && !to) where.push(`starts_at >= NOW() - INTERVAL '30 days'`);
    // Записи, видалені в BeautyPro (дублі, чистка адміном), синк позначає
    // status='cancelled', bp_state='bp_deleted'. Це НЕ скасування клієнтом —
    // не рахуємо їх у воронці, інакше відсоток відмін штучно завищений.
    where.push(`bp_state IS DISTINCT FROM 'bp_deleted'`);
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const r = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='done')::int      AS done,
              COUNT(*) FILTER (WHERE status='confirmed')::int AS confirmed,
              COUNT(*) FILTER (WHERE status='booked')::int    AS booked,
              COUNT(*) FILTER (WHERE status='noshow')::int    AS noshow,
              COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled
         FROM appointments ${w}`, params
    );
    const s = r.rows[0] || {};
    const total = s.total || 0;
    const finished = s.done + s.noshow + s.cancelled; // візити, що дійшли до результату
    res.json({
      total,
      counts: { booked: s.booked, confirmed: s.confirmed, done: s.done, noshow: s.noshow, cancelled: s.cancelled },
      done_rate:      total ? Math.round(s.done / total * 100) : 0,
      noshow_rate:    finished ? Math.round(s.noshow / finished * 100) : 0,
      cancel_rate:    total ? Math.round(s.cancelled / total * 100) : 0,
    });
  } catch (e) {
    console.error('[pipeline:stats]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// CRM-08: переходи стадій (з логом), історія, конфіг стадій, тригери
// ═══════════════════════════════════════════════════════════════════

// Допустимі коди стадій (мапляться на статуси записів; arrived/in_progress — віртуальні)
const STATUS_BY_STAGE = {
  booked: 'booked', confirmed: 'confirmed', arrived: 'confirmed',
  in_progress: 'confirmed', done: 'done', noshow: 'noshow', cancelled: 'cancelled',
};

// Best-effort виконання тригерів стадії (інтеграції — graceful, не валять перехід)
async function fireTriggers(appt, stageCode, on) {
  let fired = 0;
  try {
    const trs = await q(`SELECT * FROM visit_stage_triggers WHERE stage_code=$1 AND trigger_on=$2 AND active=true`, [stageCode, on]);
    for (const t of trs) {
      // умови: vip_only, service_ids
      const cond = t.conditions || {};
      if (cond.vip_only && !appt.is_vip) continue;
      if (Array.isArray(cond.service_ids) && cond.service_ids.length && !cond.service_ids.includes(appt.service_id)) continue;
      try {
        if (t.trigger_type === 'webhook' && t.config?.url && typeof fetch === 'function') {
          fetch(t.config.url, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ event: 'pipeline.transition', appointment_id: appt.id, stage: stageCode, on }) }).catch(()=>{});
        }
        // notification/task/checklist/event — graceful: пишемо подію в лог (інтеграція з COM-01/MGT-01 присутня як стуб)
        fired++;
      } catch (_) {}
    }
  } catch (_) {}
  return fired;
}

// ── POST /api/pipeline/transition — ручний перехід стадії з логуванням ──
router.post('/transition', async (req, res) => {
  const client = await pool.connect();
  try {
    const { appointment_id, target_stage_id, reason } = req.body || {};
    const stageCode = String(target_stage_id || '').trim();
    if (!appointment_id || !STATUS_BY_STAGE[stageCode])
      return res.status(400).json({ error: 'appointment_id and valid target_stage_id required' });
    await client.query('BEGIN');
    const appt = (await client.query(
      `SELECT id, status, service_id, client_id, COALESCE(is_vip,false) AS is_vip FROM appointments WHERE id=$1 FOR UPDATE`,
      [+appointment_id]).catch(async () => {
        // is_vip може не існувати — fallback без нього
        return client.query(`SELECT id, status, service_id, client_id, false AS is_vip FROM appointments WHERE id=$1 FOR UPDATE`, [+appointment_id]);
      })).rows[0];
    if (!appt) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'appointment not found' }); }

    // закрити попередню відкриту стадію в лозі
    await client.query(
      `UPDATE visit_stage_log SET exited_at=NOW(),
              duration_seconds=EXTRACT(EPOCH FROM (NOW()-entered_at))::int
        WHERE appointment_id=$1 AND exited_at IS NULL`, [+appointment_id]);

    // оновити реальний статус запису (мапа стадія→статус)
    const newStatus = STATUS_BY_STAGE[stageCode];
    await client.query(`UPDATE appointments SET status=$1, updated_at=NOW() WHERE id=$2`, [newStatus, +appointment_id]);

    // новий запис у лозі
    const log = (await client.query(
      `INSERT INTO visit_stage_log (appointment_id, stage_code, transitioned_by, transition_reason)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [+appointment_id, stageCode, req.user?.display_name || null, reason || null])).rows[0];
    await client.query('COMMIT');

    // Подія в шину INF-01 — інші модулі (нотифікації, задачі, аналітика) реагують асинхронно
    emit('crm.visit.stage_changed', {
      appointment_id: +appointment_id, from_status: appt.status,
      to_stage: stageCode, to_status: newStatus,
      client_id: appt.client_id, service_id: appt.service_id, reason: reason || null,
    }, { entityType: 'appointment', entityId: +appointment_id, actor: String(req.user?.id || 'system') }).catch(() => {});

    // Перехід у noshow через канбан → те саме доменне подію, що й у schedule.js,
    // щоб автоматизація (задача адміну) спрацювала однаково з обох шляхів.
    if (newStatus === 'noshow' && appt.status !== 'noshow') {
      emit('appointment.noshow', { appointment_id: +appointment_id, client_id: appt.client_id },
        { entityType: 'appointment', entityId: +appointment_id, actor: String(req.user?.id || 'system') }).catch(() => {});
    }

    const triggered = await fireTriggers(appt, stageCode, 'enter');
    logAction({ user: req.user, action: 'pipeline.transition', entity: 'appointment', entity_id: +appointment_id, ip: req.ip, meta: { stage: stageCode } }).catch(()=>{});
    res.json({ ok: true, stage: stageCode, status: newStatus, log, triggers_fired: triggered });
  } catch (e) { await client.query('ROLLBACK').catch(()=>{}); console.error('[pipeline:transition]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message }); }
  finally { client.release(); }
});

// ── GET /api/pipeline/appointment/:id/history — історія стадій візита ──
router.get('/appointment/:id/history', async (req, res) => {
  try {
    const rows = await q(
      `SELECT l.*, st.name AS stage_name, st.color
         FROM visit_stage_log l
         LEFT JOIN visit_pipeline_stages st ON st.code = l.stage_code
        WHERE l.appointment_id=$1 ORDER BY l.entered_at`, [+req.params.id]);
    res.json({ appointment_id: +req.params.id, stages: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message }); }
});

// ── GET /api/pipeline/stages — конфіг стадій ──
router.get('/stages', async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM visit_pipeline_stages WHERE active=true ORDER BY position`);
    res.json({ items: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message }); }
});

// ── PUT /api/pipeline/stages/:code — оновити конфіг стадії (SLA/колір/назва) ──
router.put('/stages/:code', async (req, res) => {
  try {
    const allowed = ['name', 'position', 'color', 'sla_minutes', 'is_terminal', 'active'];
    const sets = [], vals = [];
    for (const k of allowed) if (k in (req.body || {})) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(req.params.code);
    const r = await q(`UPDATE visit_pipeline_stages SET ${sets.join(', ')}, updated_at=NOW() WHERE code=$${vals.length} RETURNING *`, vals);
    if (!r[0]) return res.status(404).json({ error: 'stage not found' });
    res.json({ ok: true, stage: r[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message }); }
});

// ── Тригери стадій ──────────────────────────────────────────────────
router.get('/triggers', async (req, res) => {
  try {
    const params = [], wh = [];
    if (req.query.stage_code) { params.push(req.query.stage_code); wh.push(`stage_code=$${params.length}`); }
    const rows = await q(`SELECT * FROM visit_stage_triggers ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} ORDER BY stage_code, id`, params);
    res.json({ items: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message }); }
});

router.post('/triggers', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.stage_code || !b.trigger_type) return res.status(400).json({ error: 'stage_code, trigger_type required' });
    const r = await q(
      `INSERT INTO visit_stage_triggers (stage_code, trigger_type, trigger_on, delay_minutes, config, conditions, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.stage_code, b.trigger_type, b.trigger_on || 'enter', b.delay_minutes || 0,
       JSON.stringify(b.config || {}), JSON.stringify(b.conditions || {}), b.active !== false]);
    res.json({ ok: true, trigger: r[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message }); }
});

router.put('/triggers/:id', async (req, res) => {
  try {
    const allowed = ['stage_code', 'trigger_type', 'trigger_on', 'delay_minutes', 'config', 'conditions', 'active'];
    const sets = [], vals = [];
    for (const k of allowed) if (k in (req.body || {})) {
      vals.push((k === 'config' || k === 'conditions') ? JSON.stringify(req.body[k]) : req.body[k]);
      sets.push(`${k}=$${vals.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(+req.params.id);
    const r = await q(`UPDATE visit_stage_triggers SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals);
    if (!r[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, trigger: r[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message }); }
});

router.delete('/triggers/:id', async (req, res) => {
  try {
    const r = await q(`DELETE FROM visit_stage_triggers WHERE id=$1 RETURNING id`, [+req.params.id]);
    if (!r[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message }); }
});

// ── GET /api/pipeline/durations — середній час у стадіях + bottleneck (з логу) ──
router.get('/durations', async (req, res) => {
  try {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')   ? req.query.to   : null;
    const params = [], wh = ['l.duration_seconds IS NOT NULL'];
    if (from) { params.push(from); wh.push(`l.entered_at >= $${params.length}::date`); }
    if (to)   { params.push(to);   wh.push(`l.entered_at < ($${params.length}::date + INTERVAL '1 day')`); }
    const rows = await q(
      `SELECT l.stage_code, st.name AS stage_name,
              COUNT(*)::int AS samples,
              ROUND(AVG(l.duration_seconds)/60.0, 1) AS avg_minutes,
              ROUND(MAX(l.duration_seconds)/60.0, 1) AS max_minutes,
              st.sla_minutes,
              COUNT(*) FILTER (WHERE st.sla_minutes IS NOT NULL AND l.duration_seconds > st.sla_minutes*60)::int AS sla_breaches
         FROM visit_stage_log l
         LEFT JOIN visit_pipeline_stages st ON st.code=l.stage_code
        WHERE ${wh.join(' AND ')}
        GROUP BY l.stage_code, st.name, st.sla_minutes, st.position
        ORDER BY st.position`, params);
    const bottleneck = rows.slice().sort((a, b) => (b.avg_minutes || 0) - (a.avg_minutes || 0))[0]?.stage_code || null;
    res.json({ stages: rows, bottleneck });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message }); }
});

module.exports = router;
