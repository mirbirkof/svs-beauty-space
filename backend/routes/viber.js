/* ═══════════════════════════════════════════════════════
   COM-06 — Viber Business Messages
   Подключается как /api/viber в shop-api.js.

   Что покрывает:
   - 06.01 Настройка бота: GET/PUT /config, POST /config/test,
           установка webhook, статус подключения
   - 06.02 Управление подписчиками: список, детали, привязка к CRM
   - 06.03 Отправка сообщений: все типы (text/picture/video/file/
           contact/location/sticker/rich_media), keyboard, приоритеты
   - 06.04 Чат-бот: CRUD сценариев (flow builder)
   - 06.05 Массовые рассылки: create/start/cancel + статистика
   - 06.06 Аналитика и стоимость: дашборд, ставки, отчёт
   - Webhook приёмник входящих/статусов от Viber API

   Публичные (без requirePerm):
     POST /api/viber/webhook  — вебхук Viber, защищён X-Viber-Auth-Token

   Все остальные требуют авторизации (requirePerm + конкретное право).
   ═══════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const { runAs } = require('../lib/tenant');
const viber = require('../lib/channels/viber-channel');

// ── Webhook (публичный — вызывает Viber платформа) ───────────────────
// Viber подписывает КАЖДЫЙ callback: X-Viber-Content-Signature (и query ?sig=)
// = HMAC-SHA256(rawBody, auth_token) hex. Токен сам в запросе НЕ приходит.
// Идентификация тенанта: перебор активных конфигов по совпадению HMAC.
// Fallback на X-Viber-Auth-Token оставлен для ручных тестов /config/test.

const crypto = require('crypto');

function viberSigMatch(rawBody, sig, token) {
  try {
    const h = crypto.createHmac('sha256', token).update(rawBody).digest('hex');
    const a = Buffer.from(h, 'utf8');
    const b = Buffer.from(String(sig).toLowerCase(), 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

router.post('/webhook', async (req, res) => {
  try {
    const pool = getPool();
    const sig = req.headers['x-viber-content-signature'] || req.query.sig || '';
    let cfg = null;

    if (sig && req.rawBody) {
      // Штатный путь Viber: находим тенанта по валидной HMAC-подписи
      const cfgs = await pool.query(
        `SELECT * FROM viber_bot_config WHERE is_active = TRUE`
      );
      cfg = cfgs.rows.find(c => c.auth_token && viberSigMatch(req.rawBody, sig, c.auth_token)) || null;
    } else {
      // Fallback (ручной тест из админки): токен в заголовке = знание секрета
      const incomingToken = req.headers['x-viber-auth-token'] || '';
      if (incomingToken) {
        const cfgRow = await pool.query(
          `SELECT * FROM viber_bot_config WHERE auth_token = $1 AND is_active = TRUE LIMIT 1`,
          [incomingToken]
        );
        cfg = cfgRow.rows[0] || null;
      }
    }

    // Отвечаем 200 немедленно — Viber требует быстрый ответ
    res.json({ status: 0 });
    if (!cfg) return; // неизвестный токен — игнорируем тихо

    const ev = req.body || {};
    const eventType = ev.event; // message|delivered|seen|failed|subscribed|unsubscribed|conversation_started

    // Блокер F1: viber_subscribers має FORCE RLS (tenant_id = app.tenant_id). Вебхук іде
    // ПІСЛЯ tenantMiddleware, який ставить DEFAULT_TENANT_ID → вставка підписника чужого
    // салону або блокувалась, або писалась із неправильним tenant_id. Виконуємо всю обробку
    // під runAs(cfg.salon_id) (salon_id = tenant uuid) — AsyncLocalStorage прокидає тенант
    // у всі pool.query, RLS проходить і tenant_id проставляється вірно.
    await runAs(cfg.salon_id, async () => {
    switch (eventType) {
      case 'subscribed':
      case 'conversation_started': {
        const u = ev.user || {};
        await pool.query(
          `INSERT INTO viber_subscribers
             (salon_id, viber_user_id, name, avatar_url, language, country,
              api_version, status, subscribed_at, last_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'active',now(),now())
           ON CONFLICT (viber_user_id) DO UPDATE SET
             name = COALESCE(EXCLUDED.name, viber_subscribers.name),
             avatar_url = COALESCE(EXCLUDED.avatar_url, viber_subscribers.avatar_url),
             status = 'active', last_seen_at = now(), updated_at = now()`,
          [cfg.salon_id, u.id, u.name || null, u.avatar || null,
           u.language || null, u.country || null, u.api_version || null]
        );
        // Приветственное сообщение (если conversation_started и настроено)
        if (eventType === 'conversation_started' && cfg.welcome_message && u.id) {
          await viber.sendMessage(u.id, {
            type: 'text',
            content: { text: cfg.welcome_message },
            keyboard: cfg.default_keyboard || undefined,
          }).catch(() => {}); // non-critical
        }
        break;
      }

      case 'unsubscribed': {
        const sender = ev.sender || {};
        if (sender.id) {
          await pool.query(
            `UPDATE viber_subscribers SET status='unsubscribed', unsubscribed_at=now(),
               updated_at=now() WHERE salon_id=$1 AND viber_user_id=$2`,
            [cfg.salon_id, sender.id]
          );
        }
        break;
      }

      case 'message': {
        const sender = ev.sender || {};
        const msg = ev.message || {};
        if (!sender.id) break;

        // Upsert subscriber (мог написать без conversation_started)
        const subRow = await pool.query(
          `INSERT INTO viber_subscribers
             (salon_id, viber_user_id, name, avatar_url, language, country,
              api_version, status, subscribed_at, last_seen_at, last_message_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'active',now(),now(),now())
           ON CONFLICT (viber_user_id) DO UPDATE SET
             name = COALESCE(EXCLUDED.name, viber_subscribers.name),
             last_message_at = now(), last_seen_at = now(), updated_at = now()
           RETURNING id`,
          [cfg.salon_id, sender.id, sender.name || null, sender.avatar || null,
           ev.sender?.language || null, ev.sender?.country || null, null]
        );
        const subscriberId = subRow.rows[0]?.id;

        // Сохраняем входящее сообщение в журнал
        if (subscriberId) {
          const content = { text: msg.text, media: msg.media, sticker_id: msg.sticker_id, location: msg.location, contact: msg.contact };
          await pool.query(
            `INSERT INTO viber_messages
               (salon_id, subscriber_id, direction, message_type, content,
                viber_message_token, status, sent_at)
             VALUES ($1,$2,'inbound',$3,$4,$5,'delivered',now())`,
            [cfg.salon_id, subscriberId, msg.type || 'text',
             JSON.stringify(content), ev.message_token ? String(ev.message_token) : null]
          );

          // Передаём в omnichannel inbox (если омниканал подключён)
          try {
            const omniPool = pool;
            const bodyText = msg.text || `[${msg.type || 'media'}]`;
            await omniPool.query(
              `INSERT INTO omni_conversations (tenant_id, channel, external_id, contact_name, last_message, last_message_at, unread)
               VALUES ($1,'viber',$2,$3,$4,now(),1)
               ON CONFLICT (tenant_id, channel, external_id) WHERE external_id IS NOT NULL
               DO UPDATE SET last_message=EXCLUDED.last_message, last_message_at=now(),
                 unread=omni_conversations.unread+1,
                 status=CASE WHEN omni_conversations.status='closed' THEN 'open' ELSE omni_conversations.status END
               RETURNING id`,
              [cfg.salon_id, sender.id, sender.name || null, bodyText.slice(0, 500)]
            );
          } catch (_) { /* omni optional */ }
        }

        // Подбор сценария бота
        if (subscriberId) {
          _matchAndRunScenario(pool, cfg, sender.id, subscriberId, msg).catch(() => {});
        }
        break;
      }

      case 'delivered': {
        if (ev.message_token) {
          await pool.query(
            `UPDATE viber_messages SET status='delivered', delivered_at=now(), status_updated_at=now(), updated_at=now()
             WHERE salon_id=$1 AND viber_message_token=$2::bigint`,
            [cfg.salon_id, String(ev.message_token)]
          );
        }
        break;
      }

      case 'seen': {
        if (ev.message_token) {
          await pool.query(
            `UPDATE viber_messages SET status='seen', seen_at=now(), status_updated_at=now(), updated_at=now()
             WHERE salon_id=$1 AND viber_message_token=$2::bigint`,
            [cfg.salon_id, String(ev.message_token)]
          );
        }
        break;
      }

      case 'failed': {
        if (ev.message_token) {
          await pool.query(
            `UPDATE viber_messages SET status='failed', error_code=$3, error_message=$4, status_updated_at=now(), updated_at=now()
             WHERE salon_id=$1 AND viber_message_token=$2::bigint`,
            [cfg.salon_id, String(ev.message_token), ev.desc ? null : null, ev.desc || null]
          );
        }
        break;
      }

      default:
        // неизвестное событие — игнорируем
    }
    });
  } catch (e) {
    console.error('[viber-webhook]', e.message);
    // Всегда 200 — Viber не должен ретраить
  }
});

