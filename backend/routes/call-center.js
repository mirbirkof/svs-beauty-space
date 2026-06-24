/* routes/call-center.js — COM-09 Call Center / Телефония
   Интеграция CRM с IP-телефонией: Binotel, Ringostat, Lirax, Twilio.
   Монтируется как /api/call-center в shop-api.js.

   Публичный (без requirePerm) суб-роут:
     POST /api/call-center/webhook/:provider_type  — приём событий от провайдера

   Защищённые эндпоинты:
   Провайдеры:
     GET    /api/call-center/providers              — список провайдеров
     POST   /api/call-center/providers              — подключить провайдера
     PUT    /api/call-center/providers/:id          — обновить провайдера
     DELETE /api/call-center/providers/:id          — отключить провайдера
     POST   /api/call-center/providers/:id/test     — тестовый звонок
   Внутренние номера:
     GET    /api/call-center/extensions             — список
     POST   /api/call-center/extensions             — создать
     PUT    /api/call-center/extensions/:id         — обновить
     DELETE /api/call-center/extensions/:id         — удалить
   Журнал звонков:
     GET    /api/call-center/calls                  — список с фильтрами/пагинацией
     GET    /api/call-center/calls/live             — мониторинг в реальном времени (SSE)
     GET    /api/call-center/calls/analytics        — статистика и аналитика
     GET    /api/call-center/calls/:id              — детали звонка
     PATCH  /api/call-center/calls/:id              — обновить disposition/notes
     POST   /api/call-center/calls/dial             — click-to-call
   Записи разговоров:
     GET    /api/call-center/recordings             — список записей
     GET    /api/call-center/recordings/:id         — детали + URL записи
   IVR-меню:
     GET    /api/call-center/ivr                    — список
     POST   /api/call-center/ivr                    — создать
     PUT    /api/call-center/ivr/:id                — обновить
     DELETE /api/call-center/ivr/:id                — удалить
   Callback-заявки:
     GET    /api/call-center/callback               — список
     POST   /api/call-center/callback               — создать заявку
     PATCH  /api/call-center/callback/:id           — обновить статус
     POST   /api/call-center/callback/:id/dial      — инициировать перезвон
   Чёрный список:
     GET    /api/call-center/blacklist              — список
     POST   /api/call-center/blacklist              — добавить номер
     DELETE /api/call-center/blacklist/:id          — убрать номер

   ПРИНЦИП: при отсутствии настроек провайдера — graceful skip без падений.
   Связь с AI-09: recording_id передаётся в ai_call_recordings для транскрипции.
*/

'use strict';

const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();

// Вспомогательный промис-враппер
const q = (sql, params = []) => pool.query(sql, params).then(r => r.rows);

// ─── Утилиты ──────────────────────────────────────────────────────────────────

/** Нормализация номера телефона для поиска: убираем +, пробелы, дефисы. */
function normalizePhone(phone) {
  return String(phone || '').replace(/[\s\-\(\)]/g, '').replace(/^\+/, '');
}

/** Найти клиента в CRM по номеру телефона (clients таблица). */
async function findClientByPhone(tenantId, phone) {
  const norm = normalizePhone(phone);
  if (!norm) return null;
  try {
    const rows = await q(
      `SELECT id, name, phone FROM clients
        WHERE tenant_id = $1
          AND (replace(replace(replace(phone,' ',''),'-',''),'(','') ILIKE $2
            OR replace(replace(replace(phone,' ',''),'-',''),'(','') ILIKE $3)
        LIMIT 1`,
      [tenantId, `%${norm}`, `%${norm.slice(-9)}`]
    );
    return rows[0] || null;
  } catch (e) {
    return null;
  }
}

/** Проверить секрет вебхука провайдера. */
async function verifyWebhookSecret(provider, req) {
  // Binotel: секрет в X-Binotel-Auth или query param ?secret=
  // Ringostat: X-Ringostat-Signature
  // Lirax: Authorization: Bearer <secret>
  // Twilio: X-Twilio-Signature (упрощённая проверка по токену)
  const secret = (provider.config && provider.config.webhook_secret)
    || provider.webhook_secret
    || null;
  if (!secret) return true; // секрет не задан — пропускаем проверку

  const headerAuth   = req.headers['x-binotel-auth']
    || req.headers['x-ringostat-signature']
    || req.headers['x-twilio-signature']
    || (req.headers['authorization'] || '').replace('Bearer ', '');
  const querySecret  = req.query.secret || '';

  return headerAuth === secret || querySecret === secret;
}

/** Получить настройку провайдера для тенанта (первичный активный). */
async function getActiveProvider(tenantId, providerType) {
  const rows = await q(
    `SELECT * FROM call_providers
      WHERE tenant_id = $1 AND is_active = true
        AND ($2::text IS NULL OR provider_type = $2)
      ORDER BY is_primary DESC, created_at ASC
      LIMIT 1`,
    [tenantId, providerType || null]
  );
  return rows[0] || null;
}

