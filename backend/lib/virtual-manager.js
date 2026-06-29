/* lib/virtual-manager.js — «Віртуальний керуючий», шар 2 (автоматизації).
 *
 *  A) autoReviewRequests — після візиту автоматично просить клієнта оцінити сервіс
 *     (через Notification Hub). Негатив (1-3★) уже падає алертом керівнику у reputation.js.
 *  B) masterDailySchedules — зранку надсилає кожному майстру його розклad на день у Telegram.
 *
 *  Тіки запускаються з shop-api.js. Усе ідемпотентно: review_request_log + dedupKey,
 *  щоденний guard у app_settings. Нічого не дублюється навіть при рестартах/кількох тіках.
 */
const { getPool } = require('../db-pg');
const hub = require('./notification-hub');
const { getSetting, setSetting } = require('./settings');
const { shiftDaysByMaster } = require('./schedule-month');

const TENANT = '00000000-0000-0000-0000-000000000000';
const BASE = process.env.PUBLIC_BASE_URL || 'https://svs-shop-api-backup.onrender.com';

// Київська дата YYYY-MM-DD
function kyivDate(d = new Date()) { return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Kiev' }); }

// ── A) Авто-запит відгуку після візиту ──────────────────────────────────
async function autoReviewRequests(pool = getPool()) {
  let st;
  try { st = (await pool.query(`SELECT * FROM reputation_settings WHERE tenant_id=$1`, [TENANT])).rows[0]; } catch (_) {}
  st = st || { request_enabled: true, request_cooldown_days: 30 };
  if (st.request_enabled === false) return 0;
  const cooldown = st.request_cooldown_days || 30;

  // Завершені візити 2..48 год тому, клієнт з Telegram, по цьому візиту ще не просили,
  // і клієнта не турбували відгуком останні cooldown днів.
  const rows = (await pool.query(
    `SELECT a.id, a.client_id
       FROM appointments a JOIN clients c ON c.id=a.client_id
      WHERE a.status IN ('done','completed')
        AND a.ends_at < NOW() - interval '2 hours'
        AND a.ends_at > NOW() - interval '48 hours'
        AND c.telegram_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM review_request_log r WHERE r.appointment_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM review_request_log r WHERE r.client_id=a.client_id AND r.created_at > NOW() - ($1||' days')::interval)
      ORDER BY a.ends_at DESC LIMIT 50`, [cooldown])).rows;

  let sent = 0;
  for (const a of rows) {
    try {
      const c = (await pool.query(`SELECT name FROM clients WHERE id=$1`, [a.client_id])).rows[0] || {};
      const link = `${BASE}/p/feedback.html?c=${a.client_id}&a=${a.id}`;
      const body = `Дякуємо за візит${c.name ? ', ' + c.name : ''}! 💛\nБудь ласка, оцініть нас — це займе 10 секунд:\n${link}`;
      const out = await hub.enqueue({ clientId: a.client_id, body, category: 'transactional', priority: 'low', dedupKey: `review_req:${a.id}`, source: 'review-request-auto' });
      // лог завжди (навіть skip) — щоб не довбати клієнта повторно щотіку
      await pool.query(`INSERT INTO review_request_log (client_id, appointment_id, channel) VALUES ($1,$2,$3)`,
        [a.client_id, a.id, out.channel || 'telegram']);
      if (!out.skipped) sent++;
    } catch (e) { console.error('[vm] review-request', a.id, e.message); }
  }
  return sent;
}

// ── B) Ранковий розклад майстрам ─────────────────────────────────────────
async function masterDailySchedules(pool = getPool()) {
  const today = kyivDate();
  if ((await getSetting('vm_master_sched_sent', null)) === today) return 0; // вже надсилали сьогодні
  // notify_telegram — text-колонка: шлемо всім із telegram_id, окрім явного відключення.
  const masters = (await pool.query(
    `SELECT id, name, telegram_id FROM masters
      WHERE COALESCE(active,true)=true AND telegram_id IS NOT NULL
        AND COALESCE(LOWER(notify_telegram),'') NOT IN ('off','false','no','0','disabled','none')`)).rows;

  let sent = 0;
  for (const m of masters) {
    try {
      const appts = (await pool.query(
        `SELECT a.starts_at, COALESCE(cl.name,'клієнт') cln, COALESCE(s.name,'послуга') svn
           FROM appointments a LEFT JOIN clients cl ON cl.id=a.client_id LEFT JOIN services s ON s.id=a.service_id
          WHERE a.master_id=$1 AND a.status NOT IN ('cancelled','noshow')
            AND (a.starts_at AT TIME ZONE 'Europe/Kiev')::date = $2::date
          ORDER BY a.starts_at`, [m.id, today])).rows;
      let body;
      if (!appts.length) body = `Доброго ранку, ${m.name}! ☀️\nНа сьогодні записів поки немає. Гарного дня!`;
      else {
        const lines = appts.map(x => {
          const t = new Date(x.starts_at).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kiev', hour: '2-digit', minute: '2-digit' });
          return `🕐 ${t} — ${x.cln} · ${x.svn}`;
        }).join('\n');
        body = `Доброго ранку, ${m.name}! ☀️\nВаш розклад на сьогодні (${appts.length}):\n${lines}`;
      }
      await hub.enqueue({ recipient: String(m.telegram_id), channel: 'telegram', body,
        category: 'transactional', priority: 'normal', source: 'vm-master-schedule', dedupKey: `msched:${m.id}:${today}` });
      sent++;
    } catch (e) { console.error('[vm] master-schedule', m.id, e.message); }
  }
  await setSetting('vm_master_sched_sent', today);
  return sent;
}

// ── C) Ранковий звіт собственнику ────────────────────────────────────────
// Щоранку: вчорашня каса (нал/безнал, послуги/товари, чеків), оборот місяця
// проти плану (%), записи на сьогодні. Шлеться в ADMIN_TG_CHAT раз на добу.
function _money(n) { return Math.round(Number(n) || 0).toLocaleString('uk-UA') + ' ₴'; }

async function ownerDailyReport(pool = getPool()) {
  const chat = process.env.ADMIN_TG_CHAT;
  if (!chat) return 0;
  const today = kyivDate();
  if ((await getSetting('vm_owner_report_sent', null)) === today) return 0; // вже слали сьогодні

  const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows).catch(() => []);

  // Вчора (київський день)
  const yRows = await q(
    `SELECT category, method, COALESCE(SUM(amount),0)::numeric v, COUNT(*)::int n
       FROM cash_operations
      WHERE type='in' AND category IN ('sale_service','sale_product')
        AND (created_at AT TIME ZONE 'Europe/Kiev')::date = (NOW() AT TIME ZONE 'Europe/Kiev')::date - 1
      GROUP BY category, method`);
  let ySvc = 0, yProd = 0, yCash = 0, yCard = 0, yChecks = 0;
  for (const r of yRows) {
    const v = Number(r.v);
    if (r.category === 'sale_service') ySvc += v; else yProd += v;
    if (r.method === 'cash') yCash += v; else yCard += v;
    yChecks += r.n;
  }
  const yTotal = ySvc + yProd;

  // Місяць: оборот (факт)
  const mRow = (await q(
    `SELECT COALESCE(SUM(amount),0)::numeric v
       FROM cash_operations
      WHERE type='in' AND category IN ('sale_service','sale_product')
        AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev')`))[0] || { v: 0 };
  const mRevenue = Number(mRow.v);

  // Місяць: план = Σ по майстрах (plan_per_shift × змін у графіку)
  let mPlan = 0;
  try {
    const now = new Date();
    const ym = kyivDate().slice(0, 7);
    const [year, month] = ym.split('-').map(Number);
    const plans = await q(
      `SELECT mp.master_id, mp.plan_per_shift, mp.plan_total, mp.auto_from_shifts
         FROM master_monthly_plans mp JOIN masters m ON m.id=mp.master_id AND COALESCE(m.active,true)=true
        WHERE mp.year=$1 AND mp.month=$2`, [year, month]);
    const grid = await shiftDaysByMaster(pool, ym).catch(() => new Map());
    for (const p of plans) {
      const auto = p.auto_from_shifts;
      mPlan += auto ? Math.round(Number(p.plan_per_shift) * (grid.get(p.master_id) || 0)) : Number(p.plan_total);
    }
  } catch (_) { mPlan = 0; }
  const pct = mPlan > 0 ? Math.round(mRevenue / mPlan * 100) : null;

  // Сьогодні: записів заплановано
  const tRow = (await q(
    `SELECT COUNT(*)::int n FROM appointments
      WHERE status NOT IN ('cancelled','noshow')
        AND (starts_at AT TIME ZONE 'Europe/Kiev')::date = (NOW() AT TIME ZONE 'Europe/Kiev')::date`))[0] || { n: 0 };

  // Закриття заявок за місяць (без bp_deleted — то синк-артефакти, не відмови клієнтів).
  // served = проведені (done+confirmed), lost = реальні відмови + noshow.
  const clRow = (await q(
    `SELECT COUNT(*) FILTER (WHERE status IN ('done','confirmed'))::int served,
            COUNT(*) FILTER (WHERE status IN ('noshow','cancelled'))::int lost
       FROM appointments
      WHERE starts_at >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev')
        AND starts_at <= NOW() AND bp_state IS DISTINCT FROM 'bp_deleted'`))[0] || { served: 0, lost: 0 };
  const clFinished = clRow.served + clRow.lost;
  const closurePct = clFinished > 0 ? Math.round(clRow.served / clFinished * 100) : null;

  const planLine = pct != null
    ? `📈 <b>Місяць:</b> ${_money(mRevenue)} з ${_money(mPlan)} плану (<b>${pct}%</b>)`
    : `📈 <b>Місяць:</b> ${_money(mRevenue)} обороту`;
  const closureLine = closurePct != null
    ? `🎯 <b>Закриття заявок:</b> ${closurePct}% ${closurePct >= 80 ? '✅' : '⚠️ нижче цілі 80%'} (${clRow.served} з ${clFinished})`
    : '';
  const body =
    `☀️ <b>Ранковий звіт</b>\n\n` +
    `💰 <b>Вчора в касі: ${_money(yTotal)}</b> (${yChecks} чек.)\n` +
    `   • Послуги ${_money(ySvc)} · Товари ${_money(yProd)}\n` +
    `   • Готівка ${_money(yCash)} · Безнал ${_money(yCard)}\n\n` +
    `${planLine}\n` +
    (closureLine ? closureLine + '\n' : '') +
    `\n📅 <b>Сьогодні записів:</b> ${tRow.n}`;

  await hub.enqueue({ recipient: String(chat), channel: 'telegram', body,
    category: 'transactional', priority: 'normal', source: 'vm-owner-report', dedupKey: `ownerrep:${today}` });
  await setSetting('vm_owner_report_sent', today);
  return 1;
}

module.exports = { autoReviewRequests, masterDailySchedules, ownerDailyReport };
