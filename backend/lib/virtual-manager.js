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
const { runAs, DEFAULT_TENANT_ID } = require('./tenant');
const hub = require('./notification-hub');
const { getSetting, setSetting } = require('./settings');
const { shiftDaysByMaster } = require('./schedule-month');

const TENANT = DEFAULT_TENANT_ID; // салон Босса (раніше тут був НЕІСНУЮЧИЙ uuid ...000 — reputation_settings не знаходились)
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

// План обороту на місяць = Σ по активних майстрах (plan_per_shift × змін у графіку).
// Спільний для ранкового звіту і плану дня — щоб числа не розходились.
async function _monthPlanTotal(pool, tenantId = null) {
  try {
    const ym = kyivDate().slice(0, 7);
    const [year, month] = ym.split('-').map(Number);
    const plans = (await pool.query(
      `SELECT mp.master_id, mp.plan_per_shift, mp.plan_total, mp.auto_from_shifts
         FROM master_monthly_plans mp JOIN masters m ON m.id=mp.master_id AND COALESCE(m.active,true)=true
        WHERE mp.year=$1 AND mp.month=$2 AND ($3::uuid IS NULL OR mp.tenant_id = $3)`, [year, month, tenantId])).rows;
    const grid = await shiftDaysByMaster(pool, ym).catch(() => new Map());
    let total = 0;
    for (const p of plans) {
      total += p.auto_from_shifts ? Math.round(Number(p.plan_per_shift) * (grid.get(p.master_id) || 0)) : Number(p.plan_total);
    }
    return total;
  } catch (_) { return 0; }
}

// Отримувачі фінзвіту = ВСІ власники салону з привʼязаним Telegram (SaaS-логіка:
// звіт автоматично кожному власнику КОНКРЕТНОГО салону, не в один глобальний чат).
// Власник = роль code='owner' АБО повний доступ (permissions '*') АБО високий level.
async function _ownerRecipients(pool, tenantId) {
  const rows = (await pool.query(
    `SELECT DISTINCT u.telegram_id
       FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.tenant_id = $1 AND COALESCE(u.is_active, true) = true
        AND u.telegram_id IS NOT NULL
        -- Власник = роль owner АБО ПОВНИЙ доступ (permissions містить САМЕ '*').
        -- НЕ text LIKE '%*%': "crm.*" адміна теж містить зірочку → фінзвіт витік би адмінам.
        AND (r.code = 'owner' OR r.name ILIKE '%власн%' OR r.name ILIKE '%owner%'
             OR r.permissions::jsonb ? '*')`,
    [tenantId]).catch(() => ({ rows: [] }))).rows;
  return rows.map(r => String(r.telegram_id)).filter(Boolean);
}

// Пройти по ВСІХ активних салонах і надіслати кожному його власникам.
async function ownerDailyReportAll(pool = getPool()) {
  let sent = 0;
  const tenants = (await runAs(null, () => pool.query(
    `SELECT id FROM tenants WHERE COALESCE(status,'active') NOT IN ('suspended','cancelled')`))
    .then(r => r.rows).catch(() => [])) || [];
  for (const t of tenants) {
    try { sent += await ownerDailyReport(pool, t.id); }
    catch (e) { console.error('[vm] owner-report tenant', t.id, e.message); }
  }
  return sent;
}

