/* lib/live-finance.js — ЄДИНЕ джерело правди по фінансах (accrual / «на цю секунду»).
   Один розрахунок для дашборду, Фінцентру, overview — щоб цифри СКРІЗЬ збігались.
   Витрати = собівартість матеріалів (COGS) + НАРАХОВАНИЙ % майстрам по реальній схемі
             за завершені послуги + фікс-оклади (пропорційно періоду) + інші витрати каси
             (оренда/реклама/закупівлі — БЕЗ касової категорії salary, бо її замінює нарахований %).
   Прибуток = виручка − витрати. Працює для будь-якого періоду [from, to]. */

// 27.07: % майстрам — лише по візитах, за які платить САМ салон (див. payrollEligibleExpr).
const { payrollEligibleExpr } = require('./settlement');
const { SVCPCT_CTE, COMMISSION_EXPR } = require('./payroll-base');
const { ACCRUAL_SQL, mergeByCategory, marginPct } = require('./recurring-accrual');

const CAT_LABELS = {
  rent: 'Оренда', salary: 'Зарплата', payroll: 'Зарплата', purchase: 'Закупівлі', purchasing: 'Закупівлі',
  marketing: 'Маркетинг', utilities: 'Комуналка', supplies: 'Витратні', taxes: 'Податки', other: 'Інше',
  materials: 'Матеріали (собівартість)', commission: 'Зарплата майстрів (нарахована)',
  refund: 'Повернення клієнтам',
};