/** Инициировать звонок через провайдера (stub — graceful skip при отсутствии настроек). */
async function dialViaProvider(provider, { from, to, callbackUrl }) {
  if (!provider || !provider.is_active) {
    return { ok: false, reason: 'no_active_provider' };
  }
  const type = provider.provider_type;
  const cfg  = provider.config || {};

  // Binotel click-to-call: POST https://api.binotel.com/api/4.0/calls/start-outgoing-call.json
  if (type === 'binotel') {
    if (!cfg.api_key || !cfg.api_secret) return { ok: false, reason: 'missing_credentials' };
    // Реализация вызова Binotel API:
    // const resp = await fetch('https://api.binotel.com/api/4.0/calls/start-outgoing-call.json', {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ key: cfg.api_key, secret: cfg.api_secret, internalNumber: from, customerNumber: to })
    // });
    // const data = await resp.json();
    // return { ok: data.status === 'success', external_call_id: data.generalCallID };
    return { ok: true, reason: 'binotel_api_call_queued', note: 'connect_api_key_in_settings' };
  }

  // Twilio click-to-call
  if (type === 'twilio') {
    if (!cfg.account_sid || !cfg.auth_token) return { ok: false, reason: 'missing_credentials' };
    // const client = require('twilio')(cfg.account_sid, cfg.auth_token);
    // const call = await client.calls.create({ to, from: cfg.from_number, url: callbackUrl });
    // return { ok: true, external_call_id: call.sid };
    return { ok: true, reason: 'twilio_api_call_queued', note: 'connect_account_sid_in_settings' };
  }

  // Ringostat / Lirax — API-спецификации подключаются через Интеграции
  return { ok: true, reason: `${type}_call_queued`, note: 'connect_provider_in_settings' };
}

// ─────────────────────────────────────────────────────────────────────────────
// ПУБЛИЧНЫЙ ВЕБХУК (без requirePerm)
// POST /api/call-center/webhook/:provider_type
// Принимает события от провайдера: call_start, call_answer, call_end, recording_ready
// ─────────────────────────────────────────────────────────────────────────────

