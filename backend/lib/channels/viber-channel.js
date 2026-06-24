/* ═══════════════════════════════════════════════════════
   COM-06 — Viber-канал (Viber REST API / Business Messages)

   Адаптер для Notification Hub. Включается автоматически,
   если задан VIBER_AUTH_TOKEN (токен Viber PA / Business Account).

   При отсутствии токена — gracefully возвращает {skipped:true}
   и НЕ выбрасывает ошибку, чтобы Hub продолжил fallback-цепочку.

   Поддерживаемые типы сообщений:
     text        — plain/HTML до 7000 символов
     picture     — изображение с опциональным текстом
     video       — видео (URL + thumbnail)
     file        — файл (URL + filename)
     contact     — визитка (name + phone_number)
     location    — геолокация (lat + lon)
     sticker     — стикер (sticker_id)
     rich_media  — карусель / карточки с кнопками

   keyboard — объект Viber KeyboardObject (опциональный, для любого типа).

   ENV:
     VIBER_AUTH_TOKEN  — токен Viber Business Account / PA
     VIBER_SENDER_NAME — имя отправителя (макс 28 символов)
     VIBER_SENDER_AVATAR — URL аватара отправителя
   ═══════════════════════════════════════════════════════ */
const https = require('https');

const VIBER_API = 'chatapi.viber.com';
const VIBER_PATH = '/pa';

// ── Конфигурация ─────────────────────────────────────────────────────
function isConfigured() {
  return !!process.env.VIBER_AUTH_TOKEN;
}

function getSender() {
  return {
    name: (process.env.VIBER_SENDER_NAME || 'SVS Beauty').slice(0, 28),
    avatar: process.env.VIBER_SENDER_AVATAR || '',
  };
}