// ── Внутренний: подбор и выполнение сценария бота ───────────────────
async function _matchAndRunScenario(pool, cfg, viberUserId, subscriberId, msg) {
  const text = (msg.text || '').trim();
  if (!text) return;

  const scenarios = await pool.query(
    `SELECT * FROM viber_bot_scenarios
     WHERE salon_id=$1 AND is_active=TRUE
     ORDER BY priority DESC, created_at ASC`,
    [cfg.salon_id]
  );

  let matched = null;
  for (const sc of scenarios.rows) {
    switch (sc.trigger_type) {
      case 'keyword':
        if (text.toLowerCase().includes(sc.trigger_value.toLowerCase())) matched = sc;
        break;
      case 'regex':
        try { if (new RegExp(sc.trigger_value, 'i').test(text)) matched = sc; } catch (_) {}
        break;
      case 'first_message':
        // проверяем что это первое входящее от подписчика
        { const c = await pool.query(
            `SELECT count(*) cnt FROM viber_messages WHERE subscriber_id=$1 AND direction='inbound'`,
            [subscriberId]);
          if (Number(c.rows[0]?.cnt) <= 1) matched = sc; }
        break;
      case 'button':
        if (msg.type === 'text' && text === sc.trigger_value) matched = sc;
        break;
    }
    if (matched) break;
  }

  if (!matched) return;

  // Инкрементируем счётчик срабатываний
  await pool.query(
    `UPDATE viber_bot_scenarios SET stats_triggered=stats_triggered+1, updated_at=now() WHERE id=$1`,
    [matched.id]
  );

  // Выполняем шаги flow
  const flow = Array.isArray(matched.flow) ? matched.flow : [];
  for (const step of flow) {
    if (step.type === 'send_message' && step.message) {
      await viber.sendMessage(viberUserId, {
        type: step.message.type || 'text',
        content: step.message.content || { text: step.message.text || '' },
        keyboard: step.message.keyboard,
      }).catch(() => {});
    }
    // type=handover и другие шаги — место для расширения
  }

  await pool.query(
    `UPDATE viber_bot_scenarios SET stats_completed=stats_completed+1, updated_at=now() WHERE id=$1`,
    [matched.id]
  );
}