async function liveFinance(pool, from, to) {
  // Аудит 13.08: раніше будь-який збій SQL мовчки ставав порожнім набором → «витрати 0»,
  // «виручка 0», і власник бачив завищений прибуток як норму. Тепер збій: (1) видно в логах,
  // (2) позначається у відповіді прапорцем incomplete — споживач може показати попередження
  // замість того, щоб видавати неповні дані за правду. Поведінка при УСПІХУ не змінилась.
  const failed = [];
  const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows).catch((e) => {
    failed.push(e.message);
    console.error('[live-finance] query failed:', e.message);
    return [];
  });
  // Межі періоду приходять у ЧОТИРЬОХ форматах (аудит 26.07):
  //   "YYYY-MM-DD HH:MM:SS Europe/Kyiv" (Фінцентр, дайджест) — Postgres розуміє, Date.parse НІ
  //     → раніше NaN заражав оклади → expTotal → «Прибуток: NaN ₴» у Telegram-зведенні;
  //   Date-обʼєкти з pg (owner-report, cashbox); ISO-UTC рядки (reports.js); голі дати (pnl).
  // ts() зводить усе до мілісекунд: назва зони → справжній київський зсув (EET/EEST, 01.11.2026). Конвенції меж ("23:59:59" включно і "+1 день 00:00"
  // виключно) обидві дають правильний round — тому БЕЗ +1.
  // 01.11.2026: справжня київська північ (EET/EEST), а не жорсткі +03:00 — взимку (UTC+2)
  // "2026-11-01" ставало 31.10 23:00 → fromDay=31.10 → у період чіплявся день жовтня
  // (зайва 1/31 оренди в нарахуванні, години минулого дня в касовому вікні).
  const kyivWall = (dateStr, timeStr = '00:00:00') => {
    const utc = Date.parse(dateStr + 'T' + timeStr + 'Z');
    const off = (t) => {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(t)).map(x => [x.type, x.value]));
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
    };
    let t = utc - off(utc);
    const o2 = off(t); if (utc - o2 !== t) t = utc - o2;
    return t;
  };
  const ts = (x) => {
    if (x instanceof Date) return x.getTime();
    const s = String(x);
    // Гола дата (pnl) = київська північ, НЕ UTC-північ (інакше -1мс від ексклюзивної межі
    // "2026-08-01" давав 03:00 Києва 1 серпня → вікно змін чіпляло день наступного місяця).
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return kyivWall(s);
    let t = Date.parse(s);
    if (Number.isNaN(t)) {
      const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)? [A-Za-z]+\/[A-Za-z_]+$/);
      if (m) t = kyivWall(m[1], m[2]);
    }
    if (Number.isNaN(t)) t = kyivWall(s.slice(0, 10));
    return t;
  };
  const days = Math.max(1, Math.round((ts(to) - ts(from)) / 86400000));
  // Сьогоднішня дата за Києвом — межа «вже відпрацьовано». Поточний день не рахуємо:
  // робота ще йде (наказ власника 02.08).
  const todayKyiv = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  // Скільки днів періоду ПОВНІСТЮ завершено (для пропорції місячного окладу).
  const _tsToday = kyivWall(todayKyiv);
  const daysDone = Math.max(0, Math.round((Math.min(ts(to), _tsToday) - ts(from)) / 86400000));
  // Календарні дні меж — ЗА КИЇВСЬКИМ часом, для вікна змін (master_schedule_days).
  // Раніше String(from).slice(0,10): Date-обʼєкт давав "Sat Jul 25" (запит падав → оклади
  // губились), ISO-UTC давав учорашню дату (зайвий день змін → оклади дублювались).
  // Для кінця періоду −1 мс: виключна межа "+1 день 00:00" не чіпляє зайвий день.
  const kyivDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' });
  const fromDay = kyivDayFmt.format(new Date(ts(from)));
  const toDay = kyivDayFmt.format(new Date(ts(to) - 1));
  const [revC, ordR, comm, fixed, cogs, other, finSet, salesComm, visitsR, accrued] = await Promise.all([
    q(`SELECT COALESCE(SUM(amount) FILTER (WHERE category='sale_service'),0)::numeric svc,
              -- 15.08 (правило Боса): САЛОН і МАГАЗИН — різні бізнеси, метрики НЕ змішуються.
              -- Раніше сюди падали приходи по замовленнях магазину (ref_type='order'):
              -- у серпні це дало +8 112 ₴ у касі салону (7 тестових замовлень 11.08,
              -- усі повернені того ж дня). Каса салону = послуги + товар, проданий
              -- НА ВІЗИТІ або через касу салону. Замовлення магазину рахує свій дашборд
              -- (/api/store/dashboard) — тут вони не враховуються ЖОДНОГО разу.
              COALESCE(SUM(amount) FILTER (WHERE category='sale_product'
                       AND ref_type IS DISTINCT FROM 'order'),0)::numeric prod,
              COUNT(DISTINCT CASE WHEN category IN ('sale_service','sale_product')
                    AND ref_type IS DISTINCT FROM 'order'
                    THEN COALESCE(ref_type || ':' || ref_id::text, 'op:' || id::text) END)::int cnt
         FROM cash_operations WHERE type='in' AND created_at BETWEEN $1 AND $2`, [from, to]),
    q(`SELECT COALESCE(SUM(total),0)::numeric s, COUNT(*)::int c FROM orders WHERE status='paid' AND created_at BETWEEN $1 AND $2`, [from, to]),
    // % майстрам за послуги — ТА САМА формула, що ЗП і «Підтвердження витрат» (правило Босса 06.07):
    // net (дефолт) = сплачене мінус рядки-матеріали; gross = повний чек послуг.
    q(`WITH matlines AS (
         SELECT asv.appointment_id aid,
                SUM(asv.price) FILTER (WHERE (sc.is_material = TRUE OR (sc.is_material IS NOT TRUE AND LOWER(COALESCE(sc.name,'')) ~ 'матер[іи]ал' AND LOWER(COALESCE(sc.name,'')) NOT LIKE '%без%' AND LOWER(COALESCE(sc.name,'')) NOT LIKE '%врахуванн%'))) mat
           FROM appointment_services asv LEFT JOIN services sc ON sc.id=asv.service_id
          GROUP BY asv.appointment_id),
       svcpct AS (${SVCPCT_CTE}),
       da AS (
         SELECT a.master_id, a.id aid,
                GREATEST(0, COALESCE(a.real_amount,a.price,0) - COALESCE(ml.mat,0)) rev_labor,
                GREATEST(0, COALESCE(a.real_amount,a.price,0)) rev_full  -- симетрія з rev_labor: комісія не в мінус
                -- УВАГА (аудит 26.07): у lib/payroll-base.js REV_FULL — БЕЗ GREATEST.
                -- Розбіжність проявилася б лише при відʼємному real_amount/price; станом на
                -- 26.07 таких рядків у БД НЕМАЄ (перевірено, 0 шт) → обидві формули дають
                -- однакове число. Свідомо НЕ уніфікую: правка торкнулася б нарахування ЗП
                -- майстрам без практичної потреби. Зʼявляться повернення з мінусом —
                -- спершу рішення Босса, потім правка ОБОХ файлів разом.
           FROM appointments a LEFT JOIN matlines ml ON ml.aid=a.id
          WHERE a.starts_at BETWEEN $1 AND $2 AND a.starts_at <= NOW()
            AND (a.status IN ('done','completed') OR (a.status='confirmed' AND a.real_synced_at IS NOT NULL))
            AND ${payrollEligibleExpr('a')})
       -- + окремий % за послугу (payroll_rules, Босс 02.10) — поправка через svcpct, див. payroll-base
       SELECT COALESCE(SUM(${COMMISSION_EXPR('da.rev_labor', 'da.rev_full', { sp: 'sp' })}),0)::numeric comm,
              COUNT(*)::int appts
         FROM da LEFT JOIN payroll_schemes ps ON ps.master_id=da.master_id::text AND ps.is_active=TRUE
         LEFT JOIN svcpct sp ON sp.aid=da.aid`, [from, to]),
    // фікс-оклади: fixed_per_month (пропорційно періоду) + fixed_per_day × реальні зміни графіка.
    // Раніше fixed_per_day ігнорувався повністю (аудит 06.07).
    // 02.08 (наказ власника): день, який ЩЕ ЙДЕ, не є витратою — робота не виконана,
    // зміна може змінитись або скасуватись. Тому рахуємо ТІЛЬКИ повністю відпрацьовані
    // дні: work_date < сьогодні (Київ). Раніше дашборд зранку показував оклади за
    // сьогоднішні та майбутні зміни при нульовій виручці.
    q(`WITH sched AS (
         SELECT master_id, COUNT(*)::int shifts FROM master_schedule_days
          WHERE work_date >= $1::date AND work_date <= $2::date
            AND work_date < $3::date
          GROUP BY master_id)
       SELECT COALESCE(SUM(COALESCE(ps.fixed_per_month,0)),0)::numeric fx_month,
              COALESCE(SUM(COALESCE(ps.fixed_per_day,0) * COALESCE(sc.shifts,0)),0)::numeric fx_day
         FROM payroll_schemes ps JOIN masters m ON m.id::text=ps.master_id
         LEFT JOIN sched sc ON sc.master_id=m.id
        WHERE ps.is_active=TRUE AND ps.scheme_type IN ('fixed','hybrid') AND m.active=TRUE`,
      [fromDay, toDay, todayKyiv]),
    // COGS = собівартість ВСІХ списань (розниця + матеріали візитів, заметка #141).
    // Грамові товари (price_per_gram) з unit_ml: опт за упаковку ÷ грамів в упаковці;
    // без unit_ml опт уже за грам; штучні — опт за одиницю. Знак delta зберігаємо:
    // service-reverse (відкат оплати) повертає на склад і ВІДНІМАЄ з собівартості,
    // інакше unpay→pay рахує списання двічі.
    q(`SELECT COALESCE(SUM(-sm.delta * CASE
                WHEN p.price_per_gram IS NOT NULL AND p.cost_per_gram IS NOT NULL THEN p.cost_per_gram
                WHEN p.price_per_gram IS NOT NULL AND COALESCE(pv.unit_ml,0) > 1
                THEN COALESCE(pv.wholesale,0) / pv.unit_ml
                ELSE COALESCE(pv.wholesale,0) END),0)::numeric g
         FROM stock_movements sm
         JOIN product_variants pv ON pv.id=sm.variant_id
         LEFT JOIN products p ON p.id=pv.product_id
        WHERE (sm.reason IN ('sale','order') OR sm.reason LIKE 'order:%'
               OR sm.reason LIKE 'service:%' OR sm.reason LIKE 'service-reverse:%')
          AND sm.created_at BETWEEN $1 AND $2
          -- Аудит 25.07: у собівартість падали тестові рухи (E2E-прогони) і списання за
          -- замовленнями, які потім видалили — 36 634 ₴ з 45 770 ₴ червня, тобто 80%.
          -- Дані не чіпаємо, але у гроші вони не йдуть: продажу не було.
          AND COALESCE(sm.notes,'') !~* '^(e2e|тест|test)'
          AND NOT (sm.notes ~ '^Замовлення #[0-9]+'
                   AND NOT EXISTS (SELECT 1 FROM orders o
                                    WHERE o.id = (regexp_match(sm.notes,'#([0-9]+)'))[1]::int))`, [from, to]),
    q(`SELECT category, COALESCE(SUM(amount),0)::numeric s FROM cash_operations
        WHERE type='out' AND category NOT IN ('salary','payroll') AND created_at BETWEEN $1 AND $2
          -- 01.11.2026: постійні витрати (оренда/CRM, accrual_month) — НЕ в день оплати, а по нарахуванню
          -- (запит accrued нижче). Разові ручні витрати — як і були, касою в день оплати.
          AND accrual_month IS NULL
        GROUP BY category ORDER BY s DESC`, [from, to]),
    // tenant-фільтр (17.07.2026): без нього платформа (GUC порожній → RLS permissive)
    // хапала рядок чужого тенанта
    q(`SELECT value FROM app_settings WHERE key='finance'
        AND tenant_id IN (COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid), '00000000-0000-0000-0000-000000000001'::uuid)
        ORDER BY (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid)) DESC LIMIT 1`),
    // % майстрам З ПРОДАЖУ продукції: банки у візитах по ПРОДАВЦЮ + роздрібні POS-продажі
    // майстра × sales_commission_pct (та сама формула, що ЗП і «Підтвердження витрат»)
    q(`WITH bottles AS (
          SELECT COALESCE(am.seller_master_id, a.master_id) AS mid,
                 SUM(ROUND(am.qty_used * pv.price, 2)) AS rev
            FROM appointment_materials am
            JOIN appointments a ON a.id = am.appointment_id
            JOIN product_variants pv ON pv.id = am.variant_id
            LEFT JOIN products p ON p.id = pv.product_id
            LEFT JOIN categories c ON c.id = p.category_id
           WHERE p.price_per_gram IS NULL AND pv.price IS NOT NULL
             AND a.status IN ('done','completed')
             AND a.starts_at BETWEEN $1 AND $2
             AND COALESCE(c.commissionable, TRUE) = TRUE
           GROUP BY 1),
        pos AS (
          SELECT co.master_id AS mid, SUM(co.amount) AS rev FROM cash_operations co
           WHERE co.type='in' AND co.category='sale_product' AND co.ref_type IS NULL
             AND co.master_id IS NOT NULL AND co.created_at BETWEEN $1 AND $2
           GROUP BY 1),
        tot AS (SELECT mid, SUM(rev) AS rev FROM (SELECT * FROM bottles UNION ALL SELECT * FROM pos) t GROUP BY 1)
        SELECT COALESCE(SUM(ROUND(tot.rev * COALESCE(ps.sales_commission_pct,0) / 100, 2)),0)::numeric s
          FROM tot LEFT JOIN payroll_schemes ps ON ps.master_id = tot.mid::text AND ps.is_active = TRUE`, [from, to]),
    // Реальні візити періоду — єдиний знаменник середнього чека для всієї CRM.
    // Візит = клієнт + день (запис без картки клієнта рахується окремим візитом).
    q(`SELECT COUNT(DISTINCT (COALESCE(client_id::text, 'anon-'||id),
                              (starts_at AT TIME ZONE 'Europe/Kyiv')::date))::int n
         FROM appointments
        WHERE starts_at BETWEEN $1 AND $2 AND starts_at <= NOW()
          AND status NOT IN ('cancelled','noshow')`, [from, to]),
    // 01.11.2026: постійні витрати по нарахуванню — частка місяця, що припадає на дні періоду
    // (оренда 50 000 за 1 день листопада = 1 667, а не 50 000). Каса/журнал не змінюються.
    q(ACCRUAL_SQL, [fromDay, toDay]),
  ]);

  const revServices = Number(revC[0]?.svc || 0);
  // Замовлення магазину (ordR) свідомо НЕ додаються у виручку салону — окремий бізнес,
  // окремий дашборд. Змішування давало Босу невірну касу (15.08).
  const revProducts = Number(revC[0]?.prod || 0);
  const revTotal = revServices + revProducts;

  const commissionPct = Number(comm[0]?.comm || 0);
  // Оклад пропорційно ЧАСТЦІ РЕАЛЬНОГО МІСЯЦЯ, а не умовним 30 дням (аудит 25.07:
  // за 31-денний місяць нараховувалось +3.3% зайвого окладу, за лютий −6.7% недобору).
  // Календарний день ПОЧАТКУ періоду — за КИЇВСЬКИМ часом (ISO-UTC "30.06 21:00Z" = 1 липня
  // у Києві; раніше через getUTCMonth() місяць зʼїжджав на попередній → daysInMonth 30 замість 31).
  const _fromD = new Date(fromDay + 'T00:00:00Z');
  const daysInMonth = new Date(Date.UTC(_fromD.getUTCFullYear(), _fromD.getUTCMonth() + 1, 0)).getUTCDate();
  // Пропорція рахується по ЗАВЕРШЕНИХ днях (daysDone), а не по всьому періоду:
  // інакше зранку 1-го числа вже «висів» оклад за день, який тільки почався.
  const monthShare = Math.min(1, daysDone / (daysInMonth || 30));
  const fixedAccrued = Number(fixed[0]?.fx_month || 0) * monthShare + Number(fixed[0]?.fx_day || 0); // оклад пропорц. + ставка×зміни
  const salesCommission = Number(salesComm[0]?.s || 0); // % з продажу продукції (банки/POS)
  const commission = Math.round(commissionPct + fixedAccrued + salesCommission);
  // Матеріали = собівартість проданих товарів (COGS) + матеріали послуг як % від виручки послуг
  // (норм на послуги в системі нема, тож рахуємо % з налаштувань; 0 = вимкнено, як зараз).
  const materialPct = Number(finSet[0]?.value?.material_pct || 0);
  const serviceMaterials = Math.round(revServices * materialPct / 100);
  const materials = Math.round(Number(cogs[0]?.g || 0)) + serviceMaterials;
  const otherCats = mergeByCategory(
      other.map(r => ({ category: r.category, sum: Number(r.s) })),
      (accrued || []).map(r => ({ category: r.category, sum: Number(r.sum) })))
    .map(r => ({ category: r.category, label: CAT_LABELS[r.category] || r.category, sum: Math.round(r.sum) }))
    .filter(r => r.sum > 0)
    .sort((a, b) => b.sum - a.sum);
  const otherTotal = otherCats.reduce((a, r) => a + r.sum, 0);
  const expTotal = commission + materials + otherTotal;

  const by_category = [
    { category: 'materials', label: CAT_LABELS.materials, sum: materials },
    { category: 'commission', label: CAT_LABELS.commission, sum: commission },
    ...otherCats,
  ].filter(x => x.sum > 0).sort((a, b) => b.sum - a.sum);

  // Кількість транзакцій — теж лише салон: замовлення магазину рахує його дашборд.
  const txCount = Number(revC[0]?.cnt || 0);
  // Аудит 25.07: середній чек тут рахувався як виручка / кількість КАСОВИХ ОПЕРАЦІЙ, а на
  // дашборді — як виручка / візити. Один показник мав два різні значення (1189 vs 1655).
  // Єдине правило для всієї CRM: чек = виручка / реальні візити (клієнт + день).
  const visitsCount = Number(visitsR?.[0]?.n || 0);
  const netProfit = revTotal - expTotal;
  return {
    revenue: { services: revServices, products: revProducts, total: revTotal },
    expenses: { by_category, total: expTotal, materials, commission, other: otherCats },
    // маржа null = «—»: виручка < 1% витрат (напр. 1-ше число) — відсоток беззмістовний (01.11.2026)
    profit: { net: netProfit, margin_pct: marginPct(netProfit, revTotal, expTotal) },
    tx_count: txCount,
    visits_count: visitsCount,
    avg_check: visitsCount > 0 ? Math.round(revTotal / visitsCount)
             : (txCount > 0 ? Math.round(revTotal / txCount) : 0),
    commission_appts: Number(comm[0]?.appts || 0),
    // true = частина запитів впала, цифри НЕПОВНІ (аудит 13.08). Відсутність поля = все ок.
    incomplete: failed.length > 0 || undefined,
    incomplete_reasons: failed.length ? failed.slice(0, 3) : undefined,
  };
}

module.exports = { liveFinance, CAT_LABELS };
