/* lib/signup-verify.js — верификация телефона при регистрации через Telegram (Босс 16.07.2026).
 * Бесплатно: используем request_contact платформенного бота (@Svs_beautybot).
 * Поток: createPending → юзер /start sv_<token> в боте → делится контактом →
 * сверяем номер → finalizeSignup (создаём тенант). Веб поллит getStatus.
 */
const crypto = require('crypto');
const { getPool } = require('../db-pg');
const { finalizeSignup } = require('./signup-finalize');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '';
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || 'Svs_beautybot').replace(/^@/, '');
const onlyDigits = s => String(s || '').replace(/\D/g, '');

async function tg(method, payload) {
  if (!BOT_TOKEN) return { ok: false, error: 'no-bot-token' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    return await r.json();
  } catch (e) { return { ok: false, error: e.message }; }
}

// 1) Заявка на регистрацию (данные валидированы вызывающим). Пароль уже захеширован.
async function createPending(fields) {
  const token = 'sv_' + crypto.randomBytes(18).toString('base64url');
  await getPool().query(
    `INSERT INTO pending_signups
       (token, phone, salon_name, owner_name, email, password_hash, account_type,
        plan_code, cycle, country, lang, ref_code, consent, consent_ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [token, fields.phone, fields.salonName, fields.ownerName, fields.email, fields.password_hash,
     fields.accountType, fields.planCode, fields.cycle, fields.country, fields.lang,
     fields.refCode || null, !!fields.consent, fields.consentIp || null]);
  return { token, deeplink: `https://t.me/${BOT_USERNAME}?start=${token}`, bot_username: BOT_USERNAME };
}

// 2) Бот: /start sv_<token> — привязываем чат и просим поделиться номером.
async function onStartVerify(token, chatId, userId) {
  const p = (await getPool().query(
    `SELECT * FROM pending_signups WHERE token=$1 AND verified=false AND tenant_id IS NULL AND expires_at > now()`, [token])).rows[0];
  if (!p) {
    await tg('sendMessage', { chat_id: chatId, text: '⏳ Заявка не знайдена або застаріла. Поверніться на сайт і почніть реєстрацію знову.' });
    return false;
  }
  await getPool().query(`UPDATE pending_signups SET tg_chat_id=$2, tg_user_id=$3 WHERE token=$1`, [token, chatId, userId]);
  await tg('sendMessage', {
    chat_id: chatId,
    text: `👋 Вітаємо у SVS Beauty Space!\nЩоб підтвердити реєстрацію салону «${p.salon_name}», поділіться своїм номером телефону — натисніть кнопку нижче. Це безкоштовно і потрібно один раз.`,
    reply_markup: { keyboard: [[{ text: '📱 Підтвердити номер', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
  });
  return true;
}

// 3) Бот: пришёл контакт — сверяем и финализируем.
async function onContactVerify(chatId, contact, fromUserId) {
  const p = (await getPool().query(
    `SELECT * FROM pending_signups WHERE tg_chat_id=$1 AND verified=false AND tenant_id IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`, [chatId])).rows[0];
  if (!p) return false; // нет активной заявки в этом чате — не наш кейс, пусть обрабатывает бронирование

  // анти-спуф: контакт должен быть СВОИМ (user_id совпадает с отправителем)
  if (contact.user_id && fromUserId && contact.user_id !== fromUserId) {
    await tg('sendMessage', { chat_id: chatId, text: '⚠️ Поділіться, будь ласка, ВЛАСНИМ номером (кнопкою нижче), а не контактом іншої людини.' });
    return true;
  }
  const got = onlyDigits(contact.phone_number);
  const want = onlyDigits(p.phone);
  // совпадение: точное ИЛИ по последним 9 цифрам (на случай разного формата кода страны)
  const match = got === want || (got.length >= 9 && want.length >= 9 && got.slice(-9) === want.slice(-9));
  if (!match) {
    await getPool().query(`UPDATE pending_signups SET attempts = attempts + 1 WHERE token=$1`, [p.token]);
    await tg('sendMessage', {
      chat_id: chatId,
      text: `❌ Номер не збігається з тим, що ви вказали при реєстрації (${p.phone}). Якщо помилились — виправте на сайті й спробуйте ще раз.`,
    });
    return true;
  }

  // Совпал → финализируем (создаём тенант). Идемпотентно: помечаем сразу.
  try {
    const result = await finalizeSignup({
      salonName: p.salon_name, ownerName: p.owner_name, phone: p.phone, password_hash: p.password_hash,
      email: p.email, accountType: p.account_type, planCode: p.plan_code, cycle: p.cycle,
      needTrial: !['solo', 'free'].includes(p.plan_code), country: p.country, lang: p.lang,
      refCode: p.ref_code, consentIp: p.consent_ip,
    });
    await getPool().query(
      `UPDATE pending_signups SET verified=true, verified_phone=$2, tenant_id=$3 WHERE token=$1`,
      [p.token, got, result.tenant_id]);
    await tg('sendMessage', {
      chat_id: chatId,
      text: `✅ Номер підтверджено! Салон «${p.salon_name}» створено.\nПоверніться на сайт — вхід уже доступний. Логін: ваш телефон.`,
      reply_markup: { remove_keyboard: true },
    });
  } catch (e) {
    console.error('[signup-verify/finalize]', e.message);
    await tg('sendMessage', { chat_id: chatId, text: '⚠️ Сталася помилка при створенні салону. Спробуйте ще раз за хвилину або напишіть у підтримку.' });
  }
  return true;
}

// 4) Веб-поллинг статуса заявки.
async function getStatus(token) {
  const p = (await getPool().query(
    `SELECT verified, tenant_id, salon_name, phone, expires_at FROM pending_signups WHERE token=$1`, [token])).rows[0];
  if (!p) return { status: 'not-found' };
  if (p.verified && p.tenant_id) {
    const t = (await getPool().query(`SELECT slug FROM tenants WHERE id=$1`, [p.tenant_id])).rows[0];
    return { status: 'verified', slug: t ? t.slug : null,
      login_url: t ? '/admin/?tenant=' + encodeURIComponent(t.slug) : '/admin/', phone: p.phone };
  }
  if (new Date(p.expires_at) < new Date()) return { status: 'expired' };
  return { status: 'pending' };
}

module.exports = { createPending, onStartVerify, onContactVerify, getStatus, BOT_USERNAME };
