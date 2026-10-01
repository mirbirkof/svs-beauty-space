/* lib/day-plan.js — ЄДИНЕ ДЖЕРЕЛО ПЛАНУ НА ДЕНЬ (нотатка #146, Босс 04.09.2026).
 *
 * ПРИЧИНА ПОЯВИ. План дня рахувався у ДВОХ місцях по-різному:
 *   - ранковий звіт адміну в Telegram: план_місяця ÷ кількість днів місяця (рівномірно,
 *     без огляду на те, хто саме сьогодні працює);
 *   - на екрані каси плану не було зовсім.
 * Рівномірний поділ бреше: у день, коли працює 5 майстрів, ціль така сама, як у день
 * з одним майстром. Босс у нотатці сказав прямо: план має бути «відповідно до працюючих
 * майстрів». Тому обидва споживачі тепер беруть число ЗВІДСИ — розійтись не можуть.
 *
 * ФОРМУЛА: план дня = сума plan_per_shift тих майстрів, у яких за сіткою графіка
 * (buildMonthGrid — те саме, що бачить адмін у «Графіки роботи») цього дня є зміна.
 * Майстер без заданого плану на зміну додає 0 і рахується окремо (masters_without_plan),
 * щоб було видно, чому ціль занижена.
 */
'use strict';
const { buildMonthGrid } = require('./schedule-month');
// #160: «хто адміністрація» — один вираз на всю систему (lib/staff-role.js),
// щоб журнал, каса, графік і реєстр команди не рахували це кожен по-своєму.
const { isAdminSql } = require('./staff-role');

// Джерела сітки, які є ПРОГНОЗОМ (за днем тижня / шаблоном), а не реальним записом графіка.
const GUESSED_SOURCES = new Set(['history', 'template', 'auto', 'pattern']);
const kyivToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** Хто з адміністрації фактично відпрацював день: найактивніший у журналі входів CRM,
 *  інакше — відповідальний кассової зміни цього дня. null — фактів ще немає. */
async function factShiftAdmin(pool, ymd, adminIds) {
  if (!adminIds.size) return null;
  const ids = [...adminIds];
  const a = await pool.query(
    `SELECT master_id FROM shift_login_audit
      WHERE work_date = $1::date AND master_id = ANY($2::int[])
      GROUP BY master_id ORDER BY SUM(seen_count) DESC, MAX(last_seen_at) DESC LIMIT 1`, [ymd, ids]
  ).catch(() => ({ rows: [] }));
  if (a.rows[0]) return a.rows[0].master_id;
  const c = await pool.query(
    `SELECT u.master_id FROM cash_shifts cs
       JOIN users u ON u.id = COALESCE(cs.opened_by_user_id, cs.closed_by_user_id)
      WHERE (cs.opened_at AT TIME ZONE 'Europe/Kyiv')::date = $1::date AND u.master_id = ANY($2::int[])
      ORDER BY cs.opened_at DESC LIMIT 1`, [ymd, ids]
  ).catch(() => ({ rows: [] }));
  return c.rows[0] ? c.rows[0].master_id : null;
}

