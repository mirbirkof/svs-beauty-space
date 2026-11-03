'use strict';
/**
 * Связка «Telegram ↔ мастер салона» для мини-аппа и бота (Босс 03.11, часть 2).
 *
 * ПРАВИЛА БЕЗОПАСНОСТИ (дословно из задачи + факт прод-БД от Jarvis):
 *  • Права мастера даёт ТОЛЬКО телефон из подписанного Telegram-контакта (contact.user_id == from.id).
 *    Номер, набранный руками, ничего не даёт — сюда он просто не передаётся.
 *  • Автоузнавание: проверенный номер совпал (последние 9 цифр) с телефоном учётки «Майстер»
 *    или карточки активного мастера → привязываем telegram_id. Ровно так бот уже привязывает
 *    сотрудников по контакту (routes/booking.js, ветка staff-link) — это не эвристика, а
 *    подтверждённый Telegram номер.
 *  • Номер есть только в карточке мастера, а учётки нет → учётку САМИ не создаём: только через
 *    заявку «Я майстер» и ✔ владельца/админа.
 *  • Заявка «Я майстер»: без ✔ прав нет. После ✔ — masters.phone (только если пусто),
 *    masters.telegram_id, учётка users с ролью «Майстер» (если нет) — как POST /api/auth-staff/link.
 *  • Подтверждать может только тот, кому заявка ушла: владельцы салона с Telegram + ADMIN_TG_CHAT.
 */
const crypto = require('crypto');

const last9 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : null; };
const canonPhone = (p) => { const l = last9(p); return l ? '380' + l : null; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const SESSION_HOURS = 12;

// Работающие мастера (не админ/владелец), которые реально ведут клиентов.
const WORKING = `m.active AND COALESCE(m.staff_role,'master')='master' AND COALESCE(m.provides_services,true)`;

async function audit(pool, action, entityId, meta) {
  await pool.query(
    `INSERT INTO audit_log (user_id, user_label, action, entity, entity_id, ip, meta)
     VALUES (NULL, $1, $2, 'master', $3, NULL, $4)`,
    ['miniapp', action, entityId, JSON.stringify(meta || {})]).catch((e) => console.error('[master-link/audit]', e.message));
}

/** Мастер по проверенному номеру. Возвращает {master_id, master_name, user_id|null, user_tg|null} или null (нет/неоднозначно). */
async function findByPhone(pool, tenantId, phone) {
  const l9 = last9(phone);
  if (!l9) return null;
  const r = await pool.query(
    `SELECT m.id AS master_id, m.name AS master_name, u.id AS user_id, u.telegram_id AS user_tg, r.code AS role_code
       FROM masters m
       LEFT JOIN users u ON u.master_id = m.id AND u.tenant_id = m.tenant_id AND u.merged_into IS NULL
       LEFT JOIN roles r ON r.id = u.role_id
      WHERE m.tenant_id = $1 AND ${WORKING}
        AND (right(regexp_replace(COALESCE(m.phone,''),'\\D','','g'),9) = $2
          OR (right(regexp_replace(COALESCE(u.phone,''),'\\D','','g'),9) = $2 AND COALESCE(u.is_active,true)))`,
    [tenantId, l9]);
  const ids = new Set(r.rows.map((x) => x.master_id));
  if (ids.size !== 1) return null;                       // нет или номер у двух мастеров — решает человек
  const row = r.rows[0];
  if (row.user_id && row.role_code !== 'master') return null; // учётка с другой ролью — не наше дело
  return { master_id: row.master_id, master_name: row.master_name, user_id: row.user_id || null, user_tg: row.user_tg ? Number(row.user_tg) : null };
}

/**
 * Автоузнавание мастера по ПРОВЕРЕННОМУ номеру. Пишет только telegram_id (учётке и карточке),
 * и только если он пуст или уже этот же. Возвращает:
 *   {master:false} | {master:true, linked:true, master_id, name} | {master:true, needClaim:true, ...} | {master:true, conflict:true}
 */
async function recognize(pool, tenantId, uid, phone) {
  const m = await findByPhone(pool, tenantId, phone);
  if (!m) return { master: false };
  if (!m.user_id) return { master: true, needClaim: true, master_id: m.master_id, name: m.master_name };
  if (m.user_tg && m.user_tg !== Number(uid)) return { master: true, conflict: true, master_id: m.master_id, name: m.master_name };
  try {
    const u = await pool.query(
      `UPDATE users SET telegram_id=$1, updated_at=NOW()
        WHERE id=$2 AND tenant_id=$3 AND (telegram_id IS NULL OR telegram_id=$1) RETURNING id`, [uid, m.user_id, tenantId]);
    if (!u.rowCount) return { master: true, conflict: true, master_id: m.master_id, name: m.master_name };
  } catch (e) {
    if (e.code === '23505') return { master: true, conflict: true, master_id: m.master_id, name: m.master_name }; // этот TG уже у другой учётки
    throw e;
  }
  await pool.query(`UPDATE masters SET telegram_id=$1 WHERE id=$2 AND tenant_id=$3 AND telegram_id IS NULL`, [uid, m.master_id, tenantId]);
  if (!m.user_tg) await audit(pool, 'master.tg_link_auto', m.master_id, { user_id: m.user_id, tg: Number(uid), via: 'verified_contact' });
  return { master: true, linked: true, master_id: m.master_id, name: m.master_name };
}

/** Учётка мастера, привязанная к этому Telegram (ровно одна, активная, роль master, с карточкой). */
async function masterUserByTg(pool, tenantId, uid) {
  const r = await pool.query(
    `SELECT u.id, u.display_name, u.role_id, u.master_id, m.name AS master_name
       FROM users u JOIN roles r ON r.id=u.role_id JOIN masters m ON m.id=u.master_id
      WHERE u.tenant_id=$1 AND u.telegram_id=$2 AND COALESCE(u.is_active,true) AND u.merged_into IS NULL
        AND r.code='master' AND m.active
      LIMIT 2`, [tenantId, uid]);
  return r.rows.length === 1 ? r.rows[0] : null;
}

/** Короткая сессия мастера для мини-аппа: обычный токен user_tokens → права роли «Майстер». */
async function issueMasterSession(pool, tenantId, uid, req) {
  const u = await masterUserByTg(pool, tenantId, uid);
  if (!u) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600e3);
  const ua = String((req && req.headers && req.headers['user-agent']) || '').slice(0, 60);
  await pool.query(`INSERT INTO user_tokens (user_id, token_hash, label, expires_at) VALUES ($1,$2,$3,$4)`,
    [u.id, sha256(token), `miniapp-master tg:${uid} ${ua}`, expiresAt]);
  await pool.query(`UPDATE users SET last_login_at=NOW() WHERE id=$1`, [u.id]);
  await pool.query(
    `INSERT INTO audit_log (user_id, user_label, action, entity, entity_id, ip, meta)
     VALUES ($1,$2,'auth.login','user',$3,$4,$5)`,
    [u.id, u.display_name, u.id, String((req && (req.headers['x-forwarded-for'] || req.ip)) || '').split(',')[0].trim(),
      JSON.stringify({ method: 'miniapp-telegram' })]).catch(() => {});
  return { token, expiresAt, master_id: u.master_id, name: u.master_name || u.display_name };
}

