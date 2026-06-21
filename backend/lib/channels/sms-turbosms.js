/* ═══════════════════════════════════════════════════════
   COM-02 — SMS-канал (TurboSMS, укр. шлюз)

   Адаптер для Notification Hub. Включается автоматически, если заданы
   TURBOSMS_TOKEN и TURBOSMS_SENDER (альфа-имя, напр. "SVS Beauty").

   Перевага над Twilio для укр. бази: альфа-ім'я відправника, дешевше,
   стабільна доставка на укр. номери без верифікації отримувача.

   API v2: POST https://api.turbosms.ua/message/send.json (Bearer token).
   Телефон для TurboSMS — цифри без "+", формат 380XXXXXXXXX.
   ═══════════════════════════════════════════════════════ */

const API_URL = 'https://api.turbosms.ua/message/send.json';

function isConfigured() {
  return !!(process.env.TURBOSMS_TOKEN && process.env.TURBOSMS_SENDER);
}

// HTML → plain text для SMS (ідентично twilio-адаптеру)
function toPlain(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 480); // до ~3 SMS-сегментів
}

// to — телефон. TurboSMS чекає цифри без "+", напр. 380501234567.
function normalizePhone(to) {
  let p = String(to || '').replace(/\D/g, '');
  if (!p) return null;
  if (p.startsWith('380')) return p;
  if (p.startsWith('0')) return '38' + p;
  if (p.startsWith('80')) return '3' + p;
  return p;
}

async function send(to, { body }) {
  if (!isConfigured()) throw new Error('channel-sms-turbosms-not-configured');
  const phone = normalizePhone(to);
  if (!phone) throw new Error('sms-bad-phone');

  const payload = {
    recipients: [phone],
    sms: { sender: process.env.TURBOSMS_SENDER, text: toPlain(body) },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res, data;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.TURBOSMS_TOKEN,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const txt = await res.text();
  try { data = JSON.parse(txt); } catch { data = null; }
  if (!res.ok) throw new Error('turbosms-http-' + res.status + ':' + txt.slice(0, 200));

  // Формат відповіді: { response_code, response_status, response_result:[{ phone, response_code, response_status, message_id }] }
  const top = data && (data.response_code ?? data.ResponseCode);
  if (top != null && Number(top) !== 0 && Number(top) !== 800 /* 0/800 = OK у різних версіях */) {
    const st = (data && (data.response_status || data.ResponseStatus)) || ('code ' + top);
    throw new Error('turbosms-error:' + st);
  }

  const r0 = data && Array.isArray(data.response_result) ? data.response_result[0] : null;
  const rc = r0 && (r0.response_code ?? r0.ResponseCode);
  if (rc != null && Number(rc) !== 0 && Number(rc) !== 800) {
    throw new Error('turbosms-recipient-error:' + (r0.response_status || ('code ' + rc)));
  }

  return { providerId: (r0 && (r0.message_id || r0.MessageId)) ? String(r0.message_id || r0.MessageId) : null };
}

module.exports = { send, isConfigured, toPlain, normalizePhone };