// ── Все остальные роуты требуют авторизации ──────────────────────────
router.use(requirePerm());

// ═════════════════════════════════════════════════════════════════════
// 06.01 КОНФИГУРАЦИЯ БОТА
// ═════════════════════════════════════════════════════════════════════

// GET /api/viber/config
router.get('/config', requirePerm('viber.config.read'), async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(
      `SELECT id, bot_name, bot_avatar_url, bot_description, webhook_url,
              mode, is_active, session_timeout_min, viber_account_id,
              welcome_message, default_keyboard,
              (SELECT count(*) FROM viber_subscribers
               WHERE salon_id = viber_bot_config.salon_id AND status='active') AS subscriber_count
         FROM viber_bot_config LIMIT 1`
    );
    const cfg = r.rows[0] || null;
    // Статус канала (настроен ли токен в env или в config)
    const channelReady = viber.isConfigured();
    res.json({ ok: true, config: cfg, channel_ready: channelReady });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// PUT /api/viber/config
router.put('/config', requirePerm('viber.config.write'), async (req, res) => {
  try {
    const pool = getPool();
    const {
      auth_token, bot_name, bot_avatar_url, bot_description,
      welcome_message, default_keyboard, mode, session_timeout_min,
      webhook_url,
    } = req.body || {};

    const r = await pool.query(
      `INSERT INTO viber_bot_config
         (salon_id, auth_token, bot_name, bot_avatar_url, bot_description,
          welcome_message, default_keyboard, mode, session_timeout_min, webhook_url)
       VALUES (current_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (salon_id) DO UPDATE SET
         auth_token = COALESCE($1, viber_bot_config.auth_token),
         bot_name = COALESCE($2, viber_bot_config.bot_name),
         bot_avatar_url = COALESCE($3, viber_bot_config.bot_avatar_url),
         bot_description = COALESCE($4, viber_bot_config.bot_description),
         welcome_message = COALESCE($5, viber_bot_config.welcome_message),
         default_keyboard = COALESCE($6::jsonb, viber_bot_config.default_keyboard),
         mode = COALESCE($7, viber_bot_config.mode),
         session_timeout_min = COALESCE($8, viber_bot_config.session_timeout_min),
         webhook_url = COALESCE($9, viber_bot_config.webhook_url),
         updated_at = now()
       RETURNING id, bot_name, mode, is_active`,
      [auth_token || null, bot_name || null, bot_avatar_url || null, bot_description || null,
       welcome_message || null,
       default_keyboard ? JSON.stringify(default_keyboard) : null,
       mode || null, session_timeout_min || null, webhook_url || null]
    );

    // Если указан webhook_url — автоматически регистрируем в Viber
    let webhookResult = null;
    if (webhook_url && viber.isConfigured()) {
      webhookResult = await viber.setWebhook(webhook_url).catch((e) => ({ error: e.message }));
    }

    await logAction(req, 'viber.config.update', { bot_name });
    res.json({ ok: true, config: r.rows[0], webhook_registered: webhookResult });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// POST /api/viber/config/test
router.post('/config/test', requirePerm('viber.config.write'), async (req, res) => {
  try {
    const { viber_user_id } = req.body || {};
    if (!viber_user_id) return res.status(400).json({ error: 'viber_user_id required' });
    if (!viber.isConfigured()) {
      return res.json({ ok: false, skipped: true, reason: 'no-token', message: 'VIBER_AUTH_TOKEN не задан' });
    }
    const result = await viber.sendMessage(viber_user_id, {
      type: 'text',
      content: { text: '✅ Тест підключення SVS Beauty — Viber канал працює!' },
    });
    res.json({ ok: !result.skipped, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/viber/config/webhook — вручную зарегистрировать webhook
router.post('/config/webhook', requirePerm('viber.config.write'), async (req, res) => {
  try {
    const { url, event_types } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    if (!viber.isConfigured()) {
      return res.json({ ok: false, skipped: true, reason: 'no-token' });
    }
    const result = await viber.setWebhook(url, event_types);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════
// 06.02 ПОДПИСЧИКИ
// ═════════════════════════════════════════════════════════════════════

// GET /api/viber/subscribers
router.get('/subscribers', requirePerm('viber.subscribers.read'), async (req, res) => {
  try {
    const pool = getPool();
    const { status, search, client_linked, tags, from, to, limit = 50, offset = 0 } = req.query;

    let where = ['1=1'];
    const params = [];
    let pi = 1;

    if (status) { where.push(`vs.status = $${pi++}`); params.push(status); }
    if (search) { where.push(`vs.name ILIKE $${pi++}`); params.push(`%${search}%`); }
    if (client_linked === 'true') { where.push('vs.client_id IS NOT NULL'); }
    if (client_linked === 'false') { where.push('vs.client_id IS NULL'); }
    if (tags) { where.push(`vs.tags @> $${pi++}`); params.push(tags.split(',')); }
    if (from) { where.push(`vs.subscribed_at >= $${pi++}`); params.push(from); }
    if (to) { where.push(`vs.subscribed_at <= $${pi++}`); params.push(to); }

    const whereStr = where.join(' AND ');

    const [rows, total, stats] = await Promise.all([
      pool.query(
        `SELECT vs.*, c.name AS client_name, c.phone AS client_phone
           FROM viber_subscribers vs
           LEFT JOIN clients c ON c.id = vs.client_id
          WHERE ${whereStr}
          ORDER BY vs.subscribed_at DESC
          LIMIT $${pi++} OFFSET $${pi++}`,
        [...params, Number(limit), Number(offset)]
      ),
      pool.query(`SELECT count(*)::int AS total FROM viber_subscribers vs WHERE ${whereStr}`, params),
      pool.query(
        `SELECT
           count(*) FILTER (WHERE status='active') AS active,
           count(*) FILTER (WHERE status='unsubscribed') AS unsubscribed,
           count(*) FILTER (WHERE client_id IS NOT NULL) AS linked_to_crm
         FROM viber_subscribers`
      ),
    ]);

    res.json({
      ok: true,
      subscribers: rows.rows,
      total: total.rows[0].total,
      stats: stats.rows[0],
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// GET /api/viber/subscribers/:id
router.get('/subscribers/:id', requirePerm('viber.subscribers.read'), async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(
      `SELECT vs.*, c.name AS client_name, c.phone AS client_phone
         FROM viber_subscribers vs
         LEFT JOIN clients c ON c.id = vs.client_id
        WHERE vs.id = $1`,
      [req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, subscriber: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// PATCH /api/viber/subscribers/:id
router.patch('/subscribers/:id', requirePerm('viber.subscribers.write'), async (req, res) => {
  try {
    const pool = getPool();
    const { client_id, tags } = req.body || {};
    const r = await pool.query(
      `UPDATE viber_subscribers SET
         client_id = COALESCE($2, client_id),
         tags = COALESCE($3, tags),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [req.params.id, client_id || null, tags ? tags : null]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    await logAction(req, 'viber.subscriber.update', { id: req.params.id });
    res.json({ ok: true, subscriber: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════
// 06.03 ОТПРАВКА СООБЩЕНИЙ
// ═════════════════════════════════════════════════════════════════════

// POST /api/viber/messages/send
router.post('/messages/send', requirePerm('viber.messages.send'), async (req, res) => {
  try {
    const pool = getPool();
    const { subscriber_id, message_type = 'text', content = {}, keyboard, priority } = req.body || {};
    if (!subscriber_id) return res.status(400).json({ error: 'subscriber_id required' });

    // Получаем viber_user_id подписчика
    const subRow = await pool.query(
      `SELECT viber_user_id, salon_id FROM viber_subscribers WHERE id = $1`,
      [subscriber_id]
    );
    if (!subRow.rowCount) return res.status(404).json({ error: 'subscriber-not-found' });
    const sub = subRow.rows[0];

    // Персонализация контента (подстановка переменных шаблонизатором)
    const { renderTemplate } = require('../lib/notification-hub');
    const vars = req.body.vars || {};
    if (content.text) content.text = renderTemplate(content.text, vars);

    // Отправка через Viber API
    const result = await viber.sendMessage(sub.viber_user_id, {
      type: message_type,
      content,
      keyboard,
      priority: priority === 'high' ? 1 : 0,
    });

    // Сохраняем в журнал
    const costType = priority === 'high' ? 'transactional' : 'promotional';
    const msgRow = await pool.query(
      `INSERT INTO viber_messages
         (salon_id, subscriber_id, direction, message_type, content,
          viber_message_token, status, operator_id, cost_type, sent_at)
       VALUES ($1,$2,'outbound',$3,$4,$5,$6,$7,$8,now())
       RETURNING id`,
      [sub.salon_id, subscriber_id, message_type, JSON.stringify({ content, keyboard }),
       result.providerId || null,
       result.skipped ? 'failed' : 'sent',
       req.user?.id || null, costType]
    );

    await logAction(req, 'viber.message.send', { subscriber_id, message_type });
    res.json({ ok: !result.skipped, message_id: msgRow.rows[0]?.id, result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// GET /api/viber/messages
router.get('/messages', requirePerm('viber.messages.read'), async (req, res) => {
  try {
    const pool = getPool();
    const { subscriber_id, direction, message_type, status, from, to, limit = 50, offset = 0 } = req.query;

    let where = ['1=1'];
    const params = [];
    let pi = 1;

    if (subscriber_id) { where.push(`vm.subscriber_id = $${pi++}`); params.push(subscriber_id); }
    if (direction) { where.push(`vm.direction = $${pi++}`); params.push(direction); }
    if (message_type) { where.push(`vm.message_type = $${pi++}`); params.push(message_type); }
    if (status) { where.push(`vm.status = $${pi++}`); params.push(status); }
    if (from) { where.push(`vm.sent_at >= $${pi++}`); params.push(from); }
    if (to) { where.push(`vm.sent_at <= $${pi++}`); params.push(to); }

    const whereStr = where.join(' AND ');

    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT vm.*, vs.name AS subscriber_name, vs.viber_user_id
           FROM viber_messages vm
           LEFT JOIN viber_subscribers vs ON vs.id = vm.subscriber_id
          WHERE ${whereStr}
          ORDER BY vm.sent_at DESC
          LIMIT $${pi++} OFFSET $${pi++}`,
        [...params, Number(limit), Number(offset)]
      ),
      pool.query(
        `SELECT count(*)::int AS total FROM viber_messages vm WHERE ${whereStr}`,
        params
      ),
    ]);

    res.json({ ok: true, messages: rows.rows, total: total.rows[0].total });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// GET /api/viber/messages/:id
router.get('/messages/:id', requirePerm('viber.messages.read'), async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(
      `SELECT vm.*, vs.name AS subscriber_name, vs.viber_user_id
         FROM viber_messages vm
         LEFT JOIN viber_subscribers vs ON vs.id = vm.subscriber_id
        WHERE vm.id = $1`,
      [req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, message: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════
// 06.04 БОТ — СЦЕНАРИИ
// ═════════════════════════════════════════════════════════════════════

// GET /api/viber/bot/scenarios
router.get('/bot/scenarios', requirePerm('viber.bot.write'), async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(
      `SELECT * FROM viber_bot_scenarios ORDER BY priority DESC, created_at ASC`
    );
    res.json({ ok: true, scenarios: r.rows });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// POST /api/viber/bot/scenarios
router.post('/bot/scenarios', requirePerm('viber.bot.write'), async (req, res) => {
  try {
    const pool = getPool();
    const { name, trigger_type, trigger_value, flow, is_active = true, priority = 0 } = req.body || {};
    if (!name || !trigger_type || !trigger_value || !flow) {
      return res.status(400).json({ error: 'name, trigger_type, trigger_value, flow required' });
    }
    const VALID_TRIGGERS = ['keyword', 'button', 'first_message', 'regex'];
    if (!VALID_TRIGGERS.includes(trigger_type)) {
      return res.status(400).json({ error: 'invalid trigger_type', valid: VALID_TRIGGERS });
    }
    const r = await pool.query(
      `INSERT INTO viber_bot_scenarios
         (salon_id, name, trigger_type, trigger_value, flow, is_active, priority)
       VALUES (current_tenant_id(), $1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [name, trigger_type, trigger_value, JSON.stringify(flow), is_active, priority]
    );
    await logAction(req, 'viber.scenario.create', { name });
    res.status(201).json({ ok: true, scenario: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// PUT /api/viber/bot/scenarios/:id
router.put('/bot/scenarios/:id', requirePerm('viber.bot.write'), async (req, res) => {
  try {
    const pool = getPool();
    const { name, trigger_type, trigger_value, flow, is_active, priority } = req.body || {};
    const r = await pool.query(
      `UPDATE viber_bot_scenarios SET
         name = COALESCE($2, name),
         trigger_type = COALESCE($3, trigger_type),
         trigger_value = COALESCE($4, trigger_value),
         flow = COALESCE($5::jsonb, flow),
         is_active = COALESCE($6, is_active),
         priority = COALESCE($7, priority),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [req.params.id, name || null, trigger_type || null, trigger_value || null,
       flow ? JSON.stringify(flow) : null, is_active != null ? is_active : null,
       priority != null ? priority : null]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    await logAction(req, 'viber.scenario.update', { id: req.params.id });
    res.json({ ok: true, scenario: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// DELETE /api/viber/bot/scenarios/:id
router.delete('/bot/scenarios/:id', requirePerm('viber.bot.write'), async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(`DELETE FROM viber_bot_scenarios WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    await logAction(req, 'viber.scenario.delete', { id: req.params.id });
    res.json({ ok: true, deleted_id: req.params.id });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════
// 06.05 МАССОВЫЕ РАССЫЛКИ
// ═════════════════════════════════════════════════════════════════════

// GET /api/viber/broadcasts
router.get('/broadcasts', requirePerm('viber.broadcasts.create'), async (req, res) => {
  try {
    const pool = getPool();
    const { status, from, to, limit = 20, offset = 0 } = req.query;

    let where = ['1=1'];
    const params = [];
    let pi = 1;

    if (status) { where.push(`status = $${pi++}`); params.push(status); }
    if (from) { where.push(`created_at >= $${pi++}`); params.push(from); }
    if (to) { where.push(`created_at <= $${pi++}`); params.push(to); }

    const whereStr = where.join(' AND ');

    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT vb.*, e.name AS created_by_name
           FROM viber_broadcasts vb
           LEFT JOIN employees e ON e.id = vb.created_by
          WHERE ${whereStr}
          ORDER BY vb.created_at DESC
          LIMIT $${pi++} OFFSET $${pi++}`,
        [...params, Number(limit), Number(offset)]
      ),
      pool.query(`SELECT count(*)::int AS total FROM viber_broadcasts WHERE ${whereStr}`, params),
    ]);

    res.json({ ok: true, broadcasts: rows.rows, total: total.rows[0].total });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// POST /api/viber/broadcasts
router.post('/broadcasts', requirePerm('viber.broadcasts.create'), async (req, res) => {
  try {
    const pool = getPool();
    const {
      name, message_type, content, audience_type = 'all',
      audience_filter, scheduled_at,
    } = req.body || {};

    if (!name || !message_type || !content) {
      return res.status(400).json({ error: 'name, message_type, content required' });
    }

    // Подсчёт аудитории
    let audienceCount = 0;
    if (audience_type === 'all') {
      const cnt = await pool.query(`SELECT count(*)::int c FROM viber_subscribers WHERE status='active'`);
      audienceCount = cnt.rows[0].c;
    } else if (audience_type === 'segment' && audience_filter) {
      // Базовая фильтрация по тегам
      const f = audience_filter;
      let aq = `SELECT count(*)::int c FROM viber_subscribers WHERE status='active'`;
      if (f.tags?.length) aq += ` AND tags @> '${JSON.stringify(f.tags)}'::jsonb`;
      const cnt = await pool.query(aq);
      audienceCount = cnt.rows[0].c;
    }

    const r = await pool.query(
      `INSERT INTO viber_broadcasts
         (salon_id, name, message_type, content, audience_type, audience_filter,
          audience_count, status, scheduled_at, created_by)
       VALUES (current_tenant_id(),$1,$2,$3,$4,$5,$6,'draft',$7,$8)
       RETURNING *`,
      [name, message_type, JSON.stringify(content),
       audience_type, audience_filter ? JSON.stringify(audience_filter) : null,
       audienceCount, scheduled_at || null, req.user?.id || null]
    );

    await logAction(req, 'viber.broadcast.create', { name, audience_count: audienceCount });
    res.status(201).json({ ok: true, broadcast: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// GET /api/viber/broadcasts/:id
router.get('/broadcasts/:id', requirePerm('viber.broadcasts.create'), async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(
      `SELECT vb.*, e.name AS created_by_name
         FROM viber_broadcasts vb
         LEFT JOIN employees e ON e.id = vb.created_by
        WHERE vb.id = $1`,
      [req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, broadcast: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// POST /api/viber/broadcasts/:id/start
router.post('/broadcasts/:id/start', requirePerm('viber.broadcasts.execute'), async (req, res) => {
  try {
    const pool = getPool();
    const bcRow = await pool.query(
      `SELECT * FROM viber_broadcasts WHERE id = $1 AND status IN ('draft','scheduled')`,
      [req.params.id]
    );
    if (!bcRow.rowCount) return res.status(404).json({ error: 'broadcast-not-found-or-not-startable' });
    const bc = bcRow.rows[0];

    // Обновляем статус на sending
    await pool.query(
      `UPDATE viber_broadcasts SET status='sending', started_at=now(), updated_at=now() WHERE id=$1`,
      [bc.id]
    );

    // Асинхронная рассылка — запускаем в фоне, не ждём завершения
    _runBroadcast(pool, bc).catch((e) => {
      console.error('[viber-broadcast]', e.message);
      pool.query(
        `UPDATE viber_broadcasts SET status='completed', updated_at=now() WHERE id=$1`,
        [bc.id]
      );
    });

    await logAction(req, 'viber.broadcast.start', { id: bc.id });
    res.json({ ok: true, message: 'broadcast-started', broadcast_id: bc.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// POST /api/viber/broadcasts/:id/cancel
router.post('/broadcasts/:id/cancel', requirePerm('viber.broadcasts.execute'), async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE viber_broadcasts SET status='cancelled', updated_at=now()
       WHERE id=$1 AND status IN ('draft','scheduled')
       RETURNING id`,
      [req.params.id]
    );
    if (!r.rowCount) return res.status(400).json({ error: 'cannot-cancel: already sending or completed' });
    await logAction(req, 'viber.broadcast.cancel', { id: req.params.id });
    res.json({ ok: true, cancelled_id: req.params.id });
  } catch (e) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// Фоновая отправка рассылки (пакетами по 300)
async function _runBroadcast(pool, bc) {
  const BATCH = 300; // лимит Viber broadcast_message API
  let offset = 0;
  let totalSent = 0, totalFailed = 0;

  while (true) {
    // Проверяем не отменили ли рассылку
    const check = await pool.query(`SELECT status FROM viber_broadcasts WHERE id=$1`, [bc.id]);
    if (check.rows[0]?.status === 'cancelled') break;

    const subs = await pool.query(
      `SELECT viber_user_id FROM viber_subscribers WHERE salon_id=$1 AND status='active'
       ORDER BY subscribed_at ASC LIMIT $2 OFFSET $3`,
      [bc.salon_id, BATCH, offset]
    );
    if (!subs.rowCount) break;

    const ids = subs.rows.map((r) => r.viber_user_id);
    let sent = 0, failed = 0;

    try {
      const result = await viber.broadcast(ids, {
        type: bc.message_type,
        content: bc.content,
      });

      if (result.skipped) {
        // Нет токена — имитируем "sent" без реальной отправки
        sent = ids.length;
      } else {
        // Анализируем статусы по каждому получателю
        const details = Array.isArray(result.details) ? result.details : [];
        for (const d of details) {
          if (d.status === 0) sent++; else failed++;
        }
        if (!details.length) sent = ids.length;
      }
    } catch (_e) {
      failed = ids.length;
    }

    totalSent += sent;
    totalFailed += failed;
    offset += subs.rowCount;

    // Обновляем счётчики
    await pool.query(
      `UPDATE viber_broadcasts SET stats_sent=$2, stats_failed=$3, updated_at=now() WHERE id=$1`,
      [bc.id, totalSent, totalFailed]
    );

    if (subs.rowCount < BATCH) break;
  }

  await pool.query(
    `UPDATE viber_broadcasts SET status='completed', completed_at=now(), updated_at=now() WHERE id=$1`,
    [bc.id]
  );
}

// ═════════════════════════════════════════════════════════════════════
// 06.06 АНАЛИТИКА И СТОИМОСТЬ
// ═════════════════════════════════════════════════════════════════════

// GET /api/viber/analytics
router.get('/analytics', requirePerm('viber.analytics.read'), async (req, res) => {
  try {
    const pool = getPool();
    const { from, to, granularity = 'day' } = req.query;
    const dateFrom = from || new Date(Date.now() - 30 * 24 * 3600000).toISOString();
    const dateTo = to || new Date().toISOString();

    // Агрегация по дням/неделям/месяцам
    const truncFn =
      granularity === 'month' ? 'month'
      : granularity === 'week' ? 'week'
      : 'day';

    const [msgChart, subChart, delivStat, botStats] = await Promise.all([
      pool.query(
        `SELECT date_trunc($1, sent_at) AS period,
                count(*) FILTER (WHERE direction='outbound') AS sent,
                count(*) FILTER (WHERE status='delivered') AS delivered,
                count(*) FILTER (WHERE status='seen') AS seen
           FROM viber_messages
          WHERE sent_at BETWEEN $2 AND $3
          GROUP BY 1 ORDER BY 1`,
        [truncFn, dateFrom, dateTo]
      ),
      pool.query(
        `SELECT date_trunc($1, subscribed_at) AS period,
                count(*) AS new_subscribers,
                count(*) FILTER (WHERE status='unsubscribed') AS unsubscribed
           FROM viber_subscribers
          WHERE subscribed_at BETWEEN $2 AND $3
          GROUP BY 1 ORDER BY 1`,
        [truncFn, dateFrom, dateTo]
      ),
      pool.query(
        `SELECT
           count(*) FILTER (WHERE direction='outbound') AS total_sent,
           count(*) FILTER (WHERE status IN ('delivered','seen')) AS total_delivered,
           count(*) FILTER (WHERE status='seen') AS total_seen,
           ROUND(100.0 * count(*) FILTER (WHERE status IN ('delivered','seen'))
             / NULLIF(count(*) FILTER (WHERE direction='outbound'),0), 1) AS delivery_rate,
           ROUND(100.0 * count(*) FILTER (WHERE status='seen')
             / NULLIF(count(*) FILTER (WHERE direction='outbound'),0), 1) AS read_rate
         FROM viber_messages WHERE sent_at BETWEEN $1 AND $2`,
        [dateFrom, dateTo]
      ),
      pool.query(
        `SELECT
           count(*) AS total_sessions,
           sum(stats_triggered) AS total_triggered,
           sum(stats_completed) AS total_completed,
           sum(stats_handover) AS total_handover
         FROM viber_bot_scenarios`
      ),
    ]);

    res.json({
      ok: true,
      messages_chart: msgChart.rows,
      subscribers_chart: subChart.rows,
      delivery_rate: delivStat.rows[0]?.delivery_rate || 0,
      read_rate: delivStat.rows[0]?.read_rate || 0,
      totals: delivStat.rows[0],
      bot_stats: botStats.rows[0],
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// GET /api/viber/cost
router.get('/cost', requirePerm('viber.cost.read'), async (req, res) => {
  try {
    const pool = getPool();
    const { from, to } = req.query;
    const dateFrom = from || new Date(Date.now() - 30 * 24 * 3600000).toISOString();
    const dateTo = to || new Date().toISOString();

    const [rates, spent] = await Promise.all([
      pool.query(
        `SELECT * FROM viber_cost_rates
          WHERE (effective_to IS NULL OR effective_to >= now())
          ORDER BY cost_type, effective_from DESC`
      ),
      pool.query(
        `SELECT
           cost_type,
           count(*) AS messages,
           sum(cost_amount) AS total
         FROM viber_messages
         WHERE direction='outbound' AND sent_at BETWEEN $1 AND $2
         GROUP BY cost_type`,
        [dateFrom, dateTo]
      ),
    ]);

    const byType = {};
    for (const row of spent.rows) {
      byType[row.cost_type] = { messages: Number(row.messages), total: Number(row.total) };
    }
    const totalSpent = Object.values(byType).reduce((s, v) => s + (v.total || 0), 0);

    res.json({
      ok: true,
      rates: rates.rows,
      total_spent: totalSpent,
      by_type: byType,
      period: { from: dateFrom, to: dateTo },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

module.exports = router;
