/* ═══════════════════════════════════════════════════════════════
   Ядро бронювання — ОДНЕ для Telegram-бота (doBook) і Mini App.
   Схема CRM-first: appointments (журнал салону) + тінь online_bookings
   в одній транзакції під advisory-локом майстра (той самий ключ, що в
   адмінці schedule.js: hashtext(String(Number(master_id)))).
   ═══════════════════════════════════════════════════════════════ */
const slotEngine = require('./slot-engine');

function slotTakenError() { const e = new Error('slot-taken'); e.slotTaken = true; return e; }

/**
 * Створити бронь.
 * opts: { pool, clientId, masterId, masterName, date 'YYYY-MM-DD', startMin,
 *         services:[{id,name,duration_min,price}], name, phone, telegramId,
 *         apptSource ('bot-chat'|'miniapp'), obChannel ('bot'|'miniapp'),
 *         dedupeClient (bool) }
 * → { apptIds, bookingId, existing }
 * Кидає err.slotTaken, якщо час уже зайнятий (включно з 23P01 від capacity-тригера).
 * dedupeClient: якщо У ЦЬОГО Ж клієнта вже є активний запис до цього майстра на цей
 *   самий старт — повертаємо його (existing=true), а не «слот зайнято» (подвійний тап).
 */
async function createBooking(opts) {
  const { pool, clientId, masterId, date, startMin, services, name, phone, telegramId } = opts;
  const apptSource = opts.apptSource || 'bot-chat';
  const obChannel = opts.obChannel || 'bot';
  if (!services || !services.length) throw new Error('no-services');
  const totalDur = services.reduce((a, s) => a + (Number(s.duration_min) || 60), 0);
  const apptIds = [];
  let bookingId = null;
  let existing = false;
  const { withTx } = require('../db-pg');
  try {
    await withTx(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [String(Number(masterId))]);
      if (opts.dedupeClient) {
        const ex = await client.query(
          `SELECT a.id FROM appointments a
            WHERE a.client_id=$1 AND a.master_id=$2 AND a.status = ANY($5::text[])
              AND a.starts_at >= ${slotEngine.TS_EXPR(3, 4)} AND a.starts_at < ${slotEngine.TS_EXPR(3, 6)}
            ORDER BY a.starts_at`,
          [clientId, masterId, date, startMin, slotEngine.BUSY_STATUSES, startMin + totalDur]);
        if (ex.rows.length) {
          existing = true;
          for (const r of ex.rows) apptIds.push(r.id);
          const ob = await client.query(
            `SELECT id FROM online_bookings WHERE legacy_appointment_ref = $1 ORDER BY id DESC LIMIT 1`,
            [String(apptIds[0])]);
          bookingId = ob.rows[0] ? ob.rows[0].id : null;
          return;
        }
      }
      let cur = startMin;
      for (const s of services) {
        const d = Number(s.duration_min) || 60;
        const r = await client.query(
          `INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, price, status, source, client_name)
           SELECT $1,$2,$3, ${slotEngine.TS_EXPR(4, 5)}, ${slotEngine.TS_EXPR(4, 6)}, $7, 'confirmed', $9, $8
            WHERE (
              SELECT count(*) FROM appointments
               WHERE master_id=$2 AND status NOT IN ('cancelled','noshow') AND ends_at IS NOT NULL
                 AND tstzrange(starts_at, ends_at) && tstzrange(${slotEngine.TS_EXPR(4, 5)}, ${slotEngine.TS_EXPR(4, 6)})
            ) < COALESCE((SELECT max_parallel FROM masters WHERE id=$2), 1)
           RETURNING id`,
          [clientId, masterId, s.id, date, cur, cur + d, Number(s.price) || null, name, apptSource]);
        if (!r.rows[0]) throw slotTakenError();
        apptIds.push(r.rows[0].id);
        cur += d;
      }
      // Тінь online_bookings — у тій самій транзакції (аудит v6); місткість уже перевірена
      // guarded-insert'ами під локом → локальний обхід capacity-тригера.
      await client.query(`SELECT set_config('app.skip_overbook','on', true)`);
      const ob = await client.query(
        `INSERT INTO online_bookings
           (client_id, client_phone, client_name, service_id, service_name, master_id, master_name,
            date_from, date_to, channel, legacy_appointment_ref, status, telegram_id, appointment_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7, ${slotEngine.TS_EXPR(8, 9)}, ${slotEngine.TS_EXPR(8, 10)},
                 $14,$11,'confirmed',$12,$13) RETURNING id`,
        [clientId, phone, name, String(services[0].id), services.map(s => s.name).join(' + '),
         String(masterId), opts.masterName || null,
         date, startMin, startMin + totalDur,
         String(apptIds[0] || ''), telegramId || null, Number(apptIds[0]) || null, obChannel]);
      bookingId = ob.rows[0].id;
    });
  } catch (e) {
    // транзакція вже відкотилась (withTx → ROLLBACK); страховка для «хвоста», як було в doBook
    if (apptIds.length && !existing) {
      await pool.query(`UPDATE appointments SET status='cancelled', updated_at=NOW() WHERE id = ANY($1::int[]) AND status='confirmed' AND source=$2`,
        [apptIds, apptSource]).catch(() => {});
    }
    if (e && (e.slotTaken || e.code === '23P01')) throw slotTakenError();
    throw e;
  }
  // Журнал событий (как журнал CRM): отсюда уведомление мастеру (lib/master-notify) и вебхуки.
  if (!existing && apptIds.length) {
    require('./event-bus').emit('appointment.created',
      { appointment_id: Number(apptIds[0]), appointment_ids: apptIds.map(Number), master_id: Number(masterId) || null, channel: obChannel },
      { entityType: 'appointment', entityId: apptIds[0] }).catch(() => {});
  }
  return { apptIds, bookingId, existing };
}

