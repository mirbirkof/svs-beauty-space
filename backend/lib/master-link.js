'use strict';
/**
 * Связка «Telegram ↔ мастер салона» для мини-аппа и бота (Босс 03.11, часть 2).
 *
 * ПРАВИЛА БЕЗОПАСНОСТИ (Босс 03.11 + 04.11 «майстер визначається автоматично»):
 *  • Права мастера даёт ТОЛЬКО телефон из подписанного Telegram-контакта (contact.user_id == from.id).
 *    Номер, набранный руками, ничего не даёт — сюда он просто не передаётся.
 *  • Подтверждённый номер совпал (последние 9 цифр) ровно с ОДНИМ работающим мастером →
 *    режим мастера включается сам: привязываем telegram_id; если у мастера нет учётки users —
 *    создаём её (роль «Майстер», telegram_id, номер) в одной транзакции с теми же проверками,
 *    что были у ✔ заявки (linkMasterAccount). Никакой кнопки «Я майстер» больше нет.
 *  • Любой конфликт (номер у двух мастеров, учётка другой роли, номер уже у другой учётки, этот
 *    Telegram уже у другой учётки, у мастера другой Telegram) → ничего не трогаем, клиентский
 *    режим + запись в audit_log (не чаще раза в сутки на человека и причину).
 *  • Уволили (masters.active=false) → masterUserByTg пуст → клиентский режим; токены мини-аппа
 *    гасит lib/employment.js, а lib/rbac.js дополнительно не пускает miniapp-master токен неактивного мастера.
 *  • Старые заявки master_claims: кнопки ✔/✖ у владельцев продолжают работать (onClaimCallback),
 *    новые заявки не создаются.
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

// Конфликты пишем в audit не чаще раза в сутки на (человек, причина): masterState зовётся на каждом /me.
const conflictSeen = new Map();
async function auditConflict(pool, uid, reason, masterId, meta) {
  const key = uid + ':' + reason + ':' + (masterId || '');
  const now = Date.now();
  if (conflictSeen.has(key) && now - conflictSeen.get(key) < 24 * 3600e3) return;
  conflictSeen.set(key, now);
  if (conflictSeen.size > 5000) conflictSeen.clear();
  await audit(pool, 'master.auto_conflict', masterId || null, { tg: Number(uid), reason, ...(meta || {}) });
}

/**
 * Привязать Telegram (и при необходимости СОЗДАТЬ учётку «Майстер») к работающему мастеру.
 * Одна транзакция, ничего не перетирает, кроме пустых полей. Используется автоузнаванием и старыми ✔ заявок.
 * opts.client — уже открытая транзакция (для ✔ заявки); opts.forceMasterTg — карточке ставим этот TG даже поверх
 * (поведение ✔ владельца, решение человека); без него — только если пусто.
 * → {ok, result:{master_id, user_id, user_created, master_phone_filled}} | {error, message}
 */
async function linkMasterAccount(pool, tenantId, masterId, tgId, phone, opts = {}) {
  const own = !opts.client;
  const client = opts.client || await pool.connect();
  const fail = async (error, message) => { if (own) await client.query('ROLLBACK').catch(() => {}); return { error, message }; };
  const ph = canonPhone(phone);
  try {
    if (own) {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    }
    const m = (await client.query(`SELECT id, name, phone, telegram_id FROM masters WHERE id=$1 AND tenant_id=$2 AND active FOR UPDATE`, [masterId, tenantId])).rows[0];
    if (!m) return await fail('master_gone', 'Майстра не знайдено або він не працює.');
    const tgBusy = (await client.query(`SELECT id FROM users WHERE tenant_id=$1 AND telegram_id=$2`, [tenantId, tgId])).rows[0];
    const u = (await client.query(
      `SELECT u.id, u.telegram_id, u.phone, r.code FROM users u JOIN roles r ON r.id=u.role_id
        WHERE u.master_id=$1 AND u.tenant_id=$2 AND u.merged_into IS NULL FOR UPDATE OF u`, [m.id, tenantId])).rows[0];
    if (tgBusy && (!u || tgBusy.id !== u.id)) return await fail('tg_used', 'Цей Telegram уже привʼязано до іншої обліковки CRM.');
    if (u && u.telegram_id && Number(u.telegram_id) !== Number(tgId)) return await fail('master_has_tg', 'У цього майстра вже привʼязаний інший Telegram.');
    if (u && u.code !== 'master') return await fail('role', 'Обліковка цього майстра має іншу роль — змініть вручну в CRM.');
    if (!u) {
      // Номер уже у другой учётки салона (владелец/админ) — роль сами не меняем, вторую учётку не плодим.
      const byPhone = ph && (await client.query(`SELECT id FROM users WHERE tenant_id=$1 AND right(regexp_replace(COALESCE(phone,''),'\\D','','g'),9)=$2`,
        [tenantId, last9(ph)])).rows[0];
      if (byPhone) return await fail('phone_used', 'Цей номер уже має іншу обліковку CRM — привʼяжіть вручну.');
    }
    const result = { master_id: m.id };
    const mu = await client.query(
      `UPDATE masters SET phone = CASE WHEN COALESCE(phone,'')='' THEN $1 ELSE phone END,
              telegram_id = CASE WHEN $4::boolean OR telegram_id IS NULL THEN $2 ELSE telegram_id END
        WHERE id=$3 RETURNING (phone IS NOT DISTINCT FROM $1) AS phone_set`, [ph, tgId, m.id, !!opts.forceMasterTg]);
    result.master_phone_filled = !m.phone && !!ph && mu.rows[0].phone_set;
    if (u) {
      await client.query(
        `UPDATE users SET telegram_id=$1,
                phone = CASE WHEN COALESCE(phone,'')='' AND $4::text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users x WHERE x.tenant_id=$3 AND x.phone=$4) THEN $4 ELSE phone END,
                updated_at=NOW() WHERE id=$2`, [tgId, u.id, tenantId, ph]);
      result.user_id = u.id; result.user_created = false; result.tg_was_set = !!u.telegram_id;
    } else {
      const role = (await client.query(`SELECT id FROM roles WHERE code='master' AND tenant_id=$1 LIMIT 1`, [tenantId])).rows[0];
      if (!role) return await fail('no_role', 'У салоні немає ролі «Майстер».');
      const ins = await client.query(
        `INSERT INTO users (tenant_id, phone, display_name, role_id, telegram_id, master_id, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING id`, [tenantId, ph, m.name, role.id, tgId, m.id]);
      result.user_id = ins.rows[0].id; result.user_created = true;
    }
    if (own) await client.query('COMMIT');
    return { ok: true, master: m, result };
  } catch (e) {
    if (own) await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return { error: 'conflict', message: 'Конфлікт унікальності (номер або Telegram уже зайняті).' };
    throw e;
  } finally { if (own) client.release(); }
}

