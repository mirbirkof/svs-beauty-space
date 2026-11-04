// Харнес бота для test/miniapp-bot-0311.test.js. Запускається ЛИШЕ дочірнім процесом з env від тесту:
// DATABASE_URL = QA, TELEGRAM_BOT_TOKEN = '' (цикл нагадувань routes/booking.js НЕ стартує), без dotenv.
// Telegram підмінено заглушкою: всі виклики збираються й віддаються JSON-ом у stdout (рядок RESULT=...).
// Токени й telegram_id власника не друкуються — лише прапорці.
if (!process.env.DATABASE_URL || process.env.DATABASE_URL !== process.env.QA_DB_URL) { console.error('harness: лише QA'); process.exit(2); }
if (process.env.TELEGRAM_BOT_TOKEN) { console.error('harness: токен бота має бути порожнім'); process.exit(2); }
const { processUpdate } = require('../routes/booking');
const { getPool } = require('../db-pg');

const UID = Number(process.env.HARNESS_UID);
const hasWebApp = (rm) => JSON.stringify(rm || {}).includes('"web_app"');
const replyKbTexts = (rm) => (rm && Array.isArray(rm.keyboard)) ? rm.keyboard.flat().map(b => (typeof b === 'string' ? b : b.text)) : [];

async function run(text, fromId, miniapp) {
  const calls = [];
  const tg = async (method, body) => { calls.push({ method, body }); return { ok: true, result: { message_id: 1 } }; };
  const upd = { update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000), text,
    chat: { id: fromId, type: 'private' }, from: { id: fromId, is_bot: false, first_name: 'QA бот' } } };
  await processUpdate(upd, tg, { name: 'SVS Beauty Space', miniapp });
  const msgs = calls.filter(c => c.method === 'sendMessage');
  return {
    n: msgs.length,
    webApp: msgs.some(m => hasWebApp(m.body.reply_markup)),
    webAppUrlOk: msgs.some(m => /"web_app":\{"url":"https:\/\/[^"]+\/p\/app\.html/.test(JSON.stringify(m.body.reply_markup || {}))),
    owner: msgs.some(m => /👑/.test(m.body.text || '')),
    ownerKb: msgs.flatMap(m => replyKbTexts(m.body.reply_markup)),
    contactAdmin: msgs.some(m => /адміністратор|admin|t\.me\/|\+380/i.test((m.body.text || '') + JSON.stringify(m.body.reply_markup || {}))),
    texts: msgs.map(m => m.body.text || ''),
    // що реально лишається в чаті: надіслані мінус видалені; і чи прибрано стару нижню клавіатуру
    visible: msgs.length - calls.filter(c => c.method === 'deleteMessage').length,
    removeKb: msgs.some(m => m.body.reply_markup && m.body.reply_markup.remove_keyboard === true),
    edits: calls.filter(c => /^edit/.test(c.method)).length,
  };
}

// кнопки нагадувань bk:r:ok|mv|cn — на тимчасовому QA-клієнті й записі, після — прибираємо лише їх
async function cb(data, fromId, miniapp) {
  const calls = [];
  const tg = async (method, body) => { calls.push({ method, body }); return { ok: true, result: { message_id: 1 } }; };
  const upd = { update_id: 2, callback_query: { id: 'q' + Date.now(), data, from: { id: fromId, is_bot: false, first_name: 'QA бот' },
    message: { message_id: 5, chat: { id: fromId, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'нагадування' } } };
  await processUpdate(upd, tg, { name: 'SVS Beauty Space', miniapp });
  const txt = calls.map(c => (c.body && (c.body.text || '')) + JSON.stringify((c.body && c.body.reply_markup) || {})).join(' | ');
  return { txt, webApp: /"web_app"/.test(txt) };
}
async function reminderButtons() {
  const pool = getPool(); const T = '00000000-0000-0000-0000-000000000001';
  const ms = (await pool.query(`SELECT ms.master_id, ms.service_id FROM master_services ms JOIN masters m ON m.id=ms.master_id
      WHERE m.active LIMIT 1`)).rows[0];
  const cid = (await pool.query(`INSERT INTO clients (phone,name,telegram_id,source) VALUES ($1,'QA нагадування',$2,'qa-audit') RETURNING id`,
    ['+38067' + (1000000 + Math.floor(Math.random() * 8e6)), UID])).rows[0].id;
  const out = {};
  try {
    const a = (await pool.query(`INSERT INTO appointments (tenant_id,master_id,service_id,client_id,client_name,status,starts_at,ends_at,price,source)
      VALUES ($1,$2,$3,$4,'QA','booked',date_trunc('hour',now())+interval '2 days',date_trunc('hour',now())+interval '2 days 1 hour',500,'qa-audit') RETURNING id`,
      [T, ms.master_id, ms.service_id, cid])).rows[0].id;
    out.startKnown = await run('/start', UID, true);
    out.admin = await run('Адміністратор', UID, true);
    out.ok = await cb('bk:r:ok:' + a, UID, true);
    out.mv = await cb('bk:r:mv:' + a, UID, true);
    out.foreign = await cb('bk:r:cn:' + a, UID + 1, true);
    out.foreignStatus = (await pool.query(`SELECT status FROM appointments WHERE id=$1`, [a])).rows[0].status;
    out.cn = await cb('bk:r:cn:' + a, UID, true);
    out.cnStatus = (await pool.query(`SELECT status FROM appointments WHERE id=$1`, [a])).rows[0].status;
    out.again = await cb('bk:r:cn:' + a, UID, true);
  } finally {
    await pool.query(`DELETE FROM online_bookings WHERE legacy_appointment_ref IN (SELECT id::text FROM appointments WHERE client_id=$1)`, [cid]).catch(() => {});
    await pool.query(`DELETE FROM appointments WHERE client_id=$1`, [cid]).catch(e => console.error('cleanup', e.message));
    await pool.query(`DELETE FROM clients WHERE id=$1`, [cid]).catch(e => console.error('cleanup', e.message));
  }
  return out;
}

(async () => {
  const out = {};
  out.remind = await reminderButtons().catch(e => ({ error: String(e.message).split('\n')[0] }));
  out.startNew = await run('/start', UID, true);
  out.freeText = await run('хочу записатися на манікюр в пʼятницю', UID, true);
  out.menu = await run('/menu', UID, true);
  out.oldMenuBook = await run('📅 Записатись', UID, true);
  out.oldMenuCab = await run('👤 Мій кабінет', UID, true);
  out.startOld = await run('/start', UID, false);
  out.freeTextOld = await run('хочу записатися на манікюр в пʼятницю', UID, false);
  // власник: telegram_id беремо з БД (users JOIN roles owner), НЕ друкуємо
  const ow = await getPool().query(`SELECT u.telegram_id FROM users u JOIN roles r ON r.id = u.role_id
                                     WHERE u.tenant_id = '00000000-0000-0000-0000-000000000001' AND u.telegram_id IS NOT NULL
                                       AND COALESCE(u.is_active, true) = true AND r.code = 'owner' LIMIT 1`).catch(() => ({ rows: [] }));
  if (ow.rows[0]) {
    const oid = Number(ow.rows[0].telegram_id);
    out.ownerNew = await run('/start', oid, true);
    out.ownerOld = await run('/start', oid, false);
    out.ownerNew.texts = out.ownerOld.texts = undefined;
  } else out.ownerNew = out.ownerOld = null;
  process.stdout.write('RESULT=' + JSON.stringify(out) + '\n');
  process.exit(0);
})().catch(e => { console.error('harness error', e.message); process.exit(1); });
