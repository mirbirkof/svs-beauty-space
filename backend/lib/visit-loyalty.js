/* lib/visit-loyalty.js — лояльність навколо оплаченого візиту (Босс 04.11, loyalty-0411).
 *
 *  1) Майстер як клієнт: якщо картка клієнта належить ПРАЦЮЮЧОМУ майстру (masters.client_id
 *     або збіг останніх 9 цифр телефону з masters.phone / users.phone; active + staff_role
 *     master + надає послуги — та сама умова, що в lib/master-link), кешбек за візит
 *     не нараховується. Звільнили (active=false / інша роль) → знову звичайний клієнт.
 *
 *  2) Бонуси майстру за клієнта: окремо за кожну умову (за замовчуванням по 0.5% від
 *     реально сплаченої суми візиту, максимум 1.5%) на бонусний рахунок КЛІЄНТСЬКОЇ картки
 *     самого майстра (нема — знаходимо за телефоном або створюємо й привʼязуємо):
 *       return — клієнт уже мав оплачений візит у цього майстра раніше (інший день);
 *       rebook — у день візиту створено наступний запис до цього майстра;
 *       rating — клієнт поставив майстру ≥ порогу зірок (за замовчуванням 5).
 *     Не нараховуємо: клієнт = будь-який працюючий майстер; візит скасовано / неоплачений;
 *     сума 0. Ідемпотентно: один рядок master_loyalty_rewards на (візит, умова).
 *     Скасування оплати / видалення візиту → сторно (рядок лишається зі status='reversed').
 *
 *  3) Оцінка візиту клієнтом (бот і мініап — ОДНА функція rateVisit): лише власний
 *     оплачений візит, одна оцінка на візит, змінити можна протягом 24 год, 1–3⭐ → тихе
 *     повідомлення власнику. Бонус за оцінку нараховується після закриття 24-годинного
 *     вікна (оцінка вже остаточна — не треба сторнувати, якщо клієнт передумав).
 *
 *  Налаштування — app_settings.master_loyalty (адмінка «Бонуси»). */
const { getPool } = require('../db-pg');
const { getSetting, setSetting } = require('./settings');
const bonusLib = require('./bonus');

const WORKING = `m.active AND COALESCE(m.staff_role,'master')='master' AND COALESCE(m.provides_services,true)`;
const DEFAULTS = { enabled: true, return_pct: 0.5, rebook_pct: 0.5, rating_pct: 0.5, rating_min: 5 };
const CONDITIONS = ['return', 'rebook', 'rating'];
const LABEL = { return: 'повернення клієнта', rebook: 'перезапис у день візиту', rating: 'висока оцінка' };
const RATE_EDIT_HOURS = 24;
const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

async function getConfig() {
  const v = await getSetting('master_loyalty', null);
  const c = { ...DEFAULTS, ...(v && typeof v === 'object' ? v : {}) };
  for (const k of ['return_pct', 'rebook_pct', 'rating_pct']) c[k] = Math.min(10, Math.max(0, Number(c[k]) || 0));
  c.rating_min = Math.min(5, Math.max(1, Math.round(Number(c.rating_min) || 5)));
  c.enabled = c.enabled !== false;
  return c;
}
async function saveConfig(patch = {}, userId = null) {
  const cur = await getConfig();
  const next = { ...cur };
  if (patch.enabled != null) next.enabled = !!patch.enabled;
  for (const k of ['return_pct', 'rebook_pct', 'rating_pct']) {
    if (patch[k] == null) continue;
    const n = Number(patch[k]);
    if (!Number.isFinite(n) || n < 0 || n > 10) throw new Error(`invalid-${k}`);
    next[k] = round2(n);
  }
  if (patch.rating_min != null) {
    const n = Math.round(Number(patch.rating_min));
    if (!(n >= 1 && n <= 5)) throw new Error('invalid-rating_min');
    next.rating_min = n;
  }
  await setSetting('master_loyalty', next, userId);
  return getConfig();
}