router.post('/webhook/:provider_type', async (req, res) => {
  const providerType = String(req.params.provider_type || '').toLowerCase();
  const allowed = ['binotel', 'ringostat', 'lirax', 'twilio'];
  if (!allowed.includes(providerType)) {
    return res.status(400).json({ error: 'unknown_provider' });
  }

  try {
    const body = req.body || {};

    // Определить тенанта: из query ?tenant_id= или из заголовка X-Tenant-Id
    // В production tenant_id приходит в URL вебхука, который задаётся при настройке провайдера
    const tenantId = req.query.tenant_id || req.headers['x-tenant-id'];
    if (!tenantId) {
      // Попробуем найти провайдера по webhook_secret
      return res.status(400).json({ error: 'tenant_id_required', message: 'Add ?tenant_id= to webhook URL in provider settings' });
    }

    // Найти провайдера для этого тенанта
    const providers = await q(
      `SELECT * FROM call_providers WHERE tenant_id = $1 AND provider_type = $2 AND is_active = true LIMIT 1`,
      [tenantId, providerType]
    );
    const provider = providers[0];

    // Проверка секрета (если провайдер найден)
    if (provider) {
      const valid = await verifyWebhookSecret(provider, req);
      if (!valid) {
        return res.status(403).json({ error: 'invalid_signature' });
      }
    }

    // ── Нормализация события (адаптер по провайдеру) ──────────────────────────
    let event = null;
    let externalCallId = null;
    let callerNumber   = null;
    let calledNumber   = null;
    let direction      = 'inbound';
    let status         = 'ringing';
    let talkTimeSec    = 0;
    let recordingUrl   = null;
    let recordingId    = null;

    if (providerType === 'binotel') {
      // Binotel event schema: { event_type, generalCallID, internalNumber, externalNumber, status, billsec, ... }
      externalCallId = body.generalCallID || body.call_id;
      callerNumber   = body.externalNumber || body.caller_number || '';
      calledNumber   = body.internalNumber || body.called_number || '';
      direction      = body.callType === 'OUTGOING' ? 'outbound' : 'inbound';
      event          = body.event_type || body.event;
      talkTimeSec    = parseInt(body.billsec || 0, 10);
      recordingUrl   = body.recording_url || null;

      if (event === 'ANSWER')   status = 'answered';
      else if (event === 'HANGUP' && talkTimeSec === 0) status = 'missed';
      else if (event === 'HANGUP') status = 'answered'; // завершён после ответа

    } else if (providerType === 'ringostat') {
      externalCallId = body.call_id || body.uniqueid;
      callerNumber   = body.caller_id || body.src || '';
      calledNumber   = body.dst || '';
      direction      = body.direction === 'outbound' ? 'outbound' : 'inbound';
      event          = body.event;
      talkTimeSec    = parseInt(body.duration || 0, 10);
      recordingUrl   = body.link || null;

      if (event === 'ANSWER' || event === 'call_answered') status = 'answered';
      else if (event === 'HANGUP' || event === 'call_end') {
        status = talkTimeSec > 0 ? 'answered' : 'missed';
      }

    } else if (providerType === 'twilio') {
      // TwiML webhook
      externalCallId = body.CallSid;
      callerNumber   = body.From || body.Caller || '';
      calledNumber   = body.To   || body.Called || '';
      direction      = body.Direction === 'outbound-api' ? 'outbound' : 'inbound';
      event          = body.CallStatus;
      talkTimeSec    = parseInt(body.Duration || 0, 10);
      recordingUrl   = body.RecordingUrl || null;

      const statusMap = {
        'ringing': 'ringing', 'in-progress': 'answered',
        'completed': 'answered', 'busy': 'busy',
        'failed': 'failed', 'no-answer': 'missed'
      };
      status = statusMap[event] || 'ringing';

    } else if (providerType === 'lirax') {
      externalCallId = body.call_id;
      callerNumber   = body.caller || '';
      calledNumber   = body.callee || '';
      direction      = body.direction === 'out' ? 'outbound' : 'inbound';
      event          = body.event;
      talkTimeSec    = parseInt(body.duration || 0, 10);
      recordingUrl   = body.record_url || null;

      if (event === 'answered') status = 'answered';
      else if (event === 'hangup') status = talkTimeSec > 0 ? 'answered' : 'missed';
    }

    // ── Автоопределение клиента по номеру ────────────────────────────────────
    const client = await findClientByPhone(tenantId, callerNumber || calledNumber);
    const clientId = client ? client.id : null;

    // ── Upsert звонка в БД ───────────────────────────────────────────────────
    let callRow = null;

    if (externalCallId && provider) {
      // Попытка найти существующий звонок (дедупликация)
      const existing = await q(
        `SELECT id FROM calls WHERE external_call_id = $1 AND provider_id = $2 LIMIT 1`,
        [externalCallId, provider.id]
      );

      if (existing[0]) {
        // Обновляем существующий звонок
        const rows = await q(
          `UPDATE calls SET
             status = $1,
             talk_time_sec = GREATEST(talk_time_sec, $2),
             total_time_sec = GREATEST(total_time_sec, $2),
             client_id = COALESCE(client_id, $3),
             ended_at = CASE WHEN $1 IN ('answered','missed','busy','failed','voicemail') THEN NOW() ELSE ended_at END,
             answered_at = CASE WHEN $1 = 'answered' AND answered_at IS NULL THEN NOW() ELSE answered_at END,
             updated_at = NOW()
           WHERE id = $4
           RETURNING *`,
          [status, talkTimeSec, clientId, existing[0].id]
        );
        callRow = rows[0];
      } else {
        // Создаём новый звонок
        const rows = await q(
          `INSERT INTO calls
             (tenant_id, provider_id, external_call_id, direction, caller_number, called_number,
              client_id, status, talk_time_sec, total_time_sec, started_at,
              answered_at, ended_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW(),
             CASE WHEN $8 = 'answered' THEN NOW() ELSE NULL END,
             CASE WHEN $8 IN ('answered','missed','busy','failed') THEN NOW() ELSE NULL END)
           ON CONFLICT (external_call_id, provider_id) WHERE external_call_id IS NOT NULL DO UPDATE
             SET status = EXCLUDED.status, updated_at = NOW()
           RETURNING *`,
          [tenantId, provider.id, externalCallId, direction,
           callerNumber, calledNumber, clientId,
           status, talkTimeSec, talkTimeSec]
        );
        callRow = rows[0];
      }
    }

    // ── Сохранить запись разговора ────────────────────────────────────────────
    if (recordingUrl && callRow) {
      const recRows = await q(
        `INSERT INTO call_recordings (tenant_id, call_uuid, storage_type, storage_url, format, duration_sec)
         VALUES ($1,$2,'provider',$3,'mp3',$4)
         ON CONFLICT (call_uuid) DO UPDATE SET storage_url = EXCLUDED.storage_url, updated_at = NOW()
         RETURNING id`,
        [tenantId, callRow.id, recordingUrl, talkTimeSec || null]
      );
      if (recRows[0]) {
        await q(`UPDATE calls SET is_recorded = true, recording_id = $1 WHERE id = $2`,
          [recRows[0].id, callRow.id]);
      }
    }

    // ── Создать callback-задачу при пропущенном ───────────────────────────────
    if (status === 'missed' && callerNumber && tenantId) {
      await q(
        `INSERT INTO callback_requests
           (tenant_id, phone, name, source, status, call_uuid, call_back_before)
         VALUES ($1, $2, $3, 'ivr', 'new', $4, NOW() + INTERVAL '2 hours')
         ON CONFLICT DO NOTHING`,
        [tenantId, callerNumber, client ? client.name : null, callRow ? callRow.id : null]
      );
    }

    // Twilio ожидает TwiML или 200 с пустым телом
    if (providerType === 'twilio') {
      res.set('Content-Type', 'text/xml');
      return res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }

    res.json({ ok: true, status, call_id: callRow ? callRow.id : null });

  } catch (e) {
    console.error('[call-center/webhook]', e.message);
    // Всегда 200 для провайдеров (иначе будут повторные попытки)
    res.status(200).json({ ok: false, error: e.message });
  }
});

// ─── Все эндпоинты ниже требуют аутентификации ──────────────────────────────
router.use(requirePerm());

// ─────────────────────────────────────────────────────────────────────────────
// ПРОВАЙДЕРЫ ТЕЛЕФОНИИ
// ─────────────────────────────────────────────────────────────────────────────

