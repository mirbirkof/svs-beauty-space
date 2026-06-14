/* ═══════════════════════════════════════════════════════
   COM-03 — Email-канал (Resend HTTP API, без SDK)

   Адаптер для Notification Hub. Включается автоматически, если заданы
   RESEND_API_KEY и EMAIL_FROM (вида "SVS Beauty <noreply@domain>").

   Тело письма — HTML (как и в Telegram-шаблонах). subject обязателен;
   если не задан — берётся первая строка тела.
   ═══════════════════════════════════════════════════════ */
const https = require('https');

function isConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

function deriveSubject(html) {
  const text = String(html || '').replace(/<[^>]+>/g, '').trim();
  return (text.split('\n')[0] || 'Повідомлення').slice(0, 120);
}

function postResend(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request({
      method: 'POST', hostname: 'api.resend.com', path: '/emails',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(buf || '{}');
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
          reject(new Error(parsed?.message || `resend-http-${res.statusCode}`));
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('timeout 15s')));
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function send(to, { body, subject }) {
  if (!isConfigured()) throw new Error('channel-email-not-configured');
  if (!to || !/.+@.+\..+/.test(to)) throw new Error('email-bad-address');
  const res = await postResend({
    from: process.env.EMAIL_FROM,
    to: [to],
    subject: subject || deriveSubject(body),
    html: String(body || '').replace(/\n/g, '<br>'),
  });
  return { providerId: res?.id || null };
}

module.exports = { send, isConfigured, deriveSubject };
