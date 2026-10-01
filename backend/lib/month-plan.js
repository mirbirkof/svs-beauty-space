/* month-plan.js — перенесення плану місяця (нотатка #162, Власник 01.10:
   «План месяца автоматом не переносится на следующий месяц, нужно каждый раз
   вводить все заново»).

   ПРИЧИНА: план живе в master_monthly_plans окремим рядком на (майстер, рік, місяць).
   Для нового місяця рядків немає → і розділ «План», і ранковий звіт, і план дня,
   і віртуальний менеджер бачили план = 0, поки власник не введе все заново.

   РІШЕННЯ (одне джерело для всіх читачів):
   • ensureMonthPlans(pool, y, m) — якщо (y, m) = ПОТОЧНИЙ місяць за Києвом, кожному
     активному майстру без рядка в цьому місяці копіює його ОСТАННІЙ заданий план
     з попередніх місяців (carried_from = звідки). Вже задані рядки не чіпаються
     (ON CONFLICT DO NOTHING), минулі місяці не переписуються (історія чесна),
     майбутні не матеріалізуються (щоб зміна плану в жовтні потрапила і в листопад).
   • previewCarry(pool, y, m) — для МАЙБУТНЬОГО місяця: що буде перенесено (без запису),
     щоб на екрані одразу стояли цифри.
   Викликають усі місця, що читають план поточного місяця. */
'use strict';

function kyivYM(d = new Date()) {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit' }).format(d);
  const [y, m] = s.slice(0, 7).split('-').map(Number);
  return { y, m };
}
const idx = (y, m) => Number(y) * 12 + Number(m);

// Останній план кожного активного майстра ДО вказаного місяця (DISTINCT ON).
const LATEST_PRIOR_SQL = `
  SELECT DISTINCT ON (mp.master_id)
         mp.tenant_id, mp.master_id, mp.plan_per_shift, mp.plan_total, mp.auto_from_shifts,
         mp.year AS src_year, mp.month AS src_month
    FROM master_monthly_plans mp
    JOIN masters m ON m.id = mp.master_id AND COALESCE(m.active, true) = true
   WHERE (mp.year * 12 + mp.month) < $1
     AND ($2::uuid IS NULL OR mp.tenant_id = $2)
   ORDER BY mp.master_id, mp.year DESC, mp.month DESC`;

async function ensureMonthPlans(pool, year, month, tenantId = null) {
  const cur = kyivYM();
  if (idx(year, month) !== idx(cur.y, cur.m)) return 0;
  try {
    const r = await pool.query(
      `INSERT INTO master_monthly_plans
              (tenant_id, master_id, year, month, plan_per_shift, plan_total, auto_from_shifts, carried_from)
       SELECT s.tenant_id, s.master_id, $3, $4, s.plan_per_shift, s.plan_total, s.auto_from_shifts,
              s.src_year || '-' || LPAD(s.src_month::text, 2, '0')
         FROM (${LATEST_PRIOR_SQL}) s
        WHERE NOT EXISTS (SELECT 1 FROM master_monthly_plans x
                           WHERE x.master_id = s.master_id AND x.year = $3 AND x.month = $4)
       ON CONFLICT (master_id, year, month) DO NOTHING`,
      [idx(year, month), tenantId, Number(year), Number(month)]);
    if (r.rowCount) console.log(`[month-plan] перенесено план на ${year}-${month}: ${r.rowCount} майстр.`);
    return r.rowCount || 0;
  } catch (e) {
    console.error('[month-plan] перенесення не вдалось (план покажеться як є):', e.message);
    return 0;
  }
}

// Map master_id → {plan_per_shift, plan_total, auto_from_shifts, carried_from} для майбутнього місяця.
async function previewCarry(pool, year, month, tenantId = null) {
  const cur = kyivYM();
  if (idx(year, month) <= idx(cur.y, cur.m)) return new Map();
  const r = await pool.query(LATEST_PRIOR_SQL, [idx(year, month), tenantId]).catch(() => ({ rows: [] }));
  return new Map(r.rows.map(p => [p.master_id, {
    plan_per_shift: p.plan_per_shift, plan_total: p.plan_total, auto_from_shifts: p.auto_from_shifts,
    carried_from: `${p.src_year}-${String(p.src_month).padStart(2, '0')}`, preview: true,
  }]));
}

module.exports = { ensureMonthPlans, previewCarry, kyivYM };