// ── майстер як клієнт ────────────────────────────────────────────────
/** Працюючий майстер, якому належить картка клієнта → {id, name} | null. */
async function workingMasterOfClient(clientId, db = getPool()) {
  if (!clientId) return null;
  const r = await db.query(
    `WITH c AS (SELECT id, right(regexp_replace(COALESCE(phone,''),'\\D','','g'),9) AS p9 FROM clients WHERE id=$1)
     SELECT m.id, m.name FROM masters m, c
      WHERE ${WORKING}
        AND (m.client_id = c.id
          OR (length(c.p9)=9 AND (right(regexp_replace(COALESCE(m.phone,''),'\\D','','g'),9) = c.p9
               OR EXISTS (SELECT 1 FROM users u WHERE u.master_id=m.id AND COALESCE(u.is_active,true)
                           AND right(regexp_replace(COALESCE(u.phone,''),'\\D','','g'),9) = c.p9))))
      ORDER BY (m.client_id = c.id) DESC, m.id LIMIT 1`, [clientId]);
  return r.rows[0] || null;
}

/** Клієнтська картка майстра: masters.client_id → за телефоном → створити. Привʼязує masters.client_id. */
async function ensureMasterClientCard(masterId, db = getPool()) {
  const m = (await db.query(
    `SELECT m.id, m.name, m.client_id,
            COALESCE(NULLIF(regexp_replace(COALESCE(m.phone,''),'\\D','','g'),''),
              (SELECT regexp_replace(u.phone,'\\D','','g') FROM users u
                WHERE u.master_id=m.id AND COALESCE(u.is_active,true) AND COALESCE(u.phone,'')<>'' ORDER BY u.id LIMIT 1)) AS digits
       FROM masters m WHERE m.id=$1`, [masterId])).rows[0];
  if (!m) return null;
  if (m.client_id) {
    const ok = await db.query(`SELECT id FROM clients WHERE id=$1 AND deleted_at IS NULL`, [m.client_id]);
    if (ok.rows[0]) return Number(m.client_id);
  }
  const p9 = String(m.digits || '').slice(-9);
  let cid = null;
  if (p9.length === 9) {
    const c = await db.query(
      `SELECT id FROM clients WHERE deleted_at IS NULL AND right(regexp_replace(COALESCE(phone,''),'\\D','','g'),9)=$1
        ORDER BY COALESCE(total_visits,0) DESC, id LIMIT 1`, [p9]);
    if (c.rows[0]) cid = Number(c.rows[0].id);
  }
  if (!cid) {
    const phone = p9.length === 9 ? '380' + p9 : null;
    cid = Number((await db.query(
      `INSERT INTO clients (name, phone, notes) VALUES ($1,$2,$3) RETURNING id`,
      [m.name || `Майстер #${m.id}`, phone, 'Клієнтська картка майстра (бонуси від клієнтів), створена автоматично'])).rows[0].id);
  }
  await db.query(`UPDATE masters SET client_id=$2 WHERE id=$1 AND client_id IS DISTINCT FROM $2`, [m.id, cid]);
  return cid;
}

// ── бонуси майстру ───────────────────────────────────────────────────
async function _loadVisit(apptId, db) {
  return (await db.query(
    `SELECT a.id, a.client_id, a.master_id, a.status, a.pay_settled_at, a.starts_at, a.tenant_id,
            COALESCE(a.pay_bonus_base, 0)::float AS base,
            (a.starts_at AT TIME ZONE 'Europe/Kyiv')::date AS kday
       FROM appointments a WHERE a.id=$1`, [apptId])).rows[0] || null;
}

/** Чи виконано умову для візиту (без нарахування). */
async function conditionMet(v, cond, cfg, db) {
  if (cond === 'return') {
    const r = await db.query(
      `SELECT 1 FROM appointments p
        WHERE p.client_id=$1 AND p.master_id=$2 AND p.id<>$3
          AND (p.starts_at AT TIME ZONE 'Europe/Kyiv')::date < $4::date
          AND p.status NOT IN ('cancelled','no_show')
          AND (p.pay_settled_at IS NOT NULL OR p.status='done') LIMIT 1`,
      [v.client_id, v.master_id, v.id, v.kday]);
    return !!r.rows[0];
  }
  if (cond === 'rebook') {
    const r = await db.query(
      `SELECT 1 FROM appointments n
        WHERE n.client_id=$1 AND n.master_id=$2 AND n.id<>$3
          AND (n.starts_at AT TIME ZONE 'Europe/Kyiv')::date > $4::date
          AND (n.created_at AT TIME ZONE 'Europe/Kyiv')::date = $4::date
          AND n.status NOT IN ('cancelled','no_show') LIMIT 1`,
      [v.client_id, v.master_id, v.id, v.kday]);
    return !!r.rows[0];
  }
  if (cond === 'rating') {
    const r = await db.query(
      `SELECT master_stars FROM visit_ratings WHERE appointment_id=$1 AND master_stars IS NOT NULL
          AND COALESCE(updated_at, created_at) <= NOW() - interval '${RATE_EDIT_HOURS} hours'`, [v.id]);
    return !!(r.rows[0] && Number(r.rows[0].master_stars) >= cfg.rating_min);
  }
  return false;
}

