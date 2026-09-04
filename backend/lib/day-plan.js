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

async function dayPlan(pool, date) {
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))
    ? date
    : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const ym = ymd.slice(0, 7);
  const [Y, M] = ym.split('-').map(Number);

  const grid = await buildMonthGrid(pool, ym).catch(() => ({ items: [] }));
  // Адміністратори з сітки графіка ВХОДЯТЬ у план (уточнення Боса 04.09): у адміна
  // теж є план на зміну — мінімум продажу товару (напр. 1000 ₴). Тому беремо всіх,
  // у кого цього дня є зміна, без поділу на майстрів/адмінів.
  const plans = await pool.query(
    `SELECT master_id, plan_per_shift FROM master_monthly_plans WHERE year=$1 AND month=$2`, [Y, M]
  ).catch(() => ({ rows: [] }));
  const planMap = new Map(plans.rows.map(p => [p.master_id, Number(p.plan_per_shift) || 0]));

  const masters = [];
  for (const it of (grid.items || [])) {
    const d = (it.days || []).find(x => x.date === ymd);
    if (!d || d.off) continue;                     // не працює цього дня — у план не входить
    const per = planMap.get(it.id) || 0;
    masters.push({ id: it.id, name: it.name, plan_per_shift: per, has_plan: per > 0 });
  }
  return {
    date: ymd,
    plan_total: Math.round(masters.reduce((s, m) => s + m.plan_per_shift, 0)),
    masters_working: masters.length,
    masters_without_plan: masters.filter(m => !m.has_plan).length,
    masters,
  };
}

module.exports = { dayPlan };
