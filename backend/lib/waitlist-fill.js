/* Автоподстановка из листа ожидания (запрос Босса).
 * Когда запись отменяется/неявка — слот освобождается. Ищем в очереди подходящего
 * клиента (к тому же мастеру ИЛИ «будь-який»), предлагаем ему слот в Telegram с кнопками
 * підтвердити/відмовитись, и шлём администратору алерт. Подтверждение обрабатывает
 * booking-bot webhook (callback wl:confirm/wl:decline), который создаёт запись с
 * source='waitlist' → в CRM подсвечивается как «з черги».
 *
 * Активные статусы очереди: waiting/pending/offered (не cancelled/confirmed).
 */
const { getPool } = require('../db-pg');
const { getBotForTenant, tgCall } = require('./tenant-bots');

const KYIV = 'Europe/Kyiv';
function fmtSlot(startsAt) {
  try { return new Date(startsAt).toLocaleString('uk-UA', { timeZone: KYIV, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch (_) { return String(startsAt); }
}

// Найти кандидата из очереди на освободившийся слот и предложить ему.
// opts: { masterId, masterName, serviceId, startsAt, endsAt }
async function tryFillFromWaitlist(opts = {}) {
  const pool = getPool();
  const { masterId, startsAt } = opts;
  if (!masterId || !startsAt) return { filled: false, reason: 'no-slot' };
  try {
    // кандидат: активная запись очереди, к ЭТОМУ мастеру или к «любому» (master_id NULL/‘any’/0),
    // окно предпочтений включает слот (или окно не задано), есть telegram_id, ещё не предложено.
    // FIFO — кто раньше встал в очередь. FOR UPDATE SKIP LOCKED — без гонок между отменами.
    const cand = (await pool.query(
      `SELECT * FROM waitlist
        WHERE status IN ('waiting','pending')
          AND telegram_id IS NOT NULL
          AND (master_id IS NULL OR master_id='' OR master_id='any' OR master_id=$1::text)
          AND (preferred_from IS NULL OR preferred_from <= $2::timestamptz)
          AND (preferred_to   IS NULL OR preferred_to   >= $2::timestamptz)
        ORDER BY created_at ASC
        LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [String(masterId), startsAt])).rows[0];
    if (!cand) return { filled: false, reason: 'no-candidate' };

    // помечаем предложенным (чтобы не предлагать дважды), сохраняем слот и КОНКРЕТНОГО мастера
    // освободившегося слота (очередь могла быть на «любого» — при подтверждении нужен точный).
    await pool.query(
      `UPDATE waitlist SET status='offered', offered_slot=$2, offered_ends=$3,
              offered_master_id=$4, offered_master_name=$5, offered_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [cand.id, startsAt, opts.endsAt || null, String(masterId), opts.masterName || cand.master_name || null]);

    // резолвим тенант очереди (для бота салона)
    const tenantId = cand.tenant_id;
    const bot = await getBotForTenant(tenantId).catch(() => null);
    const when = fmtSlot(startsAt);
    const mName = opts.masterName || cand.master_name || 'майстер';
    // предложение клиенту с кнопками
    if (bot && bot.token) {
      await tgCall(bot.token, 'sendMessage', {
        chat_id: cand.telegram_id,
        text: `🔔 Звільнився час!\n\n${cand.service_name || 'Послуга'} у ${mName}\n📅 ${when}\n\nВи були в черзі — хочете записатись на цей час?`,
        reply_markup: { inline_keyboard: [[
          { text: '✅ Так, записати', callback_data: `wl:confirm:${cand.id}` },
          { text: '✖ Ні', callback_data: `wl:decline:${cand.id}` },
        ]] },
      }).catch((e) => console.error('[waitlist-fill:offer]', e.message));
    }
    // алерт администратору салона (owner_chat_id из настроек бота салона)
    if (bot && bot.token) {
      const oc = (await pool.query(
        `SELECT owner_chat_id FROM tenant_bot_settings WHERE tenant_id=$1 AND owner_chat_id IS NOT NULL LIMIT 1`,
        [tenantId])).rows[0];
      if (oc && oc.owner_chat_id) {
        await tgCall(bot.token, 'sendMessage', {
          chat_id: oc.owner_chat_id,
          text: `📋 Черга: клієнту ${cand.client_name || cand.client_phone || '#' + cand.id} запропоновано вільний час ${when} (${mName}). Чекаємо підтвердження.`,
        }).catch(() => {});
      }
    }
    console.log(`[waitlist-fill] offered wl#${cand.id} tenant=${tenantId} slot=${startsAt} master=${masterId}`);
    return { filled: true, waitlist_id: cand.id, offered_to: cand.client_name };
  } catch (e) {
    console.error('[waitlist-fill]', e.message);
    return { filled: false, reason: e.message };
  }
}

module.exports = { tryFillFromWaitlist };
