/* ═══════════════════════════════════════════════════════
   COM-10 — Instagram-канал (Meta Graph API)

   Адаптер для омниканального центра: приём входящих Direct-сообщений
   и комментариев под постами + отправка ответов от имени салона.

   Архитектура подключения (каждый салон подключает СВОЙ Instagram):
   - платформенный уровень (глобальный, env): META_APP_SECRET — подпись
     вебхуков (x-hub-signature-256); META_VERIFY_TOKEN — verify при
     регистрации вебхука у Meta;
   - уровень салона (omni_channels.config, channel='instagram'):
       ig_user_id   — id Instagram-аккаунта (Professional), он же recipient
                      в payload — по нему вебхук находит салон;
       page_id      — связанная FB-страница;
       page_token   — Page Access Token (долгоживущий) для отправки;
       auto_agent   — true → отвечает AI-агент; false → только в инбокс;
       agent_id     — какой AI-агент отвечает (если не задан — активный).

   Meta шлёт ВСЕ вебхуки всех салонов на один URL платформы. Маршрутизация
   к нужному салону — по ig_user_id из payload (см. routes/instagram-webhook).

   Граничное условие go-live (нельзя обойти кодом, нужно от владельца):
   - Meta Business app + Instagram Professional account, связанный с FB Page;
   - права instagram_manage_messages / instagram_basic + App Review;
   - HTTPS-вебхук с verify (hub.challenge) и подписью x-hub-signature-256.
   ═══════════════════════════════════════════════════════ */

const crypto = require('crypto');

const GRAPH = 'https://graph.facebook.com/v21.0';

// ── Проверка вебхука при регистрации у Meta (GET) ──
// Meta дёргает: GET ...?hub.mode=subscribe&hub.verify_token=X&hub.challenge=N
// Возвращаем challenge как plain text, если verify_token совпал.
function verifyChallenge(query, expectedToken) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token && expectedToken && token === expectedToken) {
    return { ok: true, challenge: String(challenge ?? '') };
  }
  return { ok: false };
}

// ── Проверка подписи тела вебхука (x-hub-signature-256) ──
// Meta подписывает RAW-тело: HMAC-SHA256(appSecret, rawBody) → "sha256=<hex>".
// Сравнение в постоянное время. Если appSecret не задан — подпись не проверяем
// (dev), но возвращаем skipped, чтобы маршрут мог решить сам.
function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return { ok: true, skipped: true };
  if (!signatureHeader || !rawBody) return { ok: false };
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret)
    .update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false };
  return { ok: crypto.timingSafeEqual(a, b) };
}

/* ── Нормализация вебхука Meta → плоский список событий ──
   Поддерживаем два типа object:
   - "instagram" (Messaging API, IG-аккаунт напрямую): entry[].messaging[]
   - "page"/"instagram" с changes[] (комментарии): entry[].changes[]
   Каждое событие: {
     ig_user_id,        // аккаунт салона (получатель) — ключ маршрутизации
     type: 'dm'|'comment',
     external_id,       // отправитель (IGSID для DM / commenter id)
     comment_id|null,   // id комментария (для ответа)
     name|null,
     text,
     attachments: [],
     is_echo,           // эхо нашего же исходящего — игнорируем
     raw_ts
   } */
function parseWebhook(body) {
  const events = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];

  for (const entry of entries) {
    // id записи = id IG-аккаунта салона (получателя вебхука)
    const accountId = String(entry.id || '');

    // 1) Direct-сообщения (Messaging API)
    const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const m of messaging) {
      const msg = m.message;
      if (!msg) continue;
      const isEcho = !!msg.is_echo;
      const senderId = String(m.sender?.id || '');
      const recipientId = String(m.recipient?.id || '');
      // получатель салона = тот id, что НЕ отправитель; для входящего recipient=аккаунт
      const igUserId = isEcho ? senderId : (recipientId || accountId);
      const atts = Array.isArray(msg.attachments)
        ? msg.attachments.map(a => ({ type: a.type, url: a.payload?.url })).filter(a => a.url)
        : [];
      events.push({
        ig_user_id: igUserId || accountId,
        type: 'dm',
        external_id: isEcho ? recipientId : senderId,
        comment_id: null,
        message_mid: msg.mid || null,
        name: null,
        text: msg.text || '',
        attachments: atts,
        is_echo: isEcho,
        raw_ts: m.timestamp || null,
      });
    }

    // 2) Комментарии под постами (changes[].field='comments')
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const ch of changes) {
      if (ch.field !== 'comments') continue;
      const v = ch.value || {};
      const fromId = String(v.from?.id || '');
      // не реагируем на собственные комментарии аккаунта
      const isOwn = fromId && fromId === accountId;
      events.push({
        ig_user_id: accountId,
        type: 'comment',
        external_id: fromId,
        comment_id: v.id || null,
        media_id: v.media?.id || v.media_id || null,
        message_mid: null,
        name: v.from?.username || null,
        text: v.text || '',
        attachments: [],
        is_echo: isOwn,
        raw_ts: v.created_time || null,
      });
    }
  }
  return events;
}

// ── Отправка Direct-ответа пользователю (IGSID recipient) ──
async function sendDirect({ ig_user_id, page_token, recipient_id, text }) {
  if (!page_token) return { ok: false, error: 'no_page_token' };
  if (!recipient_id) return { ok: false, error: 'no_recipient' };
  const url = `${GRAPH}/${ig_user_id}/messages?access_token=${encodeURIComponent(page_token)}`;
  const payload = {
    recipient: { id: String(recipient_id) },
    message: { text: String(text || '').slice(0, 1000) },
  };
  return httpPost(url, payload);
}

// ── Ответ на комментарий (создаёт под-комментарий) ──
async function replyComment({ comment_id, page_token, text }) {
  if (!page_token) return { ok: false, error: 'no_page_token' };
  if (!comment_id) return { ok: false, error: 'no_comment_id' };
  const url = `${GRAPH}/${comment_id}/replies?access_token=${encodeURIComponent(page_token)}`;
  return httpPost(url, { message: String(text || '').slice(0, 1000) });
}

async function httpPost(url, payload) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: data?.error?.message || `http_${r.status}`, data };
    return { ok: true, id: data.message_id || data.id || null, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Проверка валидности page_token + получение ig_user_id (для Connect-флоу)
async function probeAccount(page_token) {
  if (!page_token) return { ok: false, error: 'no_page_token' };
  try {
    const r = await fetch(`${GRAPH}/me?fields=id,username,name&access_token=${encodeURIComponent(page_token)}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: data?.error?.message || `http_${r.status}` };
    return { ok: true, id: data.id, username: data.username, name: data.name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  GRAPH,
  verifyChallenge,
  verifySignature,
  parseWebhook,
  sendDirect,
  replyComment,
  probeAccount,
};