/** Нарахувати майстру бонус за умову cond по візиту. → {granted, amount, reason}. Ніколи не кидає. */
async function grant(apptId, cond, opts = {}) {
  const db = opts.db || getPool();
  try {
    if (!CONDITIONS.includes(cond)) return { granted: false, reason: 'bad-condition' };
    const cfg = await getConfig();
    if (!cfg.enabled) return { granted: false, reason: 'disabled' };
    const pct = Number(cfg[`${cond}_pct`]) || 0;
    if (pct <= 0) return { granted: false, reason: 'zero-percent' };
    const v = await _loadVisit(apptId, db);
    if (!v || !v.master_id || !v.client_id) return { granted: false, reason: 'no-visit' };
    if (['cancelled', 'no_show'].includes(v.status) || !v.pay_settled_at) return { granted: false, reason: 'not-paid' };
    if (!(v.base > 0)) return { granted: false, reason: 'zero-check' };
    const master = (await db.query(`SELECT m.id, m.name FROM masters m WHERE m.id=$1 AND ${WORKING}`, [v.master_id])).rows[0];
    if (!master) return { granted: false, reason: 'master-not-working' };
    if (await workingMasterOfClient(v.client_id, db)) return { granted: false, reason: 'client-is-master' };
    const done = (await db.query(
      `SELECT status FROM master_loyalty_rewards WHERE appointment_id=$1 AND condition=$2`, [v.id, cond])).rows[0];
    if (done && done.status === 'accrued') return { granted: false, reason: 'already' };
    if (!(await conditionMet(v, cond, cfg, db))) return { granted: false, reason: 'condition-not-met' };

    const mcid = await ensureMasterClientCard(v.master_id, db);
    if (!mcid) return { granted: false, reason: 'no-master-card' };
    const amount = round2(v.base * pct / 100);
    if (!(amount > 0)) return { granted: false, reason: 'zero-amount' };
    // claim: новий рядок або повторна видача після сторно (повторна оплата того ж візиту)
    const claim = await db.query(
      `INSERT INTO master_loyalty_rewards (master_id, master_client_id, appointment_id, client_id, condition, percent, check_amount, amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id, appointment_id, condition) DO UPDATE
         SET status='accrued', master_id=EXCLUDED.master_id, master_client_id=EXCLUDED.master_client_id,
             percent=EXCLUDED.percent, check_amount=EXCLUDED.check_amount, amount=EXCLUDED.amount,
             bonus_tx_id=NULL, reversed_at=NULL, reverse_reason=NULL, created_at=NOW()
         WHERE master_loyalty_rewards.status='reversed'
       RETURNING id`, [v.master_id, mcid, v.id, v.client_id, cond, pct, v.base, amount]);
    if (!claim.rows[0]) return { granted: false, reason: 'already' };
    let tx;
    try {
      tx = await bonusLib.accrue({ clientId: mcid, amount, sourceType: `master_${cond}`, sourceId: v.id,
        description: `Бонус майстру: ${LABEL[cond]} (візит #${v.id}, ${pct}%)` });
    } catch (e) {
      await db.query(`DELETE FROM master_loyalty_rewards WHERE id=$1 AND bonus_tx_id IS NULL`, [claim.rows[0].id]).catch(() => {});
      throw e;
    }
    await db.query(`UPDATE master_loyalty_rewards SET bonus_tx_id=$2 WHERE id=$1`, [claim.rows[0].id, tx ? tx.id : null]);
    return { granted: true, amount, master_client_id: mcid };
  } catch (e) {
    console.error('[visit-loyalty/grant]', apptId, cond, e.message);
    return { granted: false, reason: 'error', error: e.message };
  }
}

/** Після оплати: умови, які вже можна перевірити (повернення; перезапис, якщо вже створено). */
async function onVisitPaid(apptId) {
  const out = {};
  for (const c of ['return', 'rebook']) out[c] = await grant(apptId, c);
  return out;
}