async function dayPlan(pool, date) {
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : kyivToday();
  const ym = ymd.slice(0, 7);
  const [Y, M] = ym.split('-').map(Number);

  const grid = await buildMonthGrid(pool, ym).catch(() => ({ items: [] }));
  // Адміністратори з сітки графіка ВХОДЯТЬ у план (уточнення Боса 04.09): у адміна
  // теж є план на зміну — мінімум продажу товару (напр. 1000 ₴). Тому беремо всіх,
  // у кого цього дня є зміна, без поділу на майстрів/адмінів.
  await require('./month-plan').ensureMonthPlans(pool, Y, M); // #162: перенос плану на новий місяць
  const plans = await pool.query(
    `SELECT master_id, plan_per_shift FROM master_monthly_plans WHERE year=$1 AND month=$2`, [Y, M]
  ).catch(() => ({ rows: [] }));
  const planMap = new Map(plans.rows.map(p => [p.master_id, Number(p.plan_per_shift) || 0]));

  // Хто адміністратор (уточнення Боса 04.09, друге): план адміна — мінімум продажу
  // ТОВАРУ, і його треба бачити ОКРЕМО від майстрів: виконав сам товаром чи його
  // тисячу «перекрила» загальна каса. Загальний план дня при цьому лишається спільним.
  const roles = await pool.query(
    `SELECT id, ${isAdminSql('masters')} AS is_admin
       FROM masters WHERE active=true`
  ).catch(() => ({ rows: [] }));
  const adminIds = new Set(roles.rows.filter(r => r.is_admin).map(r => r.id));

  const masters = [];
  for (const it of (grid.items || [])) {
    const d = (it.days || []).find(x => x.date === ymd);
    if (!d || d.off) continue;                     // не працює цього дня — у план не входить
    const per = planMap.get(it.id) || 0;
    masters.push({ id: it.id, name: it.name, plan_per_shift: per, has_plan: per > 0,
                   is_admin: adminIds.has(it.id), guessed: GUESSED_SOURCES.has(d.source) });
  }

  // ── Адмін ЗМІНИ, а не всі адміни (нотатка #166, Власник 01.10) ───────────────
  // ПРИЧИНА. Коли графік адміна на день не проставлений руками, сітка «домальовує» його
  // за днем тижня з історії. Адміни ж працюють позмінно (2/2), а не за днями тижня —
  // тому прогноз ставив на зміну ОБОХ, і під касою писалось «Адмін · Аліна, Даша»,
  // а план дня рахував обидві адмінські тисячі.
  // ПРАВИЛО: 1) є реальний запис у графіку — він і є правда;
  //          2) лише прогноз, а день уже настав — хто з адмінів ФАКТИЧНО працював у CRM
  //             (журнал входів — той самий, яким автопілот каси визначає відповідального),
  //             запасний варіант — відповідальний кассової зміни цього дня;
  //          3) майбутній день без графіка — лишається прогноз (іншого джерела немає).
  const isAdm = m => m.is_admin;
  const realAdm = masters.filter(m => isAdm(m) && !m.guessed);
  if (!realAdm.length && ymd <= kyivToday()) {
    const shiftAdminId = await factShiftAdmin(pool, ymd, adminIds);
    if (shiftAdminId) {
      for (let i = masters.length - 1; i >= 0; i--) if (isAdm(masters[i]) && masters[i].id !== shiftAdminId) masters.splice(i, 1);
      if (!masters.some(m => m.id === shiftAdminId)) {
        const it = (grid.items || []).find(x => x.id === shiftAdminId);
        const per = planMap.get(shiftAdminId) || 0;
        if (it) masters.push({ id: it.id, name: it.name, plan_per_shift: per, has_plan: per > 0, is_admin: true, guessed: false });
      }
    }
  } else if (realAdm.length) {
    for (let i = masters.length - 1; i >= 0; i--) if (isAdm(masters[i]) && masters[i].guessed) masters.splice(i, 1);
  }
  const admins = masters.filter(m => m.is_admin);
  const adminPlan = Math.round(admins.reduce((s, m) => s + m.plan_per_shift, 0));

  // Факт адміна = товар, проданий БЕЗ візиту (POS/каса), за цей день. Товар на візиті
  // належить майстру, замовлення магазину (ref_type='order') — інший бізнес. Межі дня —
  // той самий предикат, що й «Каса за день» (/api/cashbox/today), щоб цифри збігались.
  let adminFact = 0, adminOps = 0;
  if (admins.length) {
    const af = await pool.query(
      `SELECT COALESCE(SUM(amount),0)::float AS s, COUNT(*)::int AS n
         FROM cash_operations
        WHERE type='in' AND category='sale_product'
          AND ref_type IS DISTINCT FROM 'appointment' AND ref_type IS DISTINCT FROM 'order'
          AND created_at >= $1::date AND created_at < ($1::date + INTERVAL '1 day')`, [ymd]
    ).catch(() => ({ rows: [{ s: 0, n: 0 }] }));
    adminFact = Math.round(Number(af.rows[0]?.s || 0));
    adminOps = Number(af.rows[0]?.n || 0);
  }

  return {
    date: ymd,
    plan_total: Math.round(masters.reduce((s, m) => s + m.plan_per_shift, 0)),
    masters_working: masters.length,
    masters_without_plan: masters.filter(m => !m.has_plan).length,
    masters,
    // Окремий зріз адміна (загальний план вище його вже включає)
    admins_working: admins.length,
    admin_plan: adminPlan,
    admin_fact: adminFact,          // товар без візиту за день
    admin_ops: adminOps,
    admin_names: admins.map(a => a.name),
  };
}

module.exports = { dayPlan };
