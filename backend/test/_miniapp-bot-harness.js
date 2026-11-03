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
  };
}

(async () => {
  const out = {};
  out.startNew = await run('/start', UID, true);
  out.freeText = await run('хочу записатися на манікюр в пʼятницю', UID, true);
  out.menu = await run('/menu', UID, true);
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
