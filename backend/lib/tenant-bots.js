/*
 * SAS этап 1 (05.07): личные Telegram-боты салонов для онлайн-записи.
 *
 * Каждый салон подключает СВОЕГО бота (токен от BotFather) через
 * /api/bot-connect — токен хранится в tenant_bot_settings, вебхук
 * регистрируется автоматически на /api/booking/telegram/t/:slug.
 *
 * Салон Босса (DEFAULT_TENANT) работает как раньше: env TELEGRAM_BOT_TOKEN —
 * fallback, если своя запись в БД не создана. Ничего не ломаем.
 */
const { getPool } = require('../db-pg');
const { DEFAULT_TENANT_ID } = require('./tenant');

const CACHE_TTL = 60 * 1000;
const cache = new Map(); // tenantId → { bot|null, at }

/**
 * Бот тенанта: { token, username, secret, salonName, source: 'db'|'env' } | null.
 * Вызывать внутри tenant-контекста (runAs / tenantMiddleware) — RLS сама
 * отрежет чужие строки; политика COALESCE без контекста тоже безопасна,
 * т.к. фильтруем по tenant_id явно.
 */
async function getBotForTenant(tenantId) {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.bot;
  let bot = null;
  try {
    const r = await getPool().query(
      `SELECT s.bot_token, s.bot_username, s.webhook_secret, s.status, t.name AS salon_name
         FROM tenant_bot_settings s JOIN tenants t ON t.id = s.tenant_id
        WHERE s.tenant_id = $1`, [tenantId]);
    if (r.rowCount && r.rows[0].status === 'connected') {
      bot = {
        token: r.rows[0].bot_token,
        username: r.rows[0].bot_username,
        secret: r.rows[0].webhook_secret,
        salonName: r.rows[0].salon_name,
        source: 'db',
      };
    }
  } catch (e) { console.error('[tenant-bots] load failed:', e.message); }
  if (!bot && tenantId === DEFAULT_TENANT_ID && process.env.TELEGRAM_BOT_TOKEN) {
    bot = {
      token: process.env.TELEGRAM_BOT_TOKEN,
      username: process.env.TELEGRAM_BOT_USERNAME || 'Svs_beautybot',
      secret: null,
      salonName: 'SVS Beauty Space',
      source: 'env',
    };
  }
  cache.set(tenantId, { bot, at: Date.now() });
  return bot;
}

function invalidateBot(tenantId) { cache.delete(tenantId); }

/** Одноразовый вызов Telegram Bot API (getMe / setWebhook / deleteWebhook). */
async function tgCall(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15000),
  });
  return r.json();
}

/** Всі підключені боти салонів (для кронів: нагадування). Поза tenant-контекстом
 *  політика RLS COALESCE показує всі рядки — це навмисно для крона. */
async function listConnectedBots(pool) {
  const r = await (pool || getPool()).query(
    `SELECT tenant_id, bot_token FROM tenant_bot_settings WHERE status = 'connected'`);
  return r.rows;
}

module.exports = { getBotForTenant, invalidateBot, tgCall, listConnectedBots };
