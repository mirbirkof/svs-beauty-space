'use strict';
// 01.11.2026: постійні витрати в АНАЛІТИЦІ — по нарахуванню.
// Каса проводить оренду/CRM 1-го числа цілою сумою (реальні гроші, журнал — без змін), а звіти
// беруть частку: сума місяця × (днів періоду всередині місяця / днів у місяці).
// Позначка «це постійна витрата» = cash_operations.accrual_month IS NOT NULL (міграція 312).
// Разові ручні витрати (accrual_month IS NULL) лишаються касовими — в день оплати.

const EXCL = "('salary','payroll')";

// SQL-фрагмент для КАСОВОЇ частини: додати до WHERE поряд з фільтром по created_at.
const CASH_ONLY = 'accrual_month IS NULL';

// Нарахована частка постійних витрат за період [fromDay, toDay] (YYYY-MM-DD, київські дати, обидва включно).
// Повертає [{category, sum}] — sum дробова, округлює споживач.
const ACCRUAL_SQL = `
  SELECT category,
         SUM(amount * GREATEST(0, (LEAST($2::date, (accrual_month + INTERVAL '1 month' - INTERVAL '1 day')::date)
                                   - GREATEST($1::date, accrual_month) + 1))
             / EXTRACT(DAY FROM (accrual_month + INTERVAL '1 month' - INTERVAL '1 day'))) AS sum
    FROM cash_operations
   WHERE type='out' AND accrual_month IS NOT NULL AND category NOT IN ${EXCL}
     AND accrual_month <= $2::date AND accrual_month + INTERVAL '1 month' > $1::date
   GROUP BY category`;

async function accruedByCategory(db, fromDay, toDay) {
  const r = await db.query(ACCRUAL_SQL, [fromDay, toDay]);
  return r.rows.map(x => ({ category: x.category, sum: Number(x.sum) || 0 })).filter(x => x.sum > 0);
}

// Те саме по операціях — для розшифровки «Витрати» (сума модалки = картці).
async function accruedOps(db, fromDay, toDay) {
  const r = await db.query(`
    SELECT id, created_at, category, amount, description, accrual_month::text AS accrual_month,
           amount * GREATEST(0, (LEAST($2::date, (accrual_month + INTERVAL '1 month' - INTERVAL '1 day')::date)
                                 - GREATEST($1::date, accrual_month) + 1))
             / EXTRACT(DAY FROM (accrual_month + INTERVAL '1 month' - INTERVAL '1 day')) AS accrued,
           GREATEST(0, (LEAST($2::date, (accrual_month + INTERVAL '1 month' - INTERVAL '1 day')::date)
                        - GREATEST($1::date, accrual_month) + 1))::int AS days,
           EXTRACT(DAY FROM (accrual_month + INTERVAL '1 month' - INTERVAL '1 day'))::int AS month_days
      FROM cash_operations
     WHERE type='out' AND accrual_month IS NOT NULL AND category NOT IN ${EXCL}
       AND accrual_month <= $2::date AND accrual_month + INTERVAL '1 month' > $1::date
     ORDER BY accrual_month, id`, [fromDay, toDay]);
  return r.rows.map(x => ({ ...x, accrued: Number(x.accrued) || 0 }));
}

// Злити касові рядки і нараховані по категорії → [{category, sum}].
function mergeByCategory(...lists) {
  const m = new Map();
  for (const list of lists) for (const x of list) {
    const k = x.category;
    m.set(k, (m.get(k) || 0) + (Number(x.sum) || 0));
  }
  return [...m.entries()].map(([category, sum]) => ({ category, sum }));
}

// Маржа: якщо виручка < 1% витрат (або нуль) — відсоток беззмістовний → null (UI малює «—»).
function marginPct(profit, revenue, expense) {
  revenue = Number(revenue) || 0; expense = Number(expense) || 0;
  if (revenue <= 0 || revenue < expense * 0.01) return null;
  return Math.round(Number(profit) / revenue * 100);
}
const fmtMargin = (m) => (m == null ? '—' : m + '%');

module.exports = { CASH_ONLY, ACCRUAL_SQL, accruedByCategory, accruedOps, mergeByCategory, marginPct, fmtMargin };
