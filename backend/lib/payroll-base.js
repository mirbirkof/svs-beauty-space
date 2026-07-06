/* lib/payroll-base.js — ЄДИНА формула бази відсотка майстра (правило Босса 06.07).
   Використовується скрізь, де рахується % майстра: розрахунок ЗП, «Підтвердження витрат»,
   Фінцентр (live-finance), звіти, зали. Змінюєш тут — міняється вся ланцюжка.

   net (дефолт) — «за вирахуванням матеріалів»: фактично сплачене за послуги мінус
       рядки-матеріали у складі візиту (знижки автоматично зменшують базу).
   gross — «від загальної суми чека»: повний чек послуг (робота + рядки-матеріали).

   Рядок послуги = МАТЕРІАЛ, якщо в назві є «матеріал» і немає «без»/«врахуванн»
   (щоб не сплутати з «...(без врахування матеріалів)» — це робота). */

// CTE: matlines(aid, mat) — сума рядків-матеріалів по візиту
const MATLINES_CTE = `
  SELECT asv.appointment_id aid,
         SUM(asv.price) FILTER (WHERE (LOWER(COALESCE(sc.name,'')) ~ 'матер[іи]ал'
           AND LOWER(COALESCE(sc.name,'')) NOT LIKE '%без%' AND LOWER(COALESCE(sc.name,'')) NOT LIKE '%врахуванн%')) mat
    FROM appointment_services asv LEFT JOIN services sc ON sc.id=asv.service_id
   GROUP BY asv.appointment_id`;

// Вираз бази візиту (використовувати з JOIN matlines ml ON ml.aid=a.id):
// net-база (робота): GREATEST(0, COALESCE(a.real_amount,a.price,0) - COALESCE(ml.mat,0))
const REV_LABOR = `GREATEST(0, COALESCE(a.real_amount,a.price,0) - COALESCE(ml.mat,0))`;
// повний чек (gross): COALESCE(a.real_amount,a.price,0)
const REV_FULL = `COALESCE(a.real_amount,a.price,0)`;

// Вираз нарахування % (потребує ps = payroll_schemes, rev_labor, rev_full у scope):
const COMMISSION_EXPR = (labor = 'rev_labor', full = 'rev_full') =>
  `CASE WHEN ps.scheme_type IN ('percent','hybrid')
        THEN (CASE WHEN ps.percent_base='gross' THEN ${full} ELSE ${labor} END)*COALESCE(ps.percent,0)/100
        ELSE 0 END`;

module.exports = { MATLINES_CTE, REV_LABOR, REV_FULL, COMMISSION_EXPR };
