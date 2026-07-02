/* ═══════════════════════════════════════════════════════
   COM-05/06/07/08/09 — Омниканальный центр (Omnichannel)
   Подключается как /api/omni

   Что закрывает:
   - COM-08 единый inbox оператора: список диалогов, лента сообщений,
     назначение, статусы (open/pending/closed), счётчик непрочитанных;
   - COM-05 WhatsApp / COM-06 Viber / COM-07 Messenger / COM-09 телефония:
     реестр каналов omni_channels (конфиг провайдера), приём входящих через
     /inbound/:channel (вебхук провайдера) и отправку исходящих;
   - привязка диалога к клиенту CRM, история переписки в omni_messages.

   Отправка через провайдера выполняется адаптером channel-adapters:
   если ключи канала не настроены — сообщение сохраняется со статусом
   'pending' и отдаётся флаг needs_config (модуль работает, ждёт ключей).

   Права: omnichannel.read / omnichannel.write (миграция 098).
   /inbound/* — без авторизации (вызывает провайдер), защищён verify-token.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

const CHANNELS = ['whatsapp', 'viber', 'messenger', 'telegram', 'sms', 'call', 'instagram'];

// upsert диалога по (channel, external_id) и добавление сообщения
async function ingest({ channel, external_id, contact_name, contact_phone, body, direction, attachments, status, meta }) {
  const conv = (await q(
    `INSERT INTO omni_conversations (channel, external_id, contact_name, contact_phone, last_message, last_message_at, unread)
     VALUES ($1,$2,$3,$4,$5,now(), CASE WHEN $6='in' THEN 1 ELSE 0 END)
     ON CONFLICT (tenant_id, channel, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET last_message=EXCLUDED.last_message, last_message_at=now(),
       contact_name=COALESCE(omni_conversations.contact_name, EXCLUDED.contact_name),
       contact_phone=COALESCE(omni_conversations.contact_phone, EXCLUDED.contact_phone),
       unread = omni_conversations.unread + CASE WHEN $6='in' THEN 1 ELSE 0 END,
       status = CASE WHEN omni_conversations.status='closed' THEN 'open' ELSE omni_conversations.status END
     RETURNING *`,
    [channel, external_id || null, contact_name || null, contact_phone || null, (body || '').slice(0, 500), direction]))[0];
  const msg = (await q(
    `INSERT INTO omni_messages (conversation_id, direction, channel, body, attachments, status, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [conv.id, direction, channel, body || null,
     JSON.stringify(Array.isArray(attachments) ? attachments : []), status || 'sent',
     meta ? JSON.stringify(meta) : null]))[0];
  return { conv, msg };
}

/* ── ВХОДЯЩИЕ ОТ ПРОВАЙДЕРА (без авторизации) ── */
// POST /api/omni/inbound/:channel  — нормализованный вебхук провайдера
router.post('/inbound/:channel', async (req, res) => {
  try {
    const channel = String(req.params.channel);
    if (!CHANNELS.includes(channel)) return res.status(400).json({ error: 'unknown_channel' });
    const b = req.body || {};
    // verify-token из конфига канала (если задан)
    const ch = (await q(`SELECT config FROM omni_channels WHERE channel=$1 AND tenant_id=current_tenant_id() LIMIT 1`, [channel]))[0];
    const expected = ch?.config?.verify_token;
    if (expected && req.get('x-verify-token') !== expected) return res.status(401).json({ error: 'bad_verify_token' });

    const { conv, msg } = await ingest({
      channel, external_id: b.from || b.external_id, contact_name: b.name,
      contact_phone: b.phone, body: b.text || b.body, direction: 'in',
      attachments: b.attachments, meta: b.meta,
    });
    // публикуем событие для триггеров/уведомлений
    try { require('../lib/event-bus').emit('omni.message_in', { conversation_id: conv.id, channel, body: msg.body }, { entityType: 'omni_conversation', entityId: conv.id }); } catch (_) {}
    res.json({ ok: true, conversation_id: conv.id, message_id: msg.id });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ── АВТОРИЗОВАННЫЕ ── */
router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'omnichannel.read' : 'omnichannel.write';
  return requirePerm(perm)(req, res, next);
});

// GET /api/omni/channels — реестр каналов (без секретов)
router.get('/channels', async (req, res) => {
  try {
    const rows = await q(`SELECT id, channel, enabled,
        ((config ? 'token') OR (config ? 'api_key')) AS configured, updated_at
      FROM omni_channels WHERE tenant_id=current_tenant_id() ORDER BY channel`);
    res.json({ rows, available: CHANNELS });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// PUT /api/omni/channels/:channel — настроить канал
router.put('/channels/:channel', async (req, res) => {
  try {
    const channel = String(req.params.channel);
    if (!CHANNELS.includes(channel)) return res.status(400).json({ error: 'unknown_channel' });
    const b = req.body || {};
    const row = (await q(
      `INSERT INTO omni_channels (channel, enabled, config) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, channel) DO UPDATE SET
         enabled=EXCLUDED.enabled, config=EXCLUDED.config, updated_at=now()
       RETURNING id, channel, enabled`,
      [channel, b.enabled !== false, JSON.stringify(b.config || {})]))[0];
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/omni/conversations — inbox
router.get('/conversations', async (req, res) => {
  try {
    const params = [];
    let where = 'c.tenant_id=current_tenant_id()';
    if (req.query.status) { params.push(req.query.status); where += ` AND c.status=$${params.length}`; }
    if (req.query.channel) { params.push(req.query.channel); where += ` AND c.channel=$${params.length}`; }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const rows = await q(
      `SELECT c.*, cl.name AS client_name
       FROM omni_conversations c LEFT JOIN clients cl ON cl.id=c.client_id
       WHERE ${where} ORDER BY c.last_message_at DESC NULLS LAST LIMIT ${limit}`, params);
    res.json({ rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/omni/conversations/:id/messages — лента
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const rows = await q(
      `SELECT * FROM omni_messages WHERE conversation_id=$1 AND tenant_id=current_tenant_id() ORDER BY created_at`,
      [req.params.id]);
    // отметить прочитанным
    await pool.query(`UPDATE omni_conversations SET unread=0 WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    res.json({ rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/omni/conversations/:id/send — отправить ответ оператора
router.post('/conversations/:id/send', async (req, res) => {
  try {
    const conv = (await q(`SELECT * FROM omni_conversations WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!conv) return res.status(404).json({ error: 'not_found' });
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'body_required' });

    // канал настроен?
    const ch = (await q(`SELECT enabled, config FROM omni_channels WHERE channel=$1 AND tenant_id=current_tenant_id()`, [conv.channel]))[0];
    const configured = ch && ch.enabled && ch.config && (ch.config.token || ch.config.api_key);
    const status = configured ? 'sent' : 'pending'; // без ключей — копим, отправит адаптер позже

    const msg = (await q(
      `INSERT INTO omni_messages (conversation_id, direction, channel, body, status)
       VALUES ($1,'out',$2,$3,$4) RETURNING *`,
      [conv.id, conv.channel, body, status]))[0];
    // фіксуємо час першої відповіді оператора (для SLA) — лише якщо ще не було
    await pool.query(`UPDATE omni_conversations SET last_message=$2, last_message_at=now(),
        first_response_at=COALESCE(first_response_at, now()) WHERE id=$1`,
      [conv.id, body.slice(0, 500)]);
    res.json({ ok: true, message: msg, needs_config: !configured });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// PATCH /api/omni/conversations/:id — статус/назначение/привязка клиента
router.patch('/conversations/:id', async (req, res) => {
  try {
    const allowed = ['status', 'assigned_to', 'client_id', 'contact_name', 'tags', 'priority', 'sla_due_at'];
    const sets = [], params = [];
    for (const k of allowed) if (req.body[k] !== undefined) { params.push(req.body[k]); sets.push(`${k}=$${params.length}`); }
    if (req.body.status === 'closed') sets.push(`closed_at=now()`);
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    params.push(req.params.id);
    const row = (await q(`UPDATE omni_conversations SET ${sets.join(', ')} WHERE id=$${params.length} AND tenant_id=current_tenant_id() RETURNING *`, params))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ── INSTAGRAM CONNECT (per-salon) ──
   POST /api/omni/instagram/connect  { page_token, auto_agent?, auto_book?, agent_id? }
   Валидирует Page Access Token через Meta, достаёт ig_user_id и включает канал.
   GET  /api/omni/instagram/status   — текущее состояние подключения (без секретов). */
const igMeta = require('../lib/channels/instagram-meta');

router.post('/instagram/connect', async (req, res) => {
  try {
    const b = req.body || {};
    const pageToken = String(b.page_token || '').trim();
    if (!pageToken) return res.status(400).json({ error: 'page_token_required' });

    const probe = await igMeta.probeAccount(pageToken);
    if (!probe.ok || !probe.id) return res.status(400).json({ error: 'token_invalid', detail: probe.error || 'no ig account' });

    const config = {
      ig_user_id: String(probe.id),
      username: probe.username || null,
      page_id: b.page_id || null,
      page_token: pageToken,
      auto_agent: b.auto_agent !== false,   // по умолчанию агент отвечает
      auto_book: !!b.auto_book,             // авто-запись процедур — явно включить
      agent_id: b.agent_id || null,
    };
    const row = (await q(
      `INSERT INTO omni_channels (channel, enabled, config) VALUES ('instagram', true, $1)
       ON CONFLICT (tenant_id, channel) DO UPDATE SET enabled=true, config=EXCLUDED.config, updated_at=now()
       RETURNING id, channel, enabled`,
      [JSON.stringify(config)]))[0];
    res.json({ ok: true, channel: row, ig_username: probe.username, ig_user_id: probe.id });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/instagram/status', async (req, res) => {
  try {
    const ch = (await q(`SELECT enabled, config, updated_at FROM omni_channels WHERE channel='instagram' AND tenant_id=current_tenant_id()`))[0];
    if (!ch) return res.json({ connected: false });
    const c = ch.config || {};
    res.json({
      connected: !!c.ig_user_id, enabled: ch.enabled,
      ig_user_id: c.ig_user_id || null, ig_username: c.username || null,
      auto_agent: !!c.auto_agent, auto_book: !!c.auto_book, agent_id: c.agent_id || null,
      has_token: !!c.page_token, updated_at: ch.updated_at,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// PATCH /api/omni/instagram/settings — переключатели авто-агента/авто-записи
router.patch('/instagram/settings', async (req, res) => {
  try {
    const b = req.body || {};
    const ch = (await q(`SELECT config FROM omni_channels WHERE channel='instagram' AND tenant_id=current_tenant_id()`))[0];
    if (!ch) return res.status(404).json({ error: 'not_connected' });
    const c = ch.config || {};
    if (b.auto_agent !== undefined) c.auto_agent = !!b.auto_agent;
    if (b.auto_book !== undefined) c.auto_book = !!b.auto_book;
    if (b.agent_id !== undefined) c.agent_id = b.agent_id || null;
    if (b.enabled !== undefined) {
      await q(`UPDATE omni_channels SET enabled=$1, updated_at=now() WHERE channel='instagram' AND tenant_id=current_tenant_id()`, [!!b.enabled]);
    }
    await q(`UPDATE omni_channels SET config=$1, updated_at=now() WHERE channel='instagram' AND tenant_id=current_tenant_id()`, [JSON.stringify(c)]);
    res.json({ ok: true, auto_agent: !!c.auto_agent, auto_book: !!c.auto_book, agent_id: c.agent_id || null });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ── COM-08 дотягування: швидкі відповіді, статус оператора, transfer, CSAT ── */

// GET /api/omni/quick-replies — швидкі відповіді
router.get('/quick-replies', async (req, res) => {
  try {
    const params = [], wh = [`tenant_id=current_tenant_id()`, `active=true`];
    if (req.query.channel) { params.push(req.query.channel); wh.push(`(channel IS NULL OR channel=$${params.length})`); }
    const rows = await q(`SELECT * FROM omni_quick_replies WHERE ${wh.join(' AND ')} ORDER BY category NULLS LAST, shortcut`, params);
    res.json({ rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/omni/quick-replies — створити
router.post('/quick-replies', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.shortcut || !b.body) return res.status(400).json({ error: 'shortcut and body required' });
    const row = (await q(
      `INSERT INTO omni_quick_replies (shortcut, title, body, category, channel) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [b.shortcut, b.title || null, b.body, b.category || null, b.channel || null]))[0];
    res.json({ ok: true, quick_reply: row });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// PATCH /api/omni/quick-replies/:id
router.patch('/quick-replies/:id', async (req, res) => {
  try {
    const allowed = ['shortcut', 'title', 'body', 'category', 'channel', 'active'];
    const sets = [], params = [];
    for (const k of allowed) if (req.body[k] !== undefined) { params.push(req.body[k]); sets.push(`${k}=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    params.push(req.params.id);
    const row = (await q(`UPDATE omni_quick_replies SET ${sets.join(', ')}, updated_at=now() WHERE id=$${params.length} AND tenant_id=current_tenant_id() RETURNING *`, params))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, quick_reply: row });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// DELETE /api/omni/quick-replies/:id
router.delete('/quick-replies/:id', async (req, res) => {
  try {
    const row = (await q(`DELETE FROM omni_quick_replies WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/omni/operators — статуси операторів
router.get('/operators', async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM omni_operator_status WHERE tenant_id=current_tenant_id() ORDER BY status, operator_name`);
    res.json({ rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// PUT /api/omni/operators/status — встановити свій статус
router.put('/operators/status', async (req, res) => {
  try {
    const b = req.body || {};
    const opId = b.operator_id || req.user?.id;
    if (!opId) return res.status(400).json({ error: 'operator_id required' });
    const status = ['online', 'away', 'offline'].includes(b.status) ? b.status : 'offline';
    const row = (await q(
      `INSERT INTO omni_operator_status (operator_id, operator_name, status) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, operator_id) DO UPDATE SET status=EXCLUDED.status,
         operator_name=COALESCE(EXCLUDED.operator_name, omni_operator_status.operator_name), updated_at=now()
       RETURNING *`,
      [opId, b.operator_name || req.user?.display_name || null, status]))[0];
    res.json({ ok: true, operator: row });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/omni/conversations/:id/transfer — передати діалог іншому оператору
router.post('/conversations/:id/transfer', async (req, res) => {
  try {
    const to = req.body?.to_operator_id;
    if (!to) return res.status(400).json({ error: 'to_operator_id required' });
    const row = (await q(
      `UPDATE omni_conversations SET assigned_to=$1, status=CASE WHEN status='closed' THEN 'open' ELSE status END
       WHERE id=$2 AND tenant_id=current_tenant_id() RETURNING *`, [to, req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    // системне повідомлення в стрічку
    await q(`INSERT INTO omni_messages (conversation_id, direction, channel, body, status, meta)
             VALUES ($1,'out',$2,$3,'sent',$4)`,
      [req.params.id, row.channel, `↪ Діалог передано оператору #${to}`, JSON.stringify({ system: true, transfer_to: to })]).catch(()=>{});
    res.json({ ok: true, conversation: row });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/omni/conversations/:id/csat — зберегти оцінку клієнта (CSAT)
router.post('/conversations/:id/csat', async (req, res) => {
  try {
    const score = parseInt(req.body?.score, 10);
    if (!(score >= 1 && score <= 5)) return res.status(400).json({ error: 'score 1..5 required' });
    const row = (await q(
      `UPDATE omni_conversations SET csat_score=$1, csat_comment=$2 WHERE id=$3 AND tenant_id=current_tenant_id() RETURNING *`,
      [score, req.body?.comment || null, req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, conversation: row });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/omni/sla — порушення SLA + середній CSAT
router.get('/sla', async (req, res) => {
  try {
    const breaches = await q(
      `SELECT id, channel, contact_name, status, sla_due_at, first_response_at, last_message_at
         FROM omni_conversations
        WHERE tenant_id=current_tenant_id() AND status<>'closed'
          AND sla_due_at IS NOT NULL AND first_response_at IS NULL AND sla_due_at < now()
        ORDER BY sla_due_at LIMIT 100`);
    const csat = (await q(
      `SELECT ROUND(AVG(csat_score)::numeric,2) AS avg_csat, COUNT(*)::int AS responses
         FROM omni_conversations WHERE tenant_id=current_tenant_id() AND csat_score IS NOT NULL`))[0];
    res.json({ sla_breaches: breaches, breach_count: breaches.length, avg_csat: Number(csat?.avg_csat || 0), csat_responses: csat?.responses || 0 });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