/** Кандидаты для «Я майстер»: работающие мастера без привязанного Telegram у учётки. */
async function claimCandidates(pool, tenantId) {
  const r = await pool.query(
    `SELECT m.id, m.name FROM masters m
       LEFT JOIN users u ON u.master_id=m.id AND u.merged_into IS NULL
      WHERE m.tenant_id=$1 AND ${WORKING} AND u.telegram_id IS NULL
        -- лише ті, хто реально працює: живі записи клієнтів за 90 днів / наперед або робочий графік (на проді є пусті
        -- демо-картки «Терапевт Один», «Тренер …» без жодного запису — їх у списку не показуємо)
        AND (EXISTS (SELECT 1 FROM appointments a WHERE a.master_id=m.id AND a.client_id IS NOT NULL
                        AND COALESCE(a.status,'') <> 'cancelled' AND a.starts_at > NOW() - INTERVAL '90 days')
          OR EXISTS (SELECT 1 FROM master_schedule_days d WHERE d.master_id=m.id AND d.work_date >= CURRENT_DATE - 60
                        AND d.start_time IS NOT NULL AND d.end_time > d.start_time))
      ORDER BY m.name`, [tenantId]);
  return r.rows;
}

/** Кому слать заявку и кто вправе нажать ✔/✖: владельцы салона с Telegram + ADMIN_TG_CHAT. */
async function approvers(pool, tenantId) {
  const set = new Set();
  try {
    const vm = require('./virtual-manager');
    const own = await (vm.ownerRecipients ? vm.ownerRecipients(pool, tenantId) : []);
    for (const x of own || []) if (x) set.add(String(x));
  } catch (e) { console.error('[master-link/approvers]', e.message); }
  if (process.env.ADMIN_TG_CHAT) set.add(String(process.env.ADMIN_TG_CHAT));
  return [...set];
}

