'use strict';
/**
 * Уведомления мастеру в Telegram: новая запись / отмена / перенос (Босс 03.11, часть 2).
 *
 * Утренний список на день уже шлёт lib/virtual-manager.masterDailySchedules — здесь его НЕ дублируем.
 * Источник — доменные события lib/event-bus (их публикуют журнал CRM routes/schedule.js и
 * запись из бота/мини-аппа lib/booking-core.js), поэтому ни одно место создания записи не трогаем.
 *
 * Кому: masters.telegram_id задан, мастер активен, notify_telegram не выключен и включён
 * соответствующий флажок notify_new_booking / notify_cancellation / notify_reschedule
 * (колонки давно были в карточке мастера, но ни один код по ним не слал).
 * Прошедшие записи (правка задним числом) не шлём. Номер клиента мастеру не шлём.
 * Сбой отправки никогда не ломает запись: обработчик уходит в setImmediate и глотает ошибки.
 */
const { getPool } = require('../db-pg');
const { runAs, DEFAULT_TENANT_ID } = require('./tenant');

const OFF = `COALESCE(LOWER(m.notify_telegram),'') NOT IN ('off','false','no','0','disabled','none')`;
const FLAG = { created: 'notify_new_booking', cancelled: 'notify_cancellation', rescheduled: 'notify_reschedule' };
const sentKeys = new Map(); // дедуп повторных событий (двойной клик/повтор вебхука) — 10 минут

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const when = (d) => new Date(d).toLocaleString('uk-UA', {
  timeZone: 'Europe/Kyiv', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

let sender = null; // тесты подменяют; по умолчанию — общий tgSend CRM
function send(chat, text) {
  const fn = sender || ((c, t) => require('../routes/telegram-notify').tgSend(c, t, { parse_mode: 'HTML' }));
  return fn(chat, text);
}

async function apptInfo(pool, id) {
  const r = await pool.query(
    `SELECT a.id, a.master_id, a.starts_at, a.status,
            COALESCE(c.name, a.client_name, 'клієнт') AS client,
            COALESCE(s.name_ua, s.name, a.services_text, 'послуга') AS service
       FROM appointments a
       LEFT JOIN clients c ON c.id=a.client_id
       LEFT JOIN services s ON s.id=a.service_id
      WHERE a.id=$1`, [id]);
  return r.rows[0] || null;
}

async function masterChat(pool, masterId, kind) {
  if (!masterId) return null;
  const r = await pool.query(
    `SELECT m.telegram_id FROM masters m
      WHERE m.id=$1 AND COALESCE(m.active,true) AND m.telegram_id IS NOT NULL AND ${OFF}
        AND COALESCE(m.${FLAG[kind]}, true)`, [Number(masterId)]);
  return r.rows[0] ? String(r.rows[0].telegram_id) : null;
}

function once(key) {
  const now = Date.now();
  for (const [k, t] of sentKeys) if (now - t > 600000) sentKeys.delete(k);
  if (sentKeys.has(key)) return false;
  sentKeys.set(key, now);
  return true;
}

/** Собрать и отправить. Возвращает список {chat, text} отправленного (для тестов). */
async function handle(kind, evt, pool = getPool()) {
  const p = (evt && evt.payload) || {};
  const ids = Array.isArray(p.appointment_ids) && p.appointment_ids.length ? p.appointment_ids : [p.appointment_id];
  const out = [];
  for (const id of ids.map(Number).filter(Boolean)) {
    const a = await apptInfo(pool, id);
    if (!a) continue;                                        // жёстко удалена — мастера не знаем
    if (new Date(a.starts_at).getTime() < Date.now() - 3600e3) continue; // правка прошлого
    const line = `${when(a.starts_at)} — ${esc(a.client)} · ${esc(a.service)}`;
    const jobs = [];
    if (kind === 'created') jobs.push([a.master_id, 'created', `🆕 <b>Новий запис</b>\n${line}`]);
    if (kind === 'cancelled') jobs.push([a.master_id, 'cancelled', `❌ <b>Запис скасовано</b>\n${line}`]);
    if (kind === 'rescheduled') {
      const oldM = p.old_master_id ? Number(p.old_master_id) : Number(a.master_id);
      const oldT = p.old_starts_at ? when(p.old_starts_at) : '';
      if (oldM && oldM !== Number(a.master_id)) {
        jobs.push([oldM, 'rescheduled', `↪️ <b>Запис передано іншому майстру</b>\n${oldT} — ${esc(a.client)} · ${esc(a.service)}`]);
        jobs.push([a.master_id, 'created', `🆕 <b>Новий запис</b> (передано вам)\n${line}`]);
      } else {
        jobs.push([a.master_id, 'rescheduled', `🔁 <b>Запис перенесено</b>\n${oldT ? `було: ${oldT}\n` : ''}стало: ${line}`]);
      }
    }
    for (const [mid, flag, text] of jobs) {
      const chat = await masterChat(pool, mid, flag);
      if (!chat) continue;
      if (!once(`${kind}:${id}:${mid}:${a.starts_at && new Date(a.starts_at).getTime()}:${a.status}`)) continue;
      try { await send(chat, text); out.push({ chat, text }); }
      catch (e) { console.error('[master-notify] send:', e.message); }
    }
  }
  return out;
}

let inited = false;
function init() {
  if (inited) return; inited = true;
  const bus = require('./event-bus');
  for (const kind of ['created', 'cancelled', 'rescheduled']) {
    bus.on('appointment.' + kind, (evt) => {
      const tid = (evt && evt.tenant_id) || DEFAULT_TENANT_ID;
      setImmediate(() => runAs(tid, () => handle(kind, evt)).catch((e) => console.error('[master-notify]', e.message)));
    });
  }
}

module.exports = { init, handle, _setSender: (fn) => { sender = fn; }, _reset: () => sentKeys.clear() };