// Фінзвіт для ОДНОГО салону — всім його власникам. tenantId обовʼязковий (SaaS).
async function ownerDailyReport(pool = getPool(), tenantId = DEFAULT_TENANT_ID) {
  const today = kyivDate();
  // Отримувачі: власники салону + (для платформи) ADMIN_TG_CHAT як сумісність.
  const recipients = new Set(await _ownerRecipients(pool, tenantId));
  if (tenantId === DEFAULT_TENANT_ID && process.env.ADMIN_TG_CHAT) recipients.add(String(process.env.ADMIN_TG_CHAT));
  if (!recipients.size) return 0; // немає кому слати

  // Повний звіт (за вчора) — єдиний модуль owner-report (каса, клієнти нові/повторні,
  // кращий майстер, витрати, залишок, завантаженість, вільно завтра, записи на 7 днів,
  // очікувана виручка, кого повернути, no-show). Той самий модуль живить меню власника.
  const { buildDailyReport, formatReport } = require('./owner-report');
  const yst = new Date(Date.now() - 864e5).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kiev' });
  const rep = await buildDailyReport(pool, tenantId, yst);
  const body = '☀️ ' + formatReport(rep, 'Ранковий звіт (за вчора)');

  // Розсилка КОЖНОМУ власнику. dedupKey per (салон, власник, день) → хаб не
  // задублює навіть при повторному тіку крона (ON CONFLICT dedup_key DO NOTHING).
  let sent = 0;
  for (const rcpt of recipients) {
    try {
      await hub.enqueue({ recipient: rcpt, channel: 'telegram', body,
        category: 'transactional', priority: 'normal', source: 'vm-owner-report',
        dedupKey: `ownerrep:${tenantId}:${today}:${rcpt}` });
      sent++;
    } catch (e) { console.error('[vm] owner-report send', rcpt, e.message); }
  }
  return sent;
}

// ── D) Ранковий план дня адміну ──────────────────────────────────────────
// Скільки треба зробити сьогодні для плану, що вже записано, і КОГО дозаписати
// (клієнти «під загрозою»: були 2+ рази, зникли 75-180 днів — їх легше повернути).
async function adminDayPlan(pool = getPool()) {
  const chat = process.env.ADMIN_TG_CHAT;
  if (!chat) return 0;
  const today = kyivDate();
  if ((await getSetting('vm_admin_dayplan_sent', null)) === today) return 0;

  const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows).catch(() => []);

  // Денна ціль = план місяця / днів у місяці
  const mPlan = await _monthPlanTotal(pool);
  const d = new Date();
  const parts = {}; for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) parts[x.type] = x.value;
  const daysInMonth = new Date(+parts.year, +parts.month, 0).getDate();
  const dailyTarget = mPlan > 0 ? Math.round(mPlan / daysInMonth) : 0;

  // Сьогодні вже записано (очікувана виручка)
  const tRow = (await q(
    `SELECT COUNT(*)::int n, COALESCE(SUM(COALESCE(real_amount,price,0)),0)::numeric v
       FROM appointments
      WHERE status NOT IN ('cancelled','noshow')
        AND (starts_at AT TIME ZONE 'Europe/Kiev')::date = (NOW() AT TIME ZONE 'Europe/Kiev')::date`))[0] || { n: 0, v: 0 };
  const booked = Number(tRow.v);
  const gap = dailyTarget > 0 ? Math.max(0, dailyTarget - booked) : 0;

  // Кого дозаписати: «під загрозою» з телефоном (легше повернути, ніж знайти нового)
  const calls = await q(
    `WITH base AS (
       SELECT c.id, c.name, c.phone, MAX(a.starts_at) last,
              COUNT(*) FILTER (WHERE a.status NOT IN ('cancelled','noshow')) freq
         FROM clients c JOIN appointments a ON a.client_id=c.id
        WHERE c.phone IS NOT NULL GROUP BY c.id, c.name, c.phone)
     SELECT name, phone FROM base
      WHERE freq >= 2 AND last < NOW()-INTERVAL '75 days' AND last > NOW()-INTERVAL '180 days'
      ORDER BY last DESC LIMIT 6`);

  const callLines = calls.length
    ? calls.map(c => `   • ${c.name || 'клієнт'} — ${c.phone}`).join('\n')
    : '   • немає кандидатів — усі активні 👍';
  const planLine = dailyTarget > 0
    ? `🎯 <b>Ціль на сьогодні:</b> ${_money(dailyTarget)}\n📌 Вже записано: ${_money(booked)} (${tRow.n} зап.)` +
      (gap > 0 ? `\n⚠️ <b>Дозаписати ще на ${_money(gap)}</b>` : `\n✅ Денну ціль уже виконано!`)
    : `📌 Сьогодні записано: ${_money(booked)} (${tRow.n} зап.)`;

  const body =
    `📋 <b>План дня</b> (адміну)\n\n` +
    `${planLine}\n\n` +
    `📞 <b>Подзвонити — повернути клієнтів:</b>\n${callLines}\n\n` +
    `💡 Запропонуй зручний час і додаткову послугу — це закриє денну ціль.`;

  await hub.enqueue({ recipient: String(chat), channel: 'telegram', body,
    category: 'transactional', priority: 'normal', source: 'vm-admin-dayplan', dedupKey: `dayplan:${today}` });
  await setSetting('vm_admin_dayplan_sent', today);
  return 1;
}

