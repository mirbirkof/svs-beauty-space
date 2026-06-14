/* ═══════════════════════════════════════════════════════
   COM-02 — SMS-канал (Twilio)

   Адаптер для Notification Hub. Включается автоматически, если заданы
   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN и отправитель
   (TWILIO_FROM — номер вида +1..., либо TWILIO_MESSAGING_SERVICE_SID).

   SMS — простой текст: HTML-теги вырезаются, длина ограничивается.
   ═══════════════════════════════════════════════════════ */
let client = null;

function isConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    && (process.env.TWILIO_FROM || process.env.TWILIO_MESSAGING_SERVICE_SID));
}

function getClient() {
  if (client) return client;
  const twilio = require('twilio');
  client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client;
}

// HTML → plain text для SMS
function toPlain(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 480); // до ~3 SMS-сегментов
}

// to — телефон в формате E.164 (+380...). Если без +, считаем украинский.
function normalizePhone(to) {
  let p = String(to || '').replace(/[^\d+]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) return p;
  if (p.startsWith('380')) return '+' + p;
  if (p.startsWith('0')) return '+38' + p;
  return '+' + p;
}

async function send(to, { body }) {
  if (!isConfigured()) throw new Error('channel-sms-not-configured');
  const phone = normalizePhone(to);
  if (!phone) throw new Error('sms-bad-phone');
  const msg = {
    to: phone,
    body: toPlain(body),
  };
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) msg.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  else msg.from = process.env.TWILIO_FROM;
  const res = await getClient().messages.create(msg);
  return { providerId: res.sid };
}

module.exports = { send, isConfigured, toPlain, normalizePhone };