/** Создать заявку и разослать владельцам. phone — ТОЛЬКО из проверенного контакта. */
async function createClaim(pool, tenantId, tgUser, phone, masterId, tg) {
  const cands = await claimCandidates(pool, tenantId);
  const m = cands.find((x) => Number(x.id) === Number(masterId));
  if (!m) return { error: 'bad_master' };
  const recent = await pool.query(
    `SELECT COUNT(*)::int n FROM master_claims WHERE tenant_id=$1 AND tg_user_id=$2 AND created_at > NOW() - INTERVAL '1 day'`,
    [tenantId, tgUser.id]);
  if (recent.rows[0].n >= 5) return { error: 'too_many' };
  const tgName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || 'Без імені';
  let claim;
  try {
    claim = (await pool.query(
      `INSERT INTO master_claims (tenant_id, tg_user_id, tg_name, tg_username, phone, master_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [tenantId, tgUser.id, tgName, tgUser.username || null, canonPhone(phone), m.id])).rows[0];
  } catch (e) {
    if (e.code === '23505') return { error: 'pending' };
    throw e;
  }
  const to = await approvers(pool, tenantId);
  const text = `👤 <b>Запит «Я майстер»</b>\n${esc(tgName)}${tgUser.username ? ' (@' + esc(tgUser.username) + ')' : ''}, номер <b>+${esc(canonPhone(phone))}</b> (підтверджений Telegram) каже, що він майстер <b>${esc(m.name)}</b>.\n\nПідтвердити?`;
  const kb = { inline_keyboard: [[{ text: '✔ Так, це майстер', callback_data: `mc:ok:${claim.id}` }, { text: '✖ Ні', callback_data: `mc:no:${claim.id}` }]] };
  let sent = 0;
  for (const chat of to) {
    try { await tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', reply_markup: kb }); sent++; }
    catch (e) { console.error('[master-link/claim-send]', e.message); }
  }
  await audit(pool, 'master.claim_create', m.id, { claim: claim.id, tg: tgUser.id, sent });
  return { ok: true, claim_id: claim.id, sent, master_name: m.name };
}

/** ✔ — записать связку. Всё в одной транзакции; ничего не перетирает, кроме пустых полей. */
async function approveClaim(pool, tenantId, claimId, deciderTg) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const c = (await client.query(`SELECT * FROM master_claims WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [claimId, tenantId])).rows[0];
    if (!c) { await client.query('ROLLBACK'); return { error: 'not_found' }; }
    if (c.status !== 'pending') { await client.query('ROLLBACK'); return { error: 'decided', status: c.status }; }
    const m = (await client.query(`SELECT id, name, phone, telegram_id FROM masters WHERE id=$1 AND tenant_id=$2 AND active FOR UPDATE`, [c.master_id, tenantId])).rows[0];
    if (!m) { await client.query('ROLLBACK'); return { error: 'master_gone' }; }
    const tgBusy = (await client.query(
      `SELECT id, master_id FROM users WHERE tenant_id=$1 AND telegram_id=$2`, [tenantId, c.tg_user_id])).rows[0];
    let u = (await client.query(
      `SELECT u.id, u.telegram_id, u.phone, r.code FROM users u JOIN roles r ON r.id=u.role_id
        WHERE u.master_id=$1 AND u.tenant_id=$2 AND u.merged_into IS NULL`, [m.id, tenantId])).rows[0];
    if (tgBusy && (!u || tgBusy.id !== u.id)) { await client.query('ROLLBACK'); return { error: 'tg_used', message: 'Цей Telegram уже привʼязано до іншої обліковки CRM.' }; }
    if (u && u.telegram_id && Number(u.telegram_id) !== Number(c.tg_user_id)) { await client.query('ROLLBACK'); return { error: 'master_has_tg', message: 'У цього майстра вже привʼязаний інший Telegram.' }; }
    const result = { master_id: m.id };
    // masters.phone — только если пусто; telegram_id — карточке (уведомления, утренний список)
    const mu = await client.query(
      `UPDATE masters SET phone = CASE WHEN COALESCE(phone,'')='' THEN $1 ELSE phone END, telegram_id=$2
        WHERE id=$3 RETURNING (phone=$1) AS phone_set`, [c.phone, c.tg_user_id, m.id]);
    result.master_phone_filled = !m.phone && mu.rows[0].phone_set;
    if (u) {
      if (u.code !== 'master') { await client.query('ROLLBACK'); return { error: 'role', message: 'Обліковка цього майстра має іншу роль — змініть вручну в CRM.' }; }
      await client.query(
        `UPDATE users SET telegram_id=$1,
                phone = CASE WHEN COALESCE(phone,'')='' AND NOT EXISTS (SELECT 1 FROM users x WHERE x.tenant_id=$3 AND x.phone=$4) THEN $4 ELSE phone END,
                updated_at=NOW() WHERE id=$2`, [c.tg_user_id, u.id, tenantId, c.phone]);
      result.user_id = u.id; result.user_created = false;
    } else {
      // Номер уже у другой учётки салона (владелец/адмін) — роль сами не меняем.
      const byPhone = (await client.query(`SELECT id FROM users WHERE tenant_id=$1 AND right(regexp_replace(COALESCE(phone,''),'\\D','','g'),9)=$2`,
        [tenantId, last9(c.phone)])).rows[0];
      if (byPhone) { await client.query('ROLLBACK'); return { error: 'phone_used', message: 'Цей номер уже має іншу обліковку CRM — привʼяжіть вручну.' }; }
      const role = (await client.query(`SELECT id FROM roles WHERE code='master' AND tenant_id=$1 LIMIT 1`, [tenantId])).rows[0];
      if (!role) { await client.query('ROLLBACK'); return { error: 'no_role' }; }
      const ins = await client.query(
        `INSERT INTO users (tenant_id, phone, display_name, role_id, telegram_id, master_id, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING id`, [tenantId, c.phone, m.name, role.id, c.tg_user_id, m.id]);
      result.user_id = ins.rows[0].id; result.user_created = true;
    }
    await client.query(`UPDATE master_claims SET status='approved', decided_by=$2, decided_at=NOW(), result=$3 WHERE id=$1`,
      [c.id, deciderTg, JSON.stringify(result)]);
    await client.query(
      `INSERT INTO audit_log (user_id, user_label, action, entity, entity_id, ip, meta)
       VALUES (NULL, $1, 'master.claim_approve', 'master', $2, NULL, $3)`,
      [`tg:${deciderTg}`, m.id, JSON.stringify({ claim: c.id, ...result })]);
    await client.query('COMMIT');
    return { ok: true, claim: c, master: m, result };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return { error: 'conflict', message: 'Конфлікт унікальності (номер або Telegram уже зайняті).' };
    throw e;
  } finally { client.release(); }
}

