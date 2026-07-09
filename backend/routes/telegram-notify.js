/* ═══════════════════════════════════════════════════════
   SVS Beauty World — Telegram Notify
   Отправляет уведомление клиенту через Telegram-бот
   когда меняется статус его заказа.

   ENV:
     TELEGRAM_NOTIFY_TOKEN — токен бота (используем существующий)
     ADMIN_TG_CHAT — chat_id админа (Босса) для алертов о новых заказах

   POST /api/notify/order/:id  (admin) → push клиенту по telegram_id
   POST /api/notify/test       (admin) → тест отправки на ADMIN_TG_CHAT
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const https = require('https');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');

function getBotToken() {
  return process.env.TELEGRAM_NOTIFY_TOKEN
    || process.env.TELEGRAM_BOT_TOKEN
    || null;
}

// Обгортка з retry: 429 (rate limit)/5xx/таймаут → повтор із backoff,
// щоб не втрачати сповіщення клієнту/адміну про замовлення й оплату.
function tgSend(chatId, text, opts = {}) {
  return require('../lib/retry').withRetry(() => _tgSendOnce(chatId, text, opts), { label: 'telegram', tries: 3, baseDelay: 600 });
}
function _tgSendOnce(chatId, text, opts = {}) {
  return new Promise((resolve, reject) => {
    const token = getBotToken();
    if (!token) return reject(new Error('no-bot-token'));
    const data = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...opts,
    });
    const req = https.request({
      method: 'POST',
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(buf);
          if (!parsed.ok) {
            const err = new Error(parsed.description || 'tg-error');
            err.statusCode = parsed.error_code || res.statusCode; // 429/5xx → retry спрацює
            return reject(err);
          }
          resolve(parsed.result);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('timeout 15s')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// человекочитаемые сообщения по статусам
const STATUS_TEXTS = {
  new: (id) => `<b>Замовлення №${id}</b> прийнято. Чекаємо оплату через Mono.`,
  paid: (id) => `<b>Замовлення №${id}</b> оплачено! Передаємо в роботу — пакуємо.`,
  packing: (id) => `<b>Замовлення №${id}</b> пакується. Скоро відправимо.`,
  shipped: (id, ttn) => `<b>Замовлення №${id}</b> відправлено${ttn ? ' (ТТН: ' + ttn + ')' : ''}.`,
  delivered: (id) => `<b>Замовлення №${id}</b> доставлено. Дякуємо за покупку!`,
  cancelled: (id) => `<b>Замовлення №${id}</b> скасовано. Кошти повернемо протягом 1-3 днів якщо була оплата.`,
  refunded: (id) => `<b>Замовлення №${id}</b> — гроші повернуто.`,
};

async function notifyOrderStatus(orderId, newStatus, ttn) {
  const pool = getPool();
  const r = await pool.query(
    `SELECT o.id, c.telegram_id, c.phone, c.name
     FROM orders o LEFT JOIN clients c ON c.id = o.client_id
     WHERE o.id = $1`,
    [orderId]
  );
  if (!r.rowCount) throw new Error('order-not-found');
  const row = r.rows[0];
  if (!row.telegram_id) return { ok: false, reason: 'no-telegram-id' };

  const text = (STATUS_TEXTS[newStatus] || ((id) => `Статус замовлення №${id} змінено: ${newStatus}`))(orderId, ttn);
  try {
    await tgSend(row.telegram_id, text);
    return { ok: true, chat_id: row.telegram_id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function notifyAdminNewOrder(orderId) {
  const chat = process.env.ADMIN_TG_CHAT;
  if (!chat) return { ok: false, reason: 'no-admin-chat' };
  const pool = getPool();
  const r = await pool.query(
    `SELECT o.id, o.total, o.delivery_type, o.notes, o.created_at,
            c.name, c.phone, c.email,
            COALESCE(json_agg(json_build_object('name', oi.product_name, 'qty', oi.qty, 'price', oi.unit_price))
                     FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
     FROM orders o
     LEFT JOIN clients c ON c.id = o.client_id
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.id = $1
     GROUP BY o.id, c.name, c.phone, c.email`,
    [orderId]
  );
  if (!r.rowCount) return { ok: false, reason: 'order-not-found' };
  const o = r.rows[0];
  const items = (o.items || []).map(i => `• ${i.name} ×${i.qty} = ${Math.round(i.price * i.qty)} грн`).join('\n');
  const text =
    `🛒 <b>Новий заказ №${o.id}</b>\n` +
    `Клієнт: ${o.name || '—'}\n` +
    `Телефон: ${o.phone || '—'}\n` +
    (o.email ? `Email: ${o.email}\n` : '') +
    `Доставка: ${o.delivery_type || 'pickup'}\n` +
    (o.notes ? `Коментар: ${o.notes}\n` : '') +
    `\n<b>Сума: ${Math.round(o.total)} грн</b>\n\n` +
    items;
  try {
    await tgSend(chat, text);
    return { ok: true };
  } catch (e) {
    console.error('[notify-admin]', e.message);
    return { ok: false, error: e.message };
  }
}

router.post('/order/:id', requirePerm('notify.write'), async (req, res) => {
  try {
    const result = await notifyOrderStatus(parseInt(req.params.id, 10), req.body?.status, req.body?.ttn);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'internal', ...(process.env.NODE_ENV !== "production" && { detail: e.message }) });
  }
});

router.post('/test', requirePerm('notify.write'), async (req, res) => {
  try {
    const chat = req.body?.chat_id || process.env.ADMIN_TG_CHAT;
    if (!chat) return res.status(400).json({ error: 'no-chat-id' });
    const result = await tgSend(chat, '<b>SVS Shop API</b>\nТест відправки повідомлення.');
    res.json({ ok: true, result });
  } catch (e) {
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    bot_token: !!getBotToken(),
    admin_chat: !!process.env.ADMIN_TG_CHAT,
  });
});

module.exports = router;
module.exports.notifyOrderStatus = notifyOrderStatus;
module.exports.notifyAdminNewOrder = notifyAdminNewOrder;
module.exports.tgSend = tgSend;