/**
 * Автоузнавание мастера по ПРОВЕРЕННОМУ номеру (Босс 04.11): совпал ровно с одним работающим мастером →
 * привязка Telegram и, если нужно, создание учётки «Майстер». Возвращает
 *   {master:false[, reason]} | {master:true, linked:true, created:bool, master_id, name}
 */
async function recognize(pool, tenantId, uid, phone) {
  const l9 = last9(phone);
  if (!l9) return { master: false };
  // номер у двух+ мастеров или учётка другой роли — findByPhone вернёт null; отличаем, чтобы записать конфликт
  const m = await findByPhone(pool, tenantId, phone);
  if (!m) {
    const any = await pool.query(
      `SELECT COUNT(DISTINCT m.id)::int n FROM masters m
         LEFT JOIN users u ON u.master_id=m.id AND u.tenant_id=m.tenant_id AND u.merged_into IS NULL
        WHERE m.tenant_id=$1 AND ${WORKING}
          AND (right(regexp_replace(COALESCE(m.phone,''),'\\D','','g'),9)=$2 OR right(regexp_replace(COALESCE(u.phone,''),'\\D','','g'),9)=$2)`,
      [tenantId, l9]);
    const n = any.rows[0].n;
    if (n) {
      const reason = n > 1 ? 'phone_many_masters' : 'role';
      await auditConflict(pool, uid, reason, null, { masters: n });
      return { master: false, reason };
    }
    return { master: false };
  }
  // уже привязан этот же TG к учётке — ничего не пишем
  if (m.user_id && m.user_tg === Number(uid)) return { master: true, linked: true, created: false, master_id: m.master_id, name: m.master_name };
  const r = await linkMasterAccount(pool, tenantId, m.master_id, uid, phone);
  if (r.error) {
    await auditConflict(pool, uid, r.error, m.master_id);
    return { master: false, reason: r.error };
  }
  await audit(pool, r.result.user_created ? 'master.account_auto_create' : 'master.tg_link_auto', m.master_id,
    { user_id: r.result.user_id, tg: Number(uid), via: 'verified_contact', master_phone_filled: r.result.master_phone_filled });
  return { master: true, linked: true, created: !!r.result.user_created, master_id: m.master_id, name: m.master_name };
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

/** ✔ по старой заявке (до 04.11) — та же привязка linkMasterAccount + отметка заявки, в одной транзакции. */
async function approveClaim(pool, tenantId, claimId, deciderTg) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const c = (await client.query(`SELECT * FROM master_claims WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [claimId, tenantId])).rows[0];
    if (!c) { await client.query('ROLLBACK'); return { error: 'not_found' }; }
    if (c.status !== 'pending') { await client.query('ROLLBACK'); return { error: 'decided', status: c.status }; }
    const r = await linkMasterAccount(pool, tenantId, c.master_id, c.tg_user_id, c.phone, { client, forceMasterTg: true });
    if (r.error) { await client.query('ROLLBACK'); return r; }
    await client.query(`UPDATE master_claims SET status='approved', decided_by=$2, decided_at=NOW(), result=$3 WHERE id=$1`,
      [c.id, deciderTg, JSON.stringify(r.result)]);
    await client.query(
      `INSERT INTO audit_log (user_id, user_label, action, entity, entity_id, ip, meta)
       VALUES (NULL, $1, 'master.claim_approve', 'master', $2, NULL, $3)`,
      [`tg:${deciderTg}`, c.master_id, JSON.stringify({ claim: c.id, ...r.result })]);
    await client.query('COMMIT');
    return { ok: true, claim: c, master: r.master, result: r.result };
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

module.exports = { last9, canonPhone, findByPhone, recognize, linkMasterAccount, masterUserByTg, issueMasterSession,
  approvers, approveClaim, rejectClaim, onClaimCallback, SESSION_HOURS };