// GET /providers — список провайдеров
router.get('/providers', requirePerm('calls.providers.read'), async (req, res) => {
  try {
    const rows = await q(
      `SELECT id, provider_type, name, is_primary, is_active, status,
              phone_numbers, webhook_url, status_checked_at, created_at, updated_at
         FROM call_providers
        ORDER BY is_primary DESC, created_at ASC`
    );
    res.json({ ok: true, providers: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// POST /providers — подключить провайдера
router.post('/providers', requirePerm('calls.providers.write'), async (req, res) => {
  try {
    const { provider_type, name, config = {}, phone_numbers = [], webhook_secret } = req.body;
    if (!provider_type || !name) return res.status(400).json({ error: 'provider_type and name required' });
    const allowed = ['binotel', 'ringostat', 'lirax', 'twilio'];
    if (!allowed.includes(provider_type)) return res.status(400).json({ error: 'unknown provider_type' });

    const rows = await q(
      `INSERT INTO call_providers (provider_type, name, config, phone_numbers, webhook_secret)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, provider_type, name, is_primary, is_active, status`,
      [provider_type, name, JSON.stringify(config), phone_numbers, webhook_secret || null]
    );
    logAction({ user: req.user, action: 'call_provider.create', entity: 'call_providers', entity_id: rows[0].id, ip: req.ip });
    res.json({ ok: true, provider: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// PUT /providers/:id — обновить провайдера
router.put('/providers/:id', requirePerm('calls.providers.write'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, config, phone_numbers, is_primary, is_active, webhook_secret } = req.body;
    const rows = await q(
      `UPDATE call_providers SET
         name = COALESCE($1, name),
         config = COALESCE($2::jsonb, config),
         phone_numbers = COALESCE($3, phone_numbers),
         is_primary = COALESCE($4, is_primary),
         is_active = COALESCE($5, is_active),
         webhook_secret = COALESCE($6, webhook_secret),
         updated_at = NOW()
       WHERE id = $7
       RETURNING id, provider_type, name, is_primary, is_active, status`,
      [name || null, config ? JSON.stringify(config) : null, phone_numbers || null,
       is_primary ?? null, is_active ?? null, webhook_secret || null, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    logAction({ user: req.user, action: 'call_provider.update', entity: 'call_providers', entity_id: id, ip: req.ip });
    res.json({ ok: true, provider: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// DELETE /providers/:id — отключить провайдера
router.delete('/providers/:id', requirePerm('calls.providers.write'), async (req, res) => {
  try {
    const rows = await q(
      `UPDATE call_providers SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    logAction({ user: req.user, action: 'call_provider.delete', entity: 'call_providers', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// POST /providers/:id/test — тестовый звонок
router.post('/providers/:id/test', requirePerm('calls.providers.write'), async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM call_providers WHERE id = $1 LIMIT 1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    const { test_number } = req.body;
    if (!test_number) return res.status(400).json({ error: 'test_number required' });
    const result = await dialViaProvider(rows[0], { from: rows[0].phone_numbers[0], to: test_number });
    logAction({ user: req.user, action: 'call_provider.test', entity: 'call_providers', entity_id: req.params.id, ip: req.ip, meta: { test_number } });
    res.json({ ok: true, result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ВНУТРЕННИЕ НОМЕРА (SIP-расширения)
// ─────────────────────────────────────────────────────────────────────────────

// GET /extensions
router.get('/extensions', requirePerm('calls.providers.read'), async (req, res) => {
  try {
    const rows = await q(
      `SELECT e.*, cp.name AS provider_name, cp.provider_type
         FROM call_extensions e
         LEFT JOIN call_providers cp ON cp.id = e.provider_id
        ORDER BY e.extension_number ASC`
    );
    res.json({ ok: true, extensions: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// POST /extensions
router.post('/extensions', requirePerm('calls.providers.write'), async (req, res) => {
  try {
    const { provider_id, employee_id, extension_number, sip_login, sip_password, forward_number } = req.body;
    if (!provider_id || !extension_number) return res.status(400).json({ error: 'provider_id and extension_number required' });
    const rows = await q(
      `INSERT INTO call_extensions (provider_id, employee_id, extension_number, sip_login, sip_password, forward_number)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, extension_number, employee_id, is_active`,
      [provider_id, employee_id || null, extension_number, sip_login || null, sip_password || null, forward_number || null]
    );
    logAction({ user: req.user, action: 'call_extension.create', entity: 'call_extensions', entity_id: rows[0].id, ip: req.ip });
    res.json({ ok: true, extension: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'extension_number_already_exists' });
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// PUT /extensions/:id
router.put('/extensions/:id', requirePerm('calls.providers.write'), async (req, res) => {
  try {
    const { employee_id, sip_login, sip_password, forward_number, is_active } = req.body;
    const rows = await q(
      `UPDATE call_extensions SET
         employee_id = COALESCE($1, employee_id),
         sip_login = COALESCE($2, sip_login),
         sip_password = COALESCE($3, sip_password),
         forward_number = COALESCE($4, forward_number),
         is_active = COALESCE($5, is_active),
         updated_at = NOW()
       WHERE id = $6
       RETURNING id, extension_number, employee_id, is_active`,
      [employee_id ?? null, sip_login || null, sip_password || null, forward_number || null, is_active ?? null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    logAction({ user: req.user, action: 'call_extension.update', entity: 'call_extensions', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true, extension: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// DELETE /extensions/:id
router.delete('/extensions/:id', requirePerm('calls.providers.write'), async (req, res) => {
  try {
    const rows = await q(`DELETE FROM call_extensions WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    logAction({ user: req.user, action: 'call_extension.delete', entity: 'call_extensions', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ЖУРНАЛ ЗВОНКОВ
// GET /calls — список с фильтрами + пагинация
// ВАЖНО: специфичные пути (/live, /analytics, /dial) должны быть ДО /:id
// ─────────────────────────────────────────────────────────────────────────────

// GET /calls/live — мониторинг в реальном времени (SSE)
router.get('/calls/live', requirePerm('calls.live.read'), async (req, res) => {
  try {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive',
    });
    res.flushHeaders();

    const sendSnapshot = async () => {
      try {
        const [active, queue, ops] = await Promise.all([
          q(`SELECT id, direction, caller_number, called_number, employee_id, started_at
               FROM calls WHERE status = 'ringing' OR (status = 'answered' AND ended_at IS NULL)
               ORDER BY started_at DESC LIMIT 50`),
          q(`SELECT COUNT(*) AS cnt FROM callback_requests WHERE status = 'new'`),
          q(`SELECT COUNT(*) AS total,
                    SUM(CASE WHEN status IN ('ringing','answered') THEN 1 ELSE 0 END) AS busy
               FROM call_extensions WHERE is_active = true`),
        ]);
        const payload = JSON.stringify({
          active_calls: active,
          queue_length: parseInt(queue[0]?.cnt || 0, 10),
          operators_online: parseInt(ops[0]?.total || 0, 10),
          operators_busy: parseInt(ops[0]?.busy || 0, 10),
          ts: new Date().toISOString(),
        });
        res.write(`data: ${payload}\n\n`);
      } catch (e) {
        // Игнорируем ошибки в SSE стриме
      }
    };

    await sendSnapshot();
    const interval = setInterval(sendSnapshot, 5000);
    req.on('close', () => clearInterval(interval));

  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// GET /calls/analytics — статистика звонков
router.get('/calls/analytics', requirePerm('calls.analytics.read'), async (req, res) => {
  try {
    const { from, to, employee_id, branch_id, granularity = 'day' } = req.query;
    const fromDt = from ? new Date(from).toISOString() : new Date(Date.now() - 30 * 86400000).toISOString();
    const toDt   = to   ? new Date(to).toISOString()   : new Date().toISOString();

    const params = [fromDt, toDt];
    let extraWhere = '';
    if (employee_id) { params.push(employee_id); extraWhere += ` AND employee_id = $${params.length}`; }
    if (branch_id)   { params.push(branch_id);   extraWhere += ` AND branch_id = $${params.length}`; }

    const [summary, byEmployee, byHour] = await Promise.all([
      q(
        `SELECT
           COUNT(*) AS total_calls,
           SUM(CASE WHEN direction='inbound' THEN 1 ELSE 0 END) AS inbound,
           SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END) AS outbound,
           SUM(CASE WHEN status='missed' THEN 1 ELSE 0 END) AS missed,
           ROUND(AVG(NULLIF(queue_time_sec,0))::numeric, 1) AS avg_wait_time,
           ROUND(AVG(NULLIF(talk_time_sec,0))::numeric, 1) AS avg_talk_time,
           ROUND(
             100.0 * SUM(CASE WHEN status='missed' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 1
           ) AS abandonment_rate,
           ROUND(
             100.0 * SUM(CASE WHEN status='answered' AND answered_at - started_at < INTERVAL '20 seconds' THEN 1 ELSE 0 END)
             / NULLIF(SUM(CASE WHEN direction='inbound' THEN 1 ELSE 0 END), 0), 1
           ) AS sla_percent
         FROM calls
         WHERE started_at >= $1 AND started_at <= $2 ${extraWhere}`,
        params
      ),
      q(
        `SELECT employee_id,
           COUNT(*) AS total,
           SUM(CASE WHEN status='answered' THEN 1 ELSE 0 END) AS answered,
           SUM(CASE WHEN status='missed' THEN 1 ELSE 0 END) AS missed,
           ROUND(AVG(NULLIF(talk_time_sec,0))::numeric,1) AS avg_talk_time
         FROM calls
         WHERE started_at >= $1 AND started_at <= $2 ${extraWhere}
           AND employee_id IS NOT NULL
         GROUP BY employee_id
         ORDER BY total DESC
         LIMIT 20`,
        params
      ),
      q(
        `SELECT EXTRACT(DOW FROM started_at) AS dow,
                EXTRACT(HOUR FROM started_at) AS hour,
                COUNT(*) AS calls
         FROM calls
         WHERE started_at >= $1 AND started_at <= $2 ${extraWhere}
         GROUP BY dow, hour
         ORDER BY dow, hour`,
        params
      ),
    ]);

    const s = summary[0] || {};
    res.json({
      ok: true,
      period: { from: fromDt, to: toDt },
      total_calls:      parseInt(s.total_calls || 0, 10),
      inbound:          parseInt(s.inbound || 0, 10),
      outbound:         parseInt(s.outbound || 0, 10),
      missed:           parseInt(s.missed || 0, 10),
      abandonment_rate: parseFloat(s.abandonment_rate || 0),
      avg_wait_time:    parseFloat(s.avg_wait_time || 0),
      avg_talk_time:    parseFloat(s.avg_talk_time || 0),
      sla_percent:      parseFloat(s.sla_percent || 0),
      by_employee:      byEmployee,
      heatmap:          byHour,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// POST /calls/dial — click-to-call
router.post('/calls/dial', requirePerm('calls.dial'), async (req, res) => {
  try {
    const { phone, employee_id, client_id, provider_id } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });

    // Найти провайдера
    let providerRows;
    if (provider_id) {
      providerRows = await q(`SELECT * FROM call_providers WHERE id = $1 AND is_active = true LIMIT 1`, [provider_id]);
    } else {
      providerRows = await q(`SELECT * FROM call_providers WHERE is_active = true ORDER BY is_primary DESC LIMIT 1`);
    }
    const provider = providerRows[0];

    // Инициировать звонок через провайдера (graceful skip если нет настроек)
    let dialResult = { ok: false, reason: 'no_active_provider' };
    if (provider) {
      const ext = employee_id
        ? await q(`SELECT extension_number FROM call_extensions WHERE employee_id = $1 AND is_active = true LIMIT 1`, [employee_id])
        : [];
      dialResult = await dialViaProvider(provider, {
        from: ext[0]?.extension_number || (provider.phone_numbers || [])[0] || '',
        to: phone,
      });
    }

    // Записать звонок в журнал
    const rows = await q(
      `INSERT INTO calls (provider_id, direction, caller_number, called_number, client_id, employee_id, status, started_at)
       VALUES ($1,'outbound',$2,$3,$4,$5,'ringing',NOW())
       RETURNING id, status, direction`,
      [provider ? provider.id : null,
       (provider && provider.phone_numbers && provider.phone_numbers[0]) || req.user?.phone || '',
       phone, client_id || null, employee_id || null]
    );

    logAction({ user: req.user, action: 'call.dial', entity: 'calls', entity_id: rows[0].id, ip: req.ip, meta: { phone, provider_type: provider?.provider_type } });
    res.json({ ok: true, call: rows[0], dial_result: dialResult });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// GET /calls — журнал звонков
router.get('/calls', requirePerm('calls.log.read'), async (req, res) => {
  try {
    const {
      direction, status, client_id, employee_id, branch_id,
      from, to, disposition,
      limit = 50, offset = 0
    } = req.query;

    const params = [];
    const where  = [];

    if (direction)   { params.push(direction);   where.push(`c.direction = $${params.length}`); }
    if (status)      { params.push(status);       where.push(`c.status = $${params.length}`); }
    if (client_id)   { params.push(client_id);    where.push(`c.client_id = $${params.length}`); }
    if (employee_id) { params.push(employee_id);  where.push(`c.employee_id = $${params.length}`); }
    if (branch_id)   { params.push(branch_id);    where.push(`c.branch_id = $${params.length}`); }
    if (disposition) { params.push(disposition);  where.push(`c.disposition = $${params.length}`); }
    if (from)        { params.push(new Date(from).toISOString()); where.push(`c.started_at >= $${params.length}`); }
    if (to)          { params.push(new Date(to).toISOString());   where.push(`c.started_at <= $${params.length}`); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const lim = Math.min(parseInt(limit, 10) || 50, 200);
    const off = parseInt(offset, 10) || 0;

    params.push(lim, off);

    const [rows, totals] = await Promise.all([
      q(
        `SELECT c.*, cp.name AS provider_name, cp.provider_type,
                r.storage_url AS recording_url, r.duration_sec AS recording_duration
           FROM calls c
           LEFT JOIN call_providers cp ON cp.id = c.provider_id
           LEFT JOIN call_recordings r  ON r.id  = c.recording_id
           ${whereClause}
          ORDER BY c.started_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      q(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN direction='inbound' THEN 1 ELSE 0 END) AS inbound,
           SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END) AS outbound,
           SUM(CASE WHEN status='missed' THEN 1 ELSE 0 END) AS missed,
           ROUND(AVG(NULLIF(talk_time_sec,0))::numeric,1) AS avg_talk_time
         FROM calls c ${whereClause}`,
        params.slice(0, params.length - 2)
      ),
    ]);

    const s = totals[0] || {};
    res.json({
      ok: true,
      calls: rows,
      total: parseInt(s.total || 0, 10),
      stats: {
        total:        parseInt(s.total || 0, 10),
        inbound:      parseInt(s.inbound || 0, 10),
        outbound:     parseInt(s.outbound || 0, 10),
        missed:       parseInt(s.missed || 0, 10),
        avg_talk_time: parseFloat(s.avg_talk_time || 0),
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// GET /calls/:id — детали звонка
router.get('/calls/:id', requirePerm('calls.log.read'), async (req, res) => {
  try {
    const rows = await q(
      `SELECT c.*,
              cp.name AS provider_name, cp.provider_type,
              r.storage_url AS recording_url, r.duration_sec AS recording_duration,
              r.transcription, r.ai_summary, r.ai_sentiment, r.transcription_status
         FROM calls c
         LEFT JOIN call_providers cp  ON cp.id = c.provider_id
         LEFT JOIN call_recordings r  ON r.id  = c.recording_id
        WHERE c.id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, call: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// PATCH /calls/:id — обновить disposition/notes
router.patch('/calls/:id', requirePerm('calls.log.read'), async (req, res) => {
  try {
    const { disposition, notes } = req.body;
    const allowed = ['appointment_created','info_request','complaint','callback','spam','other'];
    if (disposition && !allowed.includes(disposition)) {
      return res.status(400).json({ error: 'invalid disposition' });
    }
    const rows = await q(
      `UPDATE calls SET
         disposition = COALESCE($1, disposition),
         notes = COALESCE($2, notes),
         updated_at = NOW()
       WHERE id = $3 RETURNING id, disposition, notes`,
      [disposition || null, notes || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    logAction({ user: req.user, action: 'call.update', entity: 'calls', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true, call: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ЗАПИСИ РАЗГОВОРОВ
// ─────────────────────────────────────────────────────────────────────────────

// GET /recordings — список записей
router.get('/recordings', requirePerm('calls.recordings.listen'), async (req, res) => {
  try {
    const { call_id, client_id, from, to, transcription_status, limit = 50, offset = 0 } = req.query;
    const params = [];
    const where  = [];

    if (call_id)              { params.push(call_id);   where.push(`r.call_uuid = $${params.length}`); }
    if (transcription_status) { params.push(transcription_status); where.push(`r.transcription_status = $${params.length}`); }
    if (from) { params.push(new Date(from).toISOString()); where.push(`r.created_at >= $${params.length}`); }
    if (to)   { params.push(new Date(to).toISOString());   where.push(`r.created_at <= $${params.length}`); }
    if (client_id) { params.push(client_id); where.push(`c.client_id = $${params.length}`); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const lim = Math.min(parseInt(limit, 10) || 50, 200);
    const off = parseInt(offset, 10) || 0;
    params.push(lim, off);

    const rows = await q(
      `SELECT r.id, r.call_uuid, r.storage_type, r.duration_sec, r.format,
              r.transcription_status, r.ai_sentiment, r.ai_summary, r.created_at,
              c.caller_number, c.direction, c.started_at, c.employee_id, c.client_id
         FROM call_recordings r
         LEFT JOIN calls c ON c.id = r.call_uuid
         ${whereClause}
        ORDER BY r.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ ok: true, recordings: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// GET /recordings/:id — детали + URL записи
router.get('/recordings/:id', requirePerm('calls.recordings.listen'), async (req, res) => {
  try {
    const rows = await q(
      `SELECT r.*, c.caller_number, c.direction, c.employee_id, c.client_id, c.started_at
         FROM call_recordings r
         LEFT JOIN calls c ON c.id = r.call_uuid
        WHERE r.id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    // Не раскрываем URL напрямую в теле — только редирект (download требует другого права)
    const row = { ...rows[0] };
    if (row.storage_url) {
      // Возвращаем redirect URL только тем, кто может скачивать
      row.recording_url = row.storage_url;
      delete row.storage_url;
    }
    res.json({ ok: true, recording: row });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// IVR-МЕНЮ
// ─────────────────────────────────────────────────────────────────────────────

// GET /ivr
router.get('/ivr', requirePerm('calls.log.read'), async (req, res) => {
  try {
    const rows = await q(
      `SELECT id, name, description, schedule_type, is_active, is_default,
              stats_entered, stats_completed, stats_abandoned, created_at, updated_at
         FROM ivr_menus ORDER BY is_default DESC, is_active DESC, name ASC`
    );
    res.json({ ok: true, menus: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// POST /ivr
router.post('/ivr', requirePerm('calls.ivr.write'), async (req, res) => {
  try {
    const { name, description, tree = {}, audio_files = {}, tts_texts = {}, schedule_type = 'always', schedule_config = {}, is_default, provider_id } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const rows = await q(
      `INSERT INTO ivr_menus (provider_id, name, description, tree, audio_files, tts_texts, schedule_type, schedule_config, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, name, is_active, is_default`,
      [provider_id || null, name, description || null,
       JSON.stringify(tree), JSON.stringify(audio_files), JSON.stringify(tts_texts),
       schedule_type, JSON.stringify(schedule_config), !!is_default]
    );
    logAction({ user: req.user, action: 'ivr.create', entity: 'ivr_menus', entity_id: rows[0].id, ip: req.ip });
    res.json({ ok: true, menu: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// PUT /ivr/:id
router.put('/ivr/:id', requirePerm('calls.ivr.write'), async (req, res) => {
  try {
    const { name, description, tree, audio_files, tts_texts, schedule_type, schedule_config, is_active, is_default } = req.body;
    const rows = await q(
      `UPDATE ivr_menus SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         tree = COALESCE($3::jsonb, tree),
         audio_files = COALESCE($4::jsonb, audio_files),
         tts_texts = COALESCE($5::jsonb, tts_texts),
         schedule_type = COALESCE($6, schedule_type),
         schedule_config = COALESCE($7::jsonb, schedule_config),
         is_active = COALESCE($8, is_active),
         is_default = COALESCE($9, is_default),
         updated_at = NOW()
       WHERE id = $10
       RETURNING id, name, is_active, is_default, updated_at`,
      [name || null, description || null,
       tree ? JSON.stringify(tree) : null,
       audio_files ? JSON.stringify(audio_files) : null,
       tts_texts ? JSON.stringify(tts_texts) : null,
       schedule_type || null,
       schedule_config ? JSON.stringify(schedule_config) : null,
       is_active ?? null, is_default ?? null,
       req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    logAction({ user: req.user, action: 'ivr.update', entity: 'ivr_menus', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true, menu: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// DELETE /ivr/:id
router.delete('/ivr/:id', requirePerm('calls.ivr.write'), async (req, res) => {
  try {
    const rows = await q(`UPDATE ivr_menus SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    logAction({ user: req.user, action: 'ivr.delete', entity: 'ivr_menus', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CALLBACK-ЗАЯВКИ
// ─────────────────────────────────────────────────────────────────────────────

// GET /callback
router.get('/callback', requirePerm('calls.callback.read'), async (req, res) => {
  try {
    const { status, assigned_to, from, to, limit = 50, offset = 0 } = req.query;
    const params = [];
    const where  = [];

    if (status)      { params.push(status);      where.push(`status = $${params.length}`); }
    if (assigned_to) { params.push(assigned_to); where.push(`assigned_to = $${params.length}`); }
    if (from) { params.push(new Date(from).toISOString()); where.push(`created_at >= $${params.length}`); }
    if (to)   { params.push(new Date(to).toISOString());   where.push(`created_at <= $${params.length}`); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const lim = Math.min(parseInt(limit, 10) || 50, 200);
    const off = parseInt(offset, 10) || 0;
    params.push(lim, off);

    const rows = await q(
      `SELECT * FROM callback_requests
       ${whereClause}
       ORDER BY priority DESC, call_back_before ASC NULLS LAST, created_at ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ ok: true, callbacks: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// POST /callback — создать заявку
router.post('/callback', requirePerm('calls.callback.write'), async (req, res) => {
  try {
    const { phone, name, client_id, source = 'manual', preferred_time, priority = 0, notes } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const rows = await q(
      `INSERT INTO callback_requests (phone, name, client_id, source, priority, preferred_time, notes, call_back_before)
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + INTERVAL '2 hours')
       RETURNING *`,
      [phone, name || null, client_id || null, source, parseInt(priority, 10) || 0,
       preferred_time || null, notes || null]
    );
    logAction({ user: req.user, action: 'callback.create', entity: 'callback_requests', entity_id: rows[0].id, ip: req.ip });
    res.json({ ok: true, callback: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// PATCH /callback/:id — обновить статус/оператора/заметки
router.patch('/callback/:id', requirePerm('calls.callback.write'), async (req, res) => {
  try {
    const { status, assigned_to, notes } = req.body;
    const validStatuses = ['new','in_progress','called','answered','missed','cancelled'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    const rows = await q(
      `UPDATE callback_requests SET
         status = COALESCE($1, status),
         assigned_to = COALESCE($2, assigned_to),
         notes = COALESCE($3, notes),
         updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [status || null, assigned_to || null, notes || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    logAction({ user: req.user, action: 'callback.update', entity: 'callback_requests', entity_id: req.params.id, ip: req.ip, meta: { status } });
    res.json({ ok: true, callback: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// POST /callback/:id/dial — инициировать перезвон по заявке
router.post('/callback/:id/dial', requirePerm('calls.callback.write'), async (req, res) => {
  try {
    const cbRows = await q(`SELECT * FROM callback_requests WHERE id = $1 LIMIT 1`, [req.params.id]);
    if (!cbRows[0]) return res.status(404).json({ error: 'not_found' });
    const cb = cbRows[0];

    if (cb.attempts >= cb.max_attempts) {
      return res.status(409).json({ error: 'max_attempts_reached', attempts: cb.attempts });
    }

    // Найти провайдера
    const provider = await getActiveProvider(cb.tenant_id, null);

    // Создать звонок
    const callRows = await q(
      `INSERT INTO calls (provider_id, direction, caller_number, called_number, client_id, status, started_at, callback_request_id)
       VALUES ($1,'outbound',$2,$3,$4,'ringing',NOW(),$5) RETURNING id`,
      [provider ? provider.id : null,
       (provider && provider.phone_numbers && provider.phone_numbers[0]) || '',
       cb.phone, cb.client_id || null, cb.id]
    );

    // Обновить счётчик попыток
    await q(
      `UPDATE callback_requests SET
         attempts = attempts + 1, last_attempt_at = NOW(),
         status = 'in_progress', call_uuid = $1, updated_at = NOW()
       WHERE id = $2`,
      [callRows[0].id, cb.id]
    );

    // Позвонить через провайдера (graceful skip)
    let dialResult = { ok: false, reason: 'no_active_provider' };
    if (provider) {
      dialResult = await dialViaProvider(provider, {
        from: (provider.phone_numbers || [])[0] || '',
        to: cb.phone,
      });
    }

    logAction({ user: req.user, action: 'callback.dial', entity: 'callback_requests', entity_id: cb.id, ip: req.ip });
    res.json({ ok: true, call_id: callRows[0].id, dial_result: dialResult });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ЧЁРНЫЙ СПИСОК
// ─────────────────────────────────────────────────────────────────────────────

// GET /blacklist
router.get('/blacklist', requirePerm('calls.blacklist.write'), async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM call_blacklist ORDER BY created_at DESC LIMIT 500`);
    res.json({ ok: true, blacklist: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// POST /blacklist
router.post('/blacklist', requirePerm('calls.blacklist.write'), async (req, res) => {
  try {
    const { phone, reason } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const rows = await q(
      `INSERT INTO call_blacklist (phone, reason, added_by) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, phone) DO UPDATE SET reason = EXCLUDED.reason, updated_at = NOW()
       RETURNING id, phone, reason`,
      [normalizePhone(phone), reason || null, req.user?.id || null]
    );
    logAction({ user: req.user, action: 'blacklist.add', entity: 'call_blacklist', entity_id: rows[0].id, ip: req.ip, meta: { phone } });
    res.json({ ok: true, entry: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

// DELETE /blacklist/:id
router.delete('/blacklist/:id', requirePerm('calls.blacklist.write'), async (req, res) => {
  try {
    const rows = await q(`DELETE FROM call_blacklist WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    logAction({ user: req.user, action: 'blacklist.remove', entity: 'call_blacklist', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  }
});

module.exports = router;