// ── HTTP helper ───────────────────────────────────────────────────────
function viberPost(endpoint, payload) {
  return new Promise((resolve, reject) => {
    const token = process.env.VIBER_AUTH_TOKEN;
    if (!token) {
      return resolve({ skipped: true, reason: 'no-token' });
    }
    const data = JSON.stringify(payload);
    const req = https.request(
      {
        method: 'POST',
        hostname: VIBER_API,
        path: `${VIBER_PATH}/${endpoint}`,
        headers: {
          'X-Viber-Auth-Token': token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(buf || '{}');
            // Viber API: status 0 = OK
            if (parsed.status === 0) return resolve(parsed);
            reject(
              new Error(
                `viber-api-${parsed.status}: ${parsed.status_message || 'unknown'}`
              )
            );
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.setTimeout(15000, () => req.destroy(new Error('viber-timeout-15s')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Отправка сообщения конкретному пользователю (по viber_user_id) ───
// msg: { type, content, keyboard, priority }
// Возвращает { providerId } при успехе или { skipped, reason } при отсутствии токена.
async function sendMessage(viberUserId, msg = {}) {
  if (!isConfigured()) return { skipped: true, reason: 'no-token' };

  const { type = 'text', content = {}, keyboard, priority = 1 } = msg;
  const sender = getSender();

  // Базовый payload
  const payload = {
    receiver: viberUserId,
    min_api_version: 1,
    sender,
    tracking_data: msg.tracking_data || null,
    type,
  };

  // Приоритет: 0=regular, 1=high (transactional)
  if (priority) payload.min_api_version = 7;

  // Клавиатура (кнопки в нижней части экрана)
  if (keyboard && keyboard.Buttons) {
    payload.keyboard = {
      Type: 'keyboard',
      DefaultHeight: keyboard.DefaultHeight || false,
      Buttons: keyboard.Buttons,
    };
  }

  // Тип-специфичные поля
  switch (type) {
    case 'text':
      payload.text = String(content.text || '').slice(0, 7000);
      break;

    case 'picture':
      payload.text = String(content.text || '').slice(0, 768);
      payload.media = content.media_url || content.url;
      if (content.thumbnail) payload.thumbnail = content.thumbnail;
      break;

    case 'video':
      payload.media = content.media_url || content.url;
      payload.size = content.size || 0;
      if (content.thumbnail) payload.thumbnail = content.thumbnail;
      if (content.duration) payload.duration = content.duration;
      if (content.text) payload.text = String(content.text).slice(0, 128);
      break;

    case 'file':
      payload.media = content.media_url || content.url;
      payload.size = content.size || 0;
      payload.file_name = content.file_name || 'file';
      break;

    case 'contact':
      payload.contact = {
        name: content.name || '',
        phone_number: content.phone_number || '',
      };
      break;

    case 'location':
      payload.location = {
        lat: content.lat,
        lon: content.lon,
      };
      break;

    case 'sticker':
      payload.sticker_id = content.sticker_id;
      break;

    case 'rich_media':
      payload.min_api_version = 7;
      payload.rich_media = buildRichMedia(content);
      break;

    default:
      payload.type = 'text';
      payload.text = String(content.text || content.body || '').slice(0, 7000);
  }

  const result = await viberPost('send_message', payload);
  if (result.skipped) return result;
  return { providerId: result.message_token ? String(result.message_token) : null };
}

// ── Rich Media (карусели / карточки с кнопками) ───────────────────────
// content.cards — массив до 6 карточек:
// { title, description, image_url, buttons: [{text, action_type, action_body}] }
function buildRichMedia(content) {
  const cards = Array.isArray(content.cards) ? content.cards.slice(0, 6) : [];
  const ButtonsGroupColumns = content.columns || 6;
  const ButtonsGroupRows = content.rows || 7;

  const buttons = [];
  for (const card of cards) {
    // Картинка карточки
    if (card.image_url) {
      buttons.push({
        Columns: ButtonsGroupColumns,
        Rows: 3,
        ActionType: 'none',
        Image: card.image_url,
      });
    }
    // Заголовок
    if (card.title) {
      buttons.push({
        Columns: ButtonsGroupColumns,
        Rows: 1,
        ActionType: 'none',
        Text: `<font size="14"><b>${card.title}</b></font>`,
        TextSize: 'medium',
        TextHAlign: 'left',
        TextVAlign: 'middle',
      });
    }
    // Описание
    if (card.description) {
      buttons.push({
        Columns: ButtonsGroupColumns,
        Rows: 2,
        ActionType: 'none',
        Text: card.description,
        TextSize: 'small',
        TextHAlign: 'left',
        TextVAlign: 'top',
      });
    }
    // Кнопки карточки
    const cardButtons = Array.isArray(card.buttons) ? card.buttons : [];
    for (const btn of cardButtons) {
      buttons.push({
        Columns: ButtonsGroupColumns / (cardButtons.length || 1),
        Rows: 1,
        ActionType: btn.action_type || 'open-url', // reply|open-url|share-phone|share-location
        ActionBody: btn.action_body || '',
        Text: btn.text || '',
        TextSize: 'small',
        BgColor: btn.bg_color || '#2db4ff',
        TextColor: btn.text_color || '#ffffff',
      });
    }
  }

  return {
    Type: 'rich_media',
    ButtonsGroupColumns,
    ButtonsGroupRows,
    BgColor: content.bg_color || '#ffffff',
    Buttons: buttons,
  };
}

// ── Установка webhook (вызывается при сохранении конфига) ─────────────
async function setWebhook(webhookUrl, eventTypes) {
  if (!isConfigured()) return { skipped: true, reason: 'no-token' };
  const payload = {
    url: webhookUrl,
    event_types: eventTypes || [
      'delivered',
      'seen',
      'failed',
      'subscribed',
      'unsubscribed',
      'conversation_started',
    ],
    send_name: true,
    send_photo: true,
  };
  return viberPost('set_webhook', payload);
}

// ── Получение информации об аккаунте бота ────────────────────────────
async function getAccountInfo() {
  if (!isConfigured()) return { skipped: true, reason: 'no-token' };
  return viberPost('get_account_info', {});
}

// ── Получение информации о подписчике ────────────────────────────────
async function getUserDetails(viberUserId) {
  if (!isConfigured()) return { skipped: true, reason: 'no-token' };
  return viberPost('get_user_details', { id: viberUserId });
}

// ── Broadcast (рассылка) — отправка одного сообщения нескольким ───────
// viberUserIds — массив до 300 ID (ограничение Viber API)
async function broadcast(viberUserIds, msg = {}) {
  if (!isConfigured()) return { skipped: true, reason: 'no-token' };
  if (!Array.isArray(viberUserIds) || !viberUserIds.length) {
    return { skipped: true, reason: 'empty-audience' };
  }

  const { type = 'text', content = {}, keyboard } = msg;
  const sender = getSender();

  const payload = {
    broadcast_list: viberUserIds.slice(0, 300),
    min_api_version: 1,
    sender,
    type,
  };

  if (keyboard && keyboard.Buttons) {
    payload.keyboard = {
      Type: 'keyboard',
      DefaultHeight: keyboard.DefaultHeight || false,
      Buttons: keyboard.Buttons,
    };
  }

  switch (type) {
    case 'text':
      payload.text = String(content.text || '').slice(0, 7000);
      break;
    case 'picture':
      payload.text = String(content.text || '').slice(0, 768);
      payload.media = content.media_url || content.url;
      if (content.thumbnail) payload.thumbnail = content.thumbnail;
      break;
    case 'rich_media':
      payload.min_api_version = 7;
      payload.rich_media = buildRichMedia(content);
      break;
    default:
      payload.type = 'text';
      payload.text = String(content.text || content.body || '').slice(0, 7000);
  }

  const result = await viberPost('broadcast_message', payload);
  if (result.skipped) return result;
  // result.status_message = массив {receiver, status, status_message}
  return {
    providerId: result.message_token ? String(result.message_token) : null,
    details: result.status_message || [],
  };
}

// ── Адаптер для Notification Hub (hub.registerChannel) ───────────────
// to = viber_user_id, msg = { body, subject? }
async function hubAdapter(to, { body }) {
  if (!isConfigured()) return { skipped: true, reason: 'no-token' };
  return sendMessage(to, { type: 'text', content: { text: body } });
}

module.exports = {
  isConfigured,
  sendMessage,
  broadcast,
  setWebhook,
  getAccountInfo,
  getUserDetails,
  buildRichMedia,
  hubAdapter,
  // для регистрации в Hub: hub.registerChannel('viber', viberChannel.hubAdapter)
};