/** Скасувати записи (вже перевірені на належність) + дзеркало в online_bookings. */
async function cancelAppointments(pool, ids) {
  const ints = (ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!ints.length) return 0;
  const r = await pool.query(
    `UPDATE appointments SET status='cancelled', cancelled_at=COALESCE(cancelled_at,NOW()), updated_at=NOW()
      WHERE id = ANY($1::int[]) AND status IN ('booked','confirmed')`, [ints]);
  await pool.query(
    `UPDATE online_bookings SET status='cancelled', updated_at=NOW()
      WHERE legacy_appointment_ref = ANY($1::text[]) AND COALESCE(status,'')<>'cancelled'`,
    [ints.map(String)]).catch(e => console.error('[booking-core/ob-cancel]', e.message));
  if (r.rowCount) {
    require('./event-bus').emit('appointment.cancelled', { appointment_id: ints[0], appointment_ids: ints, master_id: null },
      { entityType: 'appointment', entityId: ints[0] }).catch(() => {});
  }
  return r.rowCount;
}

/** Сповіщення персоналу через ІСНУЮЧИЙ канал: owner_chat_id салонного бота, інакше ADMIN_TG_CHAT. */
async function notifyStaff(pool, tg, text) {
  try {
    const r = await pool.query(
      `SELECT owner_chat_id FROM tenant_bot_settings
        WHERE tenant_id=current_tenant_id() AND owner_chat_id IS NOT NULL LIMIT 1`);
    const chat = r.rows[0] && r.rows[0].owner_chat_id;
    if (chat && tg) { await tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML' }); return 'owner'; }
  } catch (e) { console.error('[booking-core/notify-owner]', e.message); }
  if (process.env.ADMIN_TG_CHAT) {
    try {
      await require('../routes/telegram-notify').tgSend(process.env.ADMIN_TG_CHAT, text, { parse_mode: 'HTML' });
      return 'admin';
    } catch (e) { console.error('[booking-core/notify-admin]', e.message); }
  }
  return null;
}

module.exports = { createBooking, cancelAppointments, notifyStaff };
