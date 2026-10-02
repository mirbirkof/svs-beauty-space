/* lib/payroll-base.js — ЄДИНА формула бази відсотка майстра (правило Босса 06.07).
   Використовується скрізь, де рахується % майстра: розрахунок ЗП, «Підтвердження витрат»,
   Фінцентр (live-finance), звіти, зали. Змінюєш тут — міняється вся ланцюжка.

   net (дефолт) — «за вирахуванням матеріалів»: фактично сплачене за послуги мінус
       рядки-матеріали у складі візиту (знижки автоматично зменшують базу).
   gross — «від загальної суми чека»: повний чек послуг (робота + рядки-матеріали).

   Рядок послуги = МАТЕРІАЛ, якщо services.is_material=TRUE (явний прапорець, керується в UI).
   Fallback для не розмічених послуг — евристика за назвою: «матеріал» без «без»/«врахуванн»
   (щоб не сплутати з «...(без врахування матеріалів)» — це робота). Явний прапорець важливий
   для нових салонів з іншим неймінгом, де евристика не спрацює (SaaS-аудит 06.07). */

// Вираз «рядок послуги = матеріал»: явний прапорець АБО евристика за назвою (fallback)
const IS_MATERIAL_LINE = `(sc.is_material = TRUE OR (sc.is_material IS NOT TRUE
  AND LOWER(COALESCE(sc.name,'')) ~ 'матер[іи]ал'
  AND LOWER(COALESCE(sc.name,'')) NOT LIKE '%без%' AND LOWER(COALESCE(sc.name,'')) NOT LIKE '%врахуванн%'))`;

// CTE: matlines(aid, mat) — сума рядків-матеріалів по візиту
const MATLINES_CTE = `
  SELECT asv.appointment_id aid,
         SUM(asv.price) FILTER (WHERE ${IS_MATERIAL_LINE}) mat
    FROM appointment_services asv LEFT JOIN services sc ON sc.id=asv.service_id
   GROUP BY asv.appointment_id`;

// Вираз бази візиту (використовувати з JOIN matlines ml ON ml.aid=a.id):
// net-база (робота): GREATEST(0, COALESCE(a.real_amount,a.price,0) - COALESCE(ml.mat,0))
const REV_LABOR = `GREATEST(0, COALESCE(a.real_amount,a.price,0) - COALESCE(ml.mat,0))`;
// повний чек (gross): COALESCE(a.real_amount,a.price,0)
const REV_FULL = `COALESCE(a.real_amount,a.price,0)`;

/* ── ОКРЕМИЙ % МАЙСТРА ЗА ПОСЛУГУ (Босс 02.10) ──────────────────────────────────
   Правило payroll_rules (scope='service', scope_ref=service_id, is_active) = виняток поверх
   % схеми. Для візиту: робочі рядки appointment_services (НЕ матеріал); pct рядка = правило
   майстра на цю послугу (кілька → менший priority, потім новіше) інакше % схеми.
   Ефективний % візиту = Σ(price×pct)/Σ(price) по робочих рядках; немає робочих / сума 0 → % схеми.
   База візиту (net/gross, знижки, матеріали) НЕ змінюється — множиться на ефективний %.

   Щоб при 0 правил усі цифри лишались копійка в копійку, рахуємо не сам ефективний %, а
   ПОПРАВКУ до % схеми:  eff = p + (rw − rs·p),  де по візиту
     rw = Σ(price·pct_правила)/work_sum  (рядки з правилом),  rs = Σ(price з правилом)/work_sum.
   CTE віддає рядок ЛИШЕ для візитів, де спрацювало хоч одне правило → без правил поправка = 0.
   Правило звʼязується з візитом за майстром І тенантом (захист від правила на чужого майстра). */