// ── E) Тижневі / місячні нагадування керуючому ───────────────────────────
// Понеділок — закупка матеріалів (+ скільки позицій на нулі). 5 і 20 числа —
// нагадування завести тайного покупця (2-3/міс). Шлеться в ADMIN_TG_CHAT.
async function weeklyMonthlyReminders(pool = getPool()) {
  const chat = process.env.ADMIN_TG_CHAT;
  if (!chat) return 0;
  const today = kyivDate();
  // день тижня (0=Нд..6=Сб) і число місяця — з київської дати
  const dow = new Date(today + 'T12:00:00Z').getUTCDay();
  const dom = Number(today.slice(8, 10));
  const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows).catch(() => []);
  let sent = 0;

  // Понеділок — закупка
  if (dow === 1 && (await getSetting('vm_purchase_sent', null)) !== today) {
    const low = (await q(`SELECT COUNT(*)::int n FROM salon_stock WHERE COALESCE(qty,0) <= 2`))[0] || { n: 0 };
    const lowLine = low.n > 0 ? `\n📉 На низькому залишку: <b>${low.n} позицій</b> — перевірте у розділі «Склад».` : '';
    await hub.enqueue({ recipient: String(chat), channel: 'telegram',
      body: `🛒 <b>Понеділок — день закупки</b>\nПеревірте залишки розхідників (фарби, окисники тощо) і замовте що закінчується.${lowLine}`,
      category: 'transactional', priority: 'normal', source: 'vm-purchase', dedupKey: `purchase:${today}` });
    await setSetting('vm_purchase_sent', today);
    sent++;
  }

  // 5 і 20 числа — тайний покупець
  if ((dom === 5 || dom === 20) && (await getSetting('vm_mystery_sent', null)) !== today) {
    await hub.enqueue({ recipient: String(chat), channel: 'telegram',
      body: `🕵️ <b>Нагадування: тайний покупець</b>\nЗаплануйте перевірку (2-3 на місяць): запис під виглядом клієнта, оцінка скриптів, сервісу й чистоти. Зафіксуйте результат.`,
      category: 'transactional', priority: 'normal', source: 'vm-mystery', dedupKey: `mystery:${today}` });
    await setSetting('vm_mystery_sent', today);
    sent++;
  }

  return sent;
}

// Кроны запускаются ПОЗА HTTP-контекстом → pool.query без tenant бачив би ВСІ салони
// (permissive RLS). runAs(DEFAULT_TENANT_ID) обмежує віртуального менеджера салоном Босса.
// Для інших салонів VM поки не запускається (їх звіти — окремий етап SaaS).
const _wrap = fn => (...a) => runAs(DEFAULT_TENANT_ID, () => fn(...a));
module.exports = {
  autoReviewRequests: _wrap(autoReviewRequests),
  masterDailySchedules: _wrap(masterDailySchedules),
  ownerDailyReport: _wrap(ownerDailyReport),
  // НЕ обгортаємо: сам ітерує всі салони і передає явний tenantId (SaaS-розсилка).
  ownerDailyReportAll,
  adminDayPlan: _wrap(adminDayPlan),
  weeklyMonthlyReminders: _wrap(weeklyMonthlyReminders),
};