/** Сторно всіх бонусів майстру по візиту (скасування оплати / видалення візиту). Ніколи не кидає. */
async function reverseVisit(apptId, reason = 'скасування оплати', opts = {}) {
  const db = opts.db || getPool();
  const done = [];
  try {
    const rows = (await db.query(
      `UPDATE master_loyalty_rewards SET status='reversed', reversed_at=NOW(), reverse_reason=$2
        WHERE appointment_id=$1 AND status='accrued' RETURNING *`, [apptId, reason])).rows;
    for (const r of rows) {
      let ok = false, err = null;
      for (let i = 1; i <= 3 && !ok; i++) {
        try {
          await bonusLib.manualAdjust({ clientId: r.master_client_id, amount: -Number(r.amount),
            description: `Сторно бонусу майстру: ${LABEL[r.condition]} (візит #${apptId}, ${reason})`,
            sourceType: `master_${r.condition}_reversal`, sourceId: apptId });
          ok = true;
        } catch (e) { err = e; if (i < 3) await new Promise(res => setTimeout(res, 200 * i)); }
      }
      if (!ok) {
        console.error(`[visit-loyalty/reverse] НЕ ВИКОНАНО візит #${apptId} майстер ${r.master_id}: ${err && err.message}`);
        try {
          await require('./automations').createAdminTask({
            tenant_id: r.tenant_id, client_id: r.master_client_id, appointment_id: apptId, priority: 'high',
            tag: `master-bonus-reverse-${apptId}-${r.condition}`, cooldownDays: 30,
            title: `Зняти бонус майстру вручну: ${r.amount} б.`,
            description: `Сторно бонусу майстру (${LABEL[r.condition]}) за візит #${apptId} не пройшло: ${err && err.message}. Ймовірно, бонуси вже витрачені.`,
          });
        } catch (_) {}
      }
      // відвʼязуємо нарахування від візиту: інакше при повторній оплаті dup-guard accrue()
      // поверне старий TX і бонус «не нарахується» (той самий прийом, що й у unpay кешбеку)
      await db.query(
        `UPDATE bonus_transactions SET source_id=NULL,
                description=COALESCE(description,'') || ' (сторновано)'
          WHERE client_id=$1 AND type='accrual' AND source_type=$2 AND source_id=$3`,
        [r.master_client_id, `master_${r.condition}`, apptId]).catch(() => {});
      done.push({ condition: r.condition, amount: Number(r.amount), ok });
    }
  } catch (e) { console.error('[visit-loyalty/reverse]', apptId, e.message); }
  return done;
}

/** Періодична перевірка (tick нагадувань, ~5 хв): перезапис до кінця дня візиту і
 *  оцінки, у яких закрилось 24-год вікно редагування. Лише свіжі візити (7 днів). */
async function tick(db = getPool()) {
  const cfg = await getConfig();
  if (!cfg.enabled) return { checked: 0 };
  const due = (await db.query(
    `SELECT a.id FROM appointments a
      WHERE a.pay_settled_at IS NOT NULL AND a.status NOT IN ('cancelled','no_show')
        AND a.master_id IS NOT NULL AND a.client_id IS NOT NULL AND COALESCE(a.pay_bonus_base,0) > 0
        AND a.starts_at > NOW() - interval '7 days'
        AND (NOT EXISTS (SELECT 1 FROM master_loyalty_rewards r WHERE r.appointment_id=a.id AND r.condition='rebook')
          OR (EXISTS (SELECT 1 FROM visit_ratings vr WHERE vr.appointment_id=a.id AND vr.master_stars >= $1)
              AND NOT EXISTS (SELECT 1 FROM master_loyalty_rewards r WHERE r.appointment_id=a.id AND r.condition='rating')))
      LIMIT 200`, [cfg.rating_min])).rows;
  let granted = 0;
  for (const r of due) {
    for (const c of ['rebook', 'rating']) { const g = await grant(r.id, c, { db }); if (g.granted) granted++; }
  }
  return { checked: due.length, granted };
}

// ── оцінка візиту ────────────────────────────────────────────────────
/** Оцінити майстра (field='master') або салон (field='salon') у власному оплаченому візиті.
 *  → {ok, stars, created, low_alert} | {error, message}. ownerNotify(text) — тихе сповіщення власнику. */