const SVCPCT_CTE = `
  SELECT w.aid,
         SUM(w.price*w.rpct) FILTER (WHERE w.rpct IS NOT NULL) / SUM(w.price) rw,
         SUM(w.price)        FILTER (WHERE w.rpct IS NOT NULL) / SUM(w.price) rs
    FROM (SELECT asv.appointment_id aid, COALESCE(asv.price,0)::numeric price, rr.percentage rpct
            FROM appointment_services asv
            JOIN appointments ax ON ax.id=asv.appointment_id
            JOIN (SELECT DISTINCT master_id, tenant_id FROM payroll_rules
                   WHERE is_active AND scope='service' AND percentage IS NOT NULL) rm
              ON rm.master_id=ax.master_id AND rm.tenant_id=ax.tenant_id
            LEFT JOIN services sc ON sc.id=asv.service_id
            LEFT JOIN (SELECT DISTINCT ON (master_id, tenant_id, scope_ref) master_id, tenant_id, scope_ref, percentage
                         FROM payroll_rules
                        WHERE is_active AND scope='service' AND percentage IS NOT NULL
                        ORDER BY master_id, tenant_id, scope_ref, priority, created_at DESC, id DESC) rr
              ON rr.master_id=ax.master_id AND rr.tenant_id=ax.tenant_id AND rr.scope_ref=asv.service_id::text
           WHERE NOT COALESCE(${IS_MATERIAL_LINE}, FALSE)) w
   GROUP BY w.aid
  HAVING COUNT(w.rpct) > 0 AND SUM(w.price) > 0`;

// Поправка нарахування (у грошах) для бази base: потребує ps у scope і LEFT JOIN svcpct sp.
// rw/rs можуть бути вже агреговані (SUM(base*rw)) — тоді передати готові вирази.
const SVC_DELTA = (base, sp = 'sp') =>
  `(${base})*(COALESCE(${sp}.rw,0) - COALESCE(${sp}.rs,0)*COALESCE(ps.percent,0))/100`;

// Вираз нарахування % (потребує ps = payroll_schemes, rev_labor, rev_full у scope).
// opt.sp — аліас LEFT JOIN svcpct (по-візитні рядки): додає поправку окремих % за послуги.
// opt.rule — {lw, ls, fw, fs}: вже агреговані SUM(labor*rw), SUM(labor*rs), SUM(full*rw), SUM(full*rs).
const COMMISSION_EXPR = (labor = 'rev_labor', full = 'rev_full', opt = null) => {
  let extra = '';
  if (opt && opt.sp) {
    extra = ` + ${SVC_DELTA(`CASE WHEN ps.percent_base='gross' THEN ${full} ELSE ${labor} END`, opt.sp)}`;
  } else if (opt && opt.rule) {
    const r = opt.rule;
    extra = ` + (CASE WHEN ps.percent_base='gross' THEN COALESCE(${r.fw},0) - COALESCE(${r.fs},0)*COALESCE(ps.percent,0)
                     ELSE COALESCE(${r.lw},0) - COALESCE(${r.ls},0)*COALESCE(ps.percent,0) END)/100`;
  }
  return `CASE WHEN ps.scheme_type IN ('percent','hybrid')
        THEN (CASE WHEN ps.percent_base='gross' THEN ${full} ELSE ${labor} END)*COALESCE(ps.percent,0)/100${extra}
        ELSE 0 END`;
};

// JS-місця (liveEstimate, /payroll/calculate, /payroll/my): поправка в гривнях до base·p/100.
// sums = {lw, ls, fw, fs} з SQL (SUM(rev_labor*rw) …), p = % схеми.
// При 0 правил lw=ls=fw=fs=0 → повертає 0 і percent_part лишається біт-в-біт як був.
function svcExtra(sums, p, gross) {
  const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
  const w = gross ? n(sums.fw) : n(sums.lw), s = gross ? n(sums.fs) : n(sums.ls);
  if (!w && !s) return 0;
  return (w - s * n(p)) / 100;
}
// SQL-колонки для JS-місць: додати в SELECT поруч із revenue (потребує LEFT JOIN svcpct sp, ml).
const SVC_SUMS_SQL = (labor = REV_LABOR, full = REV_FULL, sp = 'sp') => `
  COALESCE(SUM((${labor})*${sp}.rw),0)::numeric AS svc_lw, COALESCE(SUM((${labor})*${sp}.rs),0)::numeric AS svc_ls,
  COALESCE(SUM((${full})*${sp}.rw),0)::numeric AS svc_fw,  COALESCE(SUM((${full})*${sp}.rs),0)::numeric AS svc_fs`;
const svcSums = (row) => ({ lw: row && row.svc_lw, ls: row && row.svc_ls, fw: row && row.svc_fw, fs: row && row.svc_fs });

module.exports = { MATLINES_CTE, IS_MATERIAL_LINE, REV_LABOR, REV_FULL, COMMISSION_EXPR,
  SVCPCT_CTE, SVC_DELTA, svcExtra, SVC_SUMS_SQL, svcSums };
