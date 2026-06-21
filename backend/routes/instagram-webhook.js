/* ═══════════════════════════════════════════════════════
   COM-10 — Instagram вебхук платформы (Meta Graph API)

   Один публичный URL на всю платформу. Meta шлёт сюда DM и комментарии
   ВСЕХ подключённых салонов. Маршрутизация к салону — по ig_user_id.

   GET  /api/instagram/webhook   — verify (hub.challenge) при регистрации
   POST /api/instagram/webhook   — события: проверка подписи → разбор →
        поиск салона по ig_user_id → запись в инбокс (omni_*) → если у
        канала включён auto_agent: AI-агент отвечает (и может записать
        процедуру через инструмент book_appointment) и шлёт ответ в IG.

   Без авторизации (вызывает Meta). Защита — verify_token + подпись HMAC.
   Монтируется ДО tenantMiddleware: тенант определяется не по запросу,
   а по содержимому payload (ig_user_id → omni_channels).
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool, withTx } = require('../db-pg');
const { runAs } = require('../lib/tenant');
const ig = require('../lib/channels/instagram-meta');

const pool = getPool();

// ── GET: верификация вебхука Meta ──
router.get('/webhook', (req, res) => {
  const expected = process.env.META_VERIFY_TOKEN || process.env.INSTAGRAM_VERIFY_TOKEN;
  const r = ig.verifyChallenge(req.query, expected);
  if (r.ok) return res.status(200).send(r.challenge);
  return res.sendStatus(403);
});

// ── POST: входящие события ──
router.post('/webhook', async (req, res) => {
  // 1) подпись
  const sig = req.get('x-hub-signature-256');
  const check = ig.verifySignature(req.rawBody, sig, process.env.META_APP_SECRET);
  if (!check.ok) return res.sendStatus(401);

  // Безопасность по умолчанию: если подпись пропущена (META_APP_SECRET не задан),
  // в продакшене НЕ обрабатываем — иначе открытый вебхук позволил бы вброс
  // фейковых входящих по известному ig_user_id. Отвечаем 200, чтобы Meta не ретраил.
  if (check.skipped && process.env.NODE_ENV === 'production') {
    console.warn('[ig] webhook event skipped: META_APP_SECRET not configured');
    return res.sendStatus(200);
  }

  // Meta требует быстрый 200, иначе ретраит. Обрабатываем асинхронно.
  res.sendStatus(200);

  let events = [];
  try { events = ig.parseWebhook(req.body || {}); } catch (e) { console.error('[ig] parse', e.message); return; }

  for (const ev of events) {
    if (ev.is_echo) continue;                    // наше же исходящее
    if (!ev.text && !ev.attachments?.length) continue;
    try { await handleEvent(ev); }
    catch (e) { console.error('[ig] handle', ev.ig_user_id, e.message); }
  }
});

// Поиск салона по ig_user_id (кросс-тенантно: plain pool без app.tenant_id видит все строки)
async function resolveChannel(igUserId) {
  const r = await pool.query(
    `SELECT tenant_id, config, enabled FROM omni_channels
      WHERE channel='instagram' AND config->>'ig_user_id'=$1 LIMIT 1`, [String(igUserId)]);
  return r.rows[0] || null;
}

async function handleEvent(ev) {
  const ch = await resolveChannel(ev.ig_user_id);
  if (!ch || ch.enabled === false) return;        // салон не подключён / выключен
  const cfg = ch.config || {};
  const tenantId = ch.tenant_id;

  // 1) записать входящее в инбокс под корректным тенантом
  const conv = await runAs(tenantId, () => withTx(async (client) => {
    const c = (await client.query(
      `INSERT INTO omni_conversations (channel, external_id, contact_name, last_message, last_message_at, unread)
       VALUES ('instagram',$1,$2,$3,now(),1)
       ON CONFLICT (tenant_id, channel, external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET last_message=EXCLUDED.last_message, last_message_at=now(),
         contact_name=COALESCE(omni_conversations.contact_name, EXCLUDED.contact_name),
         unread=omni_conversations.unread+1,
         status=CASE WHEN omni_conversations.status='closed' THEN 'open' ELSE omni_conversations.status END
       RETURNING *`,
      [ev.external_id || null, ev.name || null, (ev.text || '[вкладення]').slice(0, 500)]
    )).rows[0];
    await client.query(
      `INSERT INTO omni_messages (conversation_id, direction, channel, body, attachments, status, meta)
       VALUES ($1,'in','instagram',$2,$3,'received',$4)`,
      [c.id, ev.text || null, JSON.stringify(ev.attachments || []),
       JSON.stringify({ ig_type: ev.type, comment_id: ev.comment_id, mid: ev.message_mid })]
    );
    return c;
  }));

  // событие для триггеров/уведомлений
  try { require('../lib/event-bus').emit('omni.message_in', { conversation_id: conv.id, channel: 'instagram', body: ev.text }, { entityType: 'omni_conversation', entityId: conv.id }); } catch (_) {}

  // 2) авто-ответ AI-агента (если включён)
  if (!cfg.auto_agent) return;
  if (!ev.text) return;                            // на чистые вложения агент не отвечает

  const reply = await runAs(tenantId, () => generateAgentReply({ cfg, text: ev.text, conv }));
  if (!reply) return;

  // 3) отправить ответ обратно в Instagram
  const out = ev.type === 'comment' && ev.comment_id
    ? await ig.replyComment({ comment_id: ev.comment_id, page_token: cfg.page_token, text: reply })
    : await ig.sendDirect({ ig_user_id: ev.ig_user_id, page_token: cfg.page_token, recipient_id: ev.external_id, text: reply });

  // 4) залогировать исходящее
  await runAs(tenantId, () => withTx(async (client) => {
    await client.query(
      `INSERT INTO omni_messages (conversation_id, direction, channel, body, status, meta)
       VALUES ($1,'out','instagram',$2,$3,$4)`,
      [conv.id, reply, out.ok ? 'sent' : 'failed', JSON.stringify({ by: 'ai_agent', error: out.error || null })]);
    await client.query(`UPDATE omni_conversations SET last_message=$2, last_message_at=now() WHERE id=$1`,
      [conv.id, reply.slice(0, 500)]);
  })).catch(e => console.error('[ig] log out', e.message));
}

// Выбор и запуск AI-агента салона. Приоритет: указанный agent_id → активный агент.
// Агент умеет book_appointment (запись процедуры) при включённом auto_book.
async function generateAgentReply({ cfg, text, conv }) {
  try {
    const { runAgent } = require('./ai-agents');
    if (typeof runAgent !== 'function') return null;
    let agent;
    if (cfg.agent_id) {
      agent = (await pool.query(`SELECT * FROM ai_agents WHERE id=$1 AND status='active'`, [cfg.agent_id])).rows[0];
    }
    if (!agent) {
      agent = (await pool.query(`SELECT * FROM ai_agents WHERE status='active' ORDER BY updated_at DESC LIMIT 1`)).rows[0];
    }
    if (!agent) return null;
    const r = await runAgent(agent, {
      message: text,
      client_id: conv.client_id || null,
      triggered_by: 'instagram',
      // auto_book=true → разрешаем агенту самому записать (book_appointment is_destructive)
      confirm_destructive: !!cfg.auto_book,
    });
    return r && r.final_response ? String(r.final_response).slice(0, 1000) : null;
  } catch (e) {
    console.error('[ig] agent', e.message);
    return null;
  }
}

module.exports = router;