async function rateVisit({ apptId, clientId, telegramId, stars, field = 'master', ownerNotify }, db = getPool()) {
  stars = Math.round(Number(stars));
  if (!(stars >= 1 && stars <= 5)) return { error: 'bad-stars', message: 'Оцінка від 1 до 5 зірок.' };
  const col = field === 'salon' ? 'salon_stars' : 'master_stars';
  const own = (await db.query(
    `SELECT a.id, a.client_id, a.master_id, a.status, a.pay_settled_at, c.name AS client_name,
            COALESCE(NULLIF(m.online_title,''), m.name) AS master_name
       FROM appointments a JOIN clients c ON c.id=a.client_id LEFT JOIN masters m ON m.id=a.master_id
      WHERE a.id=$1 AND ${clientId ? 'a.client_id=$2' : 'c.telegram_id=$2'}`, [apptId, clientId || telegramId])).rows[0];
  if (!own) return { error: 'not-found', message: 'Цей візит не знайдено.' };
  if (!own.pay_settled_at || ['cancelled', 'no_show'].includes(own.status))
    return { error: 'not-paid', message: 'Оцінити можна після оплати візиту.' };
  const prev = (await db.query(
    `SELECT id, master_stars, salon_stars, created_at, created_at < NOW() - interval '${RATE_EDIT_HOURS} hours' AS locked
       FROM visit_ratings WHERE appointment_id=$1`, [apptId])).rows[0];
  if (prev && prev.locked && prev[col] != null)
    return { error: 'locked', message: 'Оцінку можна змінити лише протягом 24 годин.' };
  if (prev && Number(prev[col]) === stars) return { ok: true, stars, created: false, unchanged: true };
  await db.query(
    `INSERT INTO visit_ratings (appointment_id, client_id, master_id, ${col}) VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, appointment_id) DO UPDATE SET ${col}=EXCLUDED.${col}, updated_at=NOW()`,
    [apptId, own.client_id, own.master_id, stars]);
  let lowAlert = false;
  if (stars <= 3 && typeof ownerNotify === 'function') {
    try {
      await ownerNotify(`⚠️ Низька оцінка ${field === 'salon' ? 'салону' : 'майстра'}: ${'⭐'.repeat(stars)} від ${own.client_name || 'клієнта'}${own.master_name ? ' (майстер ' + own.master_name + ')' : ''}, візит #${apptId}. Варто звʼязатись.`);
      lowAlert = true;
    } catch (e) { console.error('[visit-loyalty/low-alert]', e.message); }
  }
  return { ok: true, stars, created: !prev, low_alert: lowAlert };
}

/** Тихе сповіщення власнику через бота салону (owner_chat_id з tenant_bot_settings). */
function ownerNotifier(tg, db = getPool()) {
  return async (text) => {
    const oc = (await db.query(
      `SELECT owner_chat_id FROM tenant_bot_settings
        WHERE tenant_id=current_tenant_id() AND owner_chat_id IS NOT NULL LIMIT 1`)).rows[0];
    if (!oc || !tg) return;
    await tg('sendMessage', { chat_id: oc.owner_chat_id, text, disable_notification: true });
  };
}

/** Історія бонусів майстру для CRM. */
async function masterRewards(masterId, limit = 100, db = getPool()) {
  const rows = (await db.query(
    `SELECT r.id, r.appointment_id, r.condition, r.percent::float, r.check_amount::float, r.amount::float,
            r.status, r.reverse_reason, r.created_at, r.reversed_at,
            to_char(a.starts_at AT TIME ZONE 'Europe/Kyiv','DD.MM.YYYY') AS visit_date,
            COALESCE(NULLIF(c.name,''),'Клієнт') AS client_name
       FROM master_loyalty_rewards r
       LEFT JOIN appointments a ON a.id=r.appointment_id LEFT JOIN clients c ON c.id=r.client_id
      WHERE r.master_id=$1 ORDER BY r.created_at DESC LIMIT $2`, [masterId, limit])).rows;
  const m = (await db.query(`SELECT client_id FROM masters WHERE id=$1`, [masterId])).rows[0];
  let balance = null;
  if (m && m.client_id) { try { balance = (await bonusLib.getBalance(m.client_id)).balance; } catch (_) {} }
  const total = round2(rows.filter(r => r.status === 'accrued').reduce((s, r) => s + r.amount, 0));
  const totalRev = round2(rows.filter(r => r.status === 'reversed').reduce((s, r) => s + r.amount, 0));
  return { items: rows.map(r => ({ ...r, label: LABEL[r.condition] })), total, total_reversed: totalRev, balance: balance != null ? Number(balance) : null,
    master_client_id: m ? m.client_id : null };
}

module.exports = { getConfig, saveConfig, workingMasterOfClient, ensureMasterClientCard, grant, onVisitPaid,
  reverseVisit, tick, rateVisit, ownerNotifier, masterRewards, conditionMet, LABEL, RATE_EDIT_HOURS, DEFAULTS };
