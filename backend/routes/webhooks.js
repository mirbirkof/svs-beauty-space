/* ═══════════════════════════════════════════════════════
   INT-03 — Исходящие вебхуки (Outgoing Webhooks)
   Подключается как /api/webhooks

   Что закрывает:
   - регистрация эндпоинтов-подписчиков на доменные события (INF-01 Event Bus);
   - доставка событий внешним системам POST-запросом с HMAC-SHA256 подписью;
   - журнал доставок (webhook_deliveries) + счётчик ошибок, авто-отключение;
   - фильтр по типам событий (events: ["appointment.completed"] или ["*"]);
   - тест-доставка (/:id/test), повторная отправка вручную.

   Права: integrations.read / integrations.write (миграция 090).
   Подписка на шину инициализируется один раз при загрузке модуля.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const { assertPublicHttpUrl } = require('../lib/ssrf-guard');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

const MAX_FAILURES = 15; // после стольких подряд — деактивация

// доставка одного события одному вебхуку (best-effort, логируется)
async function deliver(wh, eventType, payload, attempt = 1) {
  const body = JSON.stringify({ event: eventType, data: payload, ts: new Date().toISOString() });
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'svs-crm-webhook/1' };
  if (wh.secret) {
    headers['X-Webhook-Signature'] =
      'sha256=' + crypto.createHmac('sha256', wh.secret).update(body).digest('hex');
  }
  let statusCode = null, ok = false, error = null;
  try {
    // SSRF-guard (#18): резолвим хост в момент доставки — блок приватных/loopback/
    // cloud-metadata адресов и обход DNS-rebinding (резолв при создании недостаточен).
    await assertPublicHttpUrl(wh.url);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(wh.url, { method: 'POST', headers, body, signal: ctrl.signal, redirect: 'error' });
    clearTimeout(t);
    statusCode = resp.status;
    ok = resp.status >= 200 && resp.status < 300;
  } catch (e) { error = e.message; }

  try {
    await pool.query(
      `INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status_code, ok, error, attempt)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [wh.id, eventType, JSON.stringify(payload || {}), statusCode, ok, error, attempt]);
    if (ok) {
      await pool.query(`UPDATE webhooks SET failure_count=0, last_status=$2, last_delivered_at=now() WHERE id=$1`, [wh.id, statusCode]);
    } else {
      await pool.query(
        `UPDATE webhooks SET failure_count=failure_count+1, last_status=$2,
           active = CASE WHEN failure_count+1 >= $3 THEN false ELSE active END
         WHERE id=$1`, [wh.id, statusCode, MAX_FAILURES]);
    }
  } catch (_) { /* журнал best-effort */ }
  return { ok, statusCode, error };
}

// событие подходит вебхуку?
function matches(events, eventType) {
  if (!Array.isArray(events)) return false;
  return events.includes('*') || events.includes(eventType);
}

// ── Подписка на шину: один раз на процесс ──
let busHooked = false;
function hookBus() {
  if (busHooked) return;
  busHooked = true;
  let bus;
  try { bus = require('../lib/event-bus'); } catch (_) { return; }
  bus.on('*', async (evt) => {
    try {
      const type = evt?.event_type;
      if (!type) return;
      const hooks = await q(`SELECT * FROM webhooks WHERE active=true`);
      for (const wh of hooks) {
        if (matches(wh.events, type)) {
          deliver(wh, type, evt.payload ?? evt).catch(() => {});
        }
      }
    } catch (_) { /* never throw in bus handler */ }
  });
}
hookBus();

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'integrations.read' : 'integrations.write';
  return requirePerm(perm)(req, res, next);
});

// GET /api/webhooks — список
router.get('/', async (req, res) => {
  try {
    const rows = await q(`SELECT id,url,description,events,active,failure_count,last_status,last_delivered_at,created_at
                          FROM webhooks WHERE tenant_id=current_tenant_id() ORDER BY created_at DESC`);
    res.json({ rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/webhooks/:id/deliveries — журнал доставок
router.get('/:id/deliveries', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const rows = await q(`SELECT id,event_type,status_code,ok,error,attempt,created_at
                          FROM webhook_deliveries WHERE webhook_id=$1 ORDER BY created_at DESC LIMIT ${limit}`, [req.params.id]);
    res.json({ rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/webhooks — создать
router.post('/', async (req, res) => {
  try {
    const { url, description, events, secret, active } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'valid_url_required' });
    try { await assertPublicHttpUrl(url); } catch (e) { return res.status(400).json({ error: 'url_not_allowed', reason: e.message }); }
    const ev = Array.isArray(events) && events.length ? events.map(String) : ['*'];
    const row = (await q(
      `INSERT INTO webhooks (url, description, events, secret, active)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [url, description || null, JSON.stringify(ev), secret || null, active !== false]))[0];
    await logAction({ user: req.user, action: 'webhook.create', entity: 'webhooks', entity_id: row.id, ip: req.ip });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// PATCH /api/webhooks/:id — обновить
router.patch('/:id', async (req, res) => {
  try {
    if (req.body.url !== undefined) {
      try { await assertPublicHttpUrl(req.body.url); } catch (e) { return res.status(400).json({ error: 'url_not_allowed', reason: e.message }); }
    }
    const allowed = ['url', 'description', 'events', 'secret', 'active'];
    const sets = [], params = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        params.push(k === 'events' ? JSON.stringify((req.body[k] || []).map(String)) : req.body[k]);
        sets.push(`${k} = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    // повторная активация сбрасывает счётчик ошибок
    if (req.body.active === true) sets.push('failure_count = 0');
    params.push(req.params.id);
    const row = (await q(`UPDATE webhooks SET ${sets.join(', ')}, updated_at=now()
                          WHERE id=$${params.length} AND tenant_id=current_tenant_id() RETURNING *`, params))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/webhooks/:id/test — тестовая доставка
router.post('/:id/test', async (req, res) => {
  try {
    const wh = (await q(`SELECT * FROM webhooks WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!wh) return res.status(404).json({ error: 'not_found' });
    const result = await deliver(wh, 'webhook.test', { message: 'Тестова доставка з SVS CRM', at: new Date().toISOString() });
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// DELETE /api/webhooks/:id
router.delete('/:id', async (req, res) => {
  try {
    const row = (await q(`DELETE FROM webhooks WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    await logAction({ user: req.user, action: 'webhook.delete', entity: 'webhooks', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
