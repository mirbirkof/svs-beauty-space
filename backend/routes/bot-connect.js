/*
 * SAS этап 1: самостоятельное подключение Telegram-бота салона.
 *
 * Флоу для клиента CRM (мастер-одиночка/салон):
 *   1. Создал бота у @BotFather (2 минуты), скопировал токен
 *   2. Вставил токен на странице «ТГ-бот запису» → кнопка «Підключити»
 *   3. Мы сами: проверяем токен (getMe) → регистрируем вебхук (setWebhook
 *      с секретом) → сохраняем. Бот салона сразу принимает онлайн-записи.
 *
 * GET    /api/bot-connect   — статус (какой бот подключён)
 * POST   /api/bot-connect   — подключить { token }
 * DELETE /api/bot-connect   — отключить (deleteWebhook + удалить запись)
 */
const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const { DEFAULT_TENANT_ID } = require('../lib/tenant');
const { invalidateBot, tgCall } = require('../lib/tenant-bots');

const router = express.Router();

function baseUrl(req) {
  return (process.env.RENDER_EXTERNAL_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
}

// ── статус подключения ──────────────────────────────────────────────
router.get('/', requirePerm('integrations.read'), async (req, res) => {
  try {
    const r = await getPool().query(
      `SELECT bot_username, status, connected_at, webhook_url
         FROM tenant_bot_settings WHERE tenant_id = $1`, [req.tenant_id]);
    const row = r.rows[0];
    if (row) {
      return res.json({
        connected: row.status === 'connected',
        source: 'own',
        bot_username: row.bot_username,
        connected_at: row.connected_at,
        webhook_url: row.webhook_url,
      });
    }
    // салон Босса без своей записи → работает бот платформы из env
    const platformBot = req.tenant_id === DEFAULT_TENANT_ID && !!process.env.TELEGRAM_BOT_TOKEN;
    res.json({
      connected: platformBot,
      source: platformBot ? 'platform' : null,
      bot_username: platformBot ? (process.env.TELEGRAM_BOT_USERNAME || 'Svs_beautybot') : null,
      connected_at: null,
      webhook_url: null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── подключить бота ─────────────────────────────────────────────────
router.post('/', requirePerm('integrations.write'), async (req, res) => {
  try {
    const token = String((req.body || {}).token || '').trim();
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,60}$/.test(token)) {
      return res.status(400).json({ error: 'Невірний формат токена. Скопіюйте токен з BotFather повністю — виглядає як 123456789:AAF3k...' });
    }
    // 1) токен живой?
    const me = await tgCall(token, 'getMe').catch((e) => ({ ok: false, description: e.message }));
    if (!me || !me.ok || !me.result) {
      return res.status(400).json({ error: 'Telegram не прийняв токен: ' + ((me && me.description) || 'немає відповіді') + '. Перевірте токен у BotFather.' });
    }
    // 2) адрес вебхука этого салона
    const t = await getPool().query(`SELECT slug FROM tenants WHERE id = $1`, [req.tenant_id]);
    const slug = t.rows[0] && t.rows[0].slug;
    if (!slug) return res.status(500).json({ error: 'У салона не задано slug — зверніться до підтримки' });
    const secret = crypto.randomBytes(24).toString('hex');
    const webhookUrl = baseUrl(req) + '/api/booking/telegram/t/' + encodeURIComponent(slug);
    // 3) регистрируем вебхук
    const wh = await tgCall(token, 'setWebhook', {
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query'],
    }).catch((e) => ({ ok: false, description: e.message }));
    if (!wh || !wh.ok) {
      return res.status(400).json({ error: 'Не вдалося встановити webhook: ' + ((wh && wh.description) || 'немає відповіді') });
    }
    // 4) сохраняем
    await getPool().query(
      `INSERT INTO tenant_bot_settings
        (tenant_id, bot_token, bot_username, bot_name, webhook_secret, webhook_url, status, connected_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'connected',NOW(),NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         bot_token = EXCLUDED.bot_token, bot_username = EXCLUDED.bot_username,
         bot_name = EXCLUDED.bot_name, webhook_secret = EXCLUDED.webhook_secret,
         webhook_url = EXCLUDED.webhook_url, status = 'connected',
         connected_at = NOW(), updated_at = NOW()`,
      [req.tenant_id, token, me.result.username, me.result.first_name || null, secret, webhookUrl]);
    invalidateBot(req.tenant_id);
    res.json({ ok: true, bot_username: me.result.username, deep_link: 'https://t.me/' + me.result.username });
  } catch (e) {
    console.error('[bot-connect]', e.message);
    res.status(500).json({ error: 'Не вдалося підключити бота: ' + e.message });
  }
});

// ── отключить бота ──────────────────────────────────────────────────
router.delete('/', requirePerm('integrations.write'), async (req, res) => {
  try {
    const r = await getPool().query(
      `SELECT bot_token FROM tenant_bot_settings WHERE tenant_id = $1`, [req.tenant_id]);
    if (r.rowCount) {
      try { await tgCall(r.rows[0].bot_token, 'deleteWebhook', {}); } catch (_e) { /* бот мог быть удалён */ }
    }
    await getPool().query(`DELETE FROM tenant_bot_settings WHERE tenant_id = $1`, [req.tenant_id]);
    invalidateBot(req.tenant_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
