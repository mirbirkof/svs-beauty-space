'use strict';
/**
 * «Его ли смена» — наблюдатель за тем, с какого аккаунта работают в CRM.
 *
 * Задача Босса 11.08.2026: CRM должна контролировать, с какого аккаунта работает админ
 * и его ли сейчас смена.
 *
 * ПОЧЕМУ НАБЛЮДАТЕЛЬ, А НЕ ЗАПРЕТ: в салоне нормальны подмены, переработки и «зашла
 * закрыть кассу за коллегу». Жёсткая блокировка сломала бы работу в тот же день.
 * Поэтому: фиксируем факт, показываем владельцу и шлём один алерт за смену.
 *
 * Дешевизна: одна запись на аккаунт в сутки (UPSERT со счётчиком), проверка графика не
 * чаще раза в 10 минут на аккаунт. На каждый запрос в БД не ходим.
 */
const KEEP_MS = 10 * 60 * 1000;   // как часто перепроверять график для одного аккаунта
const seen = new Map();           // userId -> { at, verdict }

/** Ставим ли отметку по этому запросу. Служебное и чтение статуса не считаем работой. */
function countable(req) {
  if (req.method === 'OPTIONS') return false;
  const p = req.path || '';
  return !p.startsWith('/api/shift-control') && p !== '/health';
}

/**
 * Fire-and-forget: НИКОГДА не бросает и не задерживает запрос.
 * @returns {void}
 */
function observe(req, user) {
  if (!user || !user.id || !countable(req)) return;
  const prev = seen.get(user.id);
  const now = Date.now();
  if (prev && now - prev.at < KEEP_MS) { req.shiftVerdict = prev.verdict; return; }
  seen.set(user.id, { at: now, verdict: prev ? prev.verdict : null });

  setImmediate(async () => {
    try {
      const sc = require('./shift-control');
      const v = await sc.verdictFor({ userId: user.id });
      if (!v) return;
      seen.set(user.id, { at: now, verdict: v.verdict });
      const row = await sc.audit({ userId: user.id }, v,
        req.headers['x-forwarded-for'] || req.ip || null);
      // Алерт владельцу — один раз за смену и только на реальное отклонение.
      if ((v.verdict === 'off_shift' || v.verdict === 'no_schedule') && row && !row.alerted_at) {
        await alertOwner(v, row);
      }
    } catch (e) {
      console.error('[shift-guard]', e.message);
    }
  });
}

async function alertOwner(v, row) {
  const { getPool } = require('../db-pg');
  const who = v.display_name || `аккаунт #${row.user_id}`;
  const text = v.verdict === 'off_shift'
    ? `⚠️ <b>Робота поза своєю зміною</b>\n${who} працює в CRM, хоча за графіком зараз не його зміна.`
    : `⚠️ <b>Робота без графіка</b>\n${who} працює в CRM, але на сьогодні його немає в графіку змін.`;
  try {
    // тот же канал, что и у биллинга: бот салона владельцу, при отказе — почта
    const tenantId = (await getPool().query(`SELECT current_tenant_id() AS id`)).rows[0]?.id;
    if (tenantId) await require('./billing').notifyOwner(tenantId, text, 'Контроль змін');
  } catch (_) { /* канал уведомлений недоступен — факт всё равно записан в журнал */ }
  await getPool().query(`UPDATE shift_login_audit SET alerted_at = NOW() WHERE id = $1`, [row.id]);
}

module.exports = { observe };