async function rejectClaim(pool, tenantId, claimId, deciderTg) {
  const r = await pool.query(
    `UPDATE master_claims SET status='rejected', decided_by=$3, decided_at=NOW()
      WHERE id=$1 AND tenant_id=$2 AND status='pending' RETURNING *`, [claimId, tenantId, deciderTg]);
  if (!r.rows[0]) return { error: 'decided' };
  await audit(pool, 'master.claim_reject', r.rows[0].master_id, { claim: claimId, by: deciderTg });
  return { ok: true, claim: r.rows[0] };
}

/** Обработка кнопок mc:ok:<id> / mc:no:<id> в вебхуке бота. true — обработано. */
async function onClaimCallback(cq, ctx) {
  const m = /^mc:(ok|no):(\d+)$/.exec(String(cq.data || ''));
  if (!m) return false;
  const { pool, tg, tenantId } = ctx;
  const answer = (text) => tg('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: true }).catch(() => {});
  const allowed = await approvers(pool, tenantId);
  if (!allowed.includes(String(cq.from && cq.from.id))) { await answer('Підтверджувати може лише власник салону.'); return true; }
  const id = Number(m[2]);
  const res = m[1] === 'ok' ? await approveClaim(pool, tenantId, id, cq.from.id) : await rejectClaim(pool, tenantId, id, cq.from.id);
  if (res.error) {
    await answer(res.message || (res.error === 'decided' ? 'Цей запит уже вирішено.' : 'Не вдалося: ' + res.error));
    return true;
  }
  await answer(m[1] === 'ok' ? 'Підтверджено ✔' : 'Відхилено ✖');
  const who = res.master ? res.master.name : '';
  const note = m[1] === 'ok' ? `\n\n✔ <b>Підтверджено</b>${res.result.user_created ? ' · створено обліковку «Майстер»' : ''}` : '\n\n✖ <b>Відхилено</b>';
  if (cq.message) {
    tg('editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, parse_mode: 'HTML',
      text: esc(cq.message.text || 'Запит «Я майстер»') + note }).catch(() => {});
  }
  const claimant = res.claim.tg_user_id;
  tg('sendMessage', { chat_id: claimant, parse_mode: 'HTML',
    text: m[1] === 'ok'
      ? `✅ Салон підтвердив: ви майстер <b>${esc(who)}</b>. Відкрийте застосунок запису — там зʼявився режим «Я майстер» з вашим розкладом і статистикою.`
      : 'Салон не підтвердив запит «Я майстер». Якщо це помилка — напишіть адміністратору.' }).catch(() => {});
  return true;
}

module.exports = { last9, canonPhone, findByPhone, recognize, masterUserByTg, issueMasterSession, claimCandidates,
  approvers, createClaim, approveClaim, rejectClaim, onClaimCallback, SESSION_HOURS };
