// Рахунок візиту (04.11, Босс): ОДНЕ джерело правди для каси, застосунку клієнта і Mono-інвойсу.
//
//   Рахунок = послуги (S) + товари/матеріали, додані адміном до візиту (P)
//           − абонемент (покриває лише послугу)
//           − знижка «на послуги» (від послуг після абонемента)
//           − знижка «на товари»  (від товарів)
//           − знижка «на весь чек» (від решти після двох попередніх, ділиться пропорційно)
//           − сертифікат − бонуси − онлайн-передоплата  → «До сплати» (гроші в касу).
//
// Кожна знижка — { type: 'percent' | 'fixed', value } і НІКОЛИ не більша за свою частину (мінусу нема).
// СУМІСНІСТЬ: стара єдина знижка каси = «на весь чек». Коли знижок на послуги/товари нема,
// усі формули нижче дають РІВНО ті самі числа, що код /pay до 04.11 (перевірено знімком проду).
'use strict';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function normSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const type = spec.type === 'percent' || spec.type === 'fixed' ? spec.type : null;
  const value = round2(spec.value);
  if (!type || !(value > 0)) return null;
  return { type, value: type === 'percent' ? Math.min(value, 100) : value };
}

// знижка від частини x: % або грн, але не більша за x
function discOf(spec, x) {
  const s = normSpec(spec);
  const base = Math.max(0, round2(x));
  if (!s || base <= 0) return 0;
  if (s.type === 'percent') return Math.min(base, round2(base * s.value / 100));
  return Math.min(base, s.value);
}

// Чиста функція: знижки + розподіл. cert/bonus/prepaid — уже визначені суми (гроші);
// вони обрізаються до решти чека в тому ж порядку, що в касі.
function computeBill({ S = 0, P = 0, sub = 0, svc = null, prod = null, check = null, cert = 0, bonus = 0, prepaid = 0 } = {}) {
  S = Math.max(0, round2(S)); P = Math.max(0, round2(P));
  const subApplied = Math.min(S, Math.max(0, round2(sub)));
  const S1 = round2(S - subApplied);
  const Ds = discOf(svc, S1);
  const Dp = discOf(prod, P);
  const S3 = round2(S1 - Ds), P3 = round2(P - Dp);
  const Dc = discOf(check, S3 + P3);
  let remaining = round2(S3 + P3 - Dc);
  const certApplied = Math.min(Math.max(0, round2(cert)), remaining); remaining = round2(remaining - certApplied);
  const bonusApplied = Math.min(Math.max(0, round2(bonus)), remaining); remaining = round2(remaining - bonusApplied);
  const prepaidApplied = Math.min(Math.max(0, round2(prepaid)), remaining); remaining = round2(remaining - prepaidApplied);
  const finalCash = Math.max(0, remaining);
  const split = splitCash({ S3, P3, finalCash });
  const realAmount = realServiceAmount({ S, P, Ds, Dp, other: Dc + certApplied + bonusApplied });
  return {
    services_total: S, products_total: P, sub: subApplied,
    discount_services: Ds, discount_products: Dp, discount_check: Dc,
    discount_total: round2(Ds + Dp + Dc),
    services_after: S3, products_after: P3,
    certificate: certApplied, bonus: bonusApplied, prepaid: prepaidApplied,
    final: finalCash, service_cash: split.service, product_cash: split.product,
    real_amount: realAmount,
  };
}

// Гроші в касі: частка товарів = P3 / (S3 + P3). Для старих візитів (Ds=Dp=0) — рівно
// стара формула propBase = base − абонемент.
function splitCash({ S3, P3, finalCash }) {
  const propBase = Math.max(0.01, round2(S3 + P3));
  const product = P3 > 0 ? Math.min(finalCash, round2(P3 * finalCash / propBase)) : 0;
  return { product, service: round2(finalCash - product) };
}

// База ЗП майстра: послуги після «знижки на послуги» мінус пропорційна частка
// (знижка на чек + сертифікат + бонуси). Для старих візитів = price − total×price/base.
function realServiceAmount({ S, P, Ds = 0, Dp = 0, other = 0 }) {
  // без знижок на частини — рівно ті самі числа, що й стара формула (без проміжних округлень)
  const Sx = Ds ? Math.max(0, round2(S - Ds)) : Number(S) || 0;
  const Px = Dp ? Math.max(0, round2(P - Dp)) : Number(P) || 0;
  const b = Sx + Px;
  if (b <= 0) return 0;
  // other * (Sx / b) — порядок операцій як у старій формулі (total × svcShare) → копійка в копійку
  return round2(Math.max(0, Sx - other * (Sx / b)));
}

// Які знижки застосувати: явні з тіла запиту (нова каса) → стара одна знижка = «на чек»
// → збережені на візиті (адмін зберіг рахунок раніше / застосунок клієнта).
function resolveSpecs(body, stored) {
  const b = body || {};
  if (b.discounts && typeof b.discounts === 'object') {
    return { svc: normSpec(b.discounts.services), prod: normSpec(b.discounts.products), check: normSpec(b.discounts.check) };
  }
  const legacy = normSpec({ type: b.discount_type, value: b.discount_value });
  if (legacy) return { svc: null, prod: null, check: legacy };
  return storedSpecs(stored);
}

function storedSpecs(a) {
  if (!a) return { svc: null, prod: null, check: null };
  return {
    svc: normSpec({ type: a.disc_svc_type, value: a.disc_svc_value }),
    prod: normSpec({ type: a.disc_prod_type, value: a.disc_prod_value }),
    check: normSpec({ type: a.disc_check_type, value: a.disc_check_value }),
  };
}

const MAT_LINE_SQL = `CASE WHEN p.price_per_gram IS NOT NULL THEN ROUND(am.qty_used * p.price_per_gram, 2)
                           WHEN pv.price IS NOT NULL THEN ROUND(am.qty_used * pv.price, 2) ELSE 0 END`;

// Повний рахунок візиту з БД (для застосунку, Mono-інвойсу, кнопки «Надіслати рахунок»).
// Сертифікат/бонуси тут не віднімаються: клієнт у застосунку платить грошима;
// якщо візит уже оплачено — віддаємо фактичні цифри оплати.
async function loadVisitBill(db, apptId) {
  const ar = await db.query(
    `SELECT a.id, a.client_id, a.master_id, a.status, a.starts_at, a.pay_settled_at, a.tenant_id,
            COALESCE(a.price, s.price, 0)::float AS price, s.name AS service_name,
            a.disc_svc_type, a.disc_svc_value::float, a.disc_prod_type, a.disc_prod_value::float,
            a.disc_check_type, a.disc_check_value::float,
            a.discount_amount::float, a.discount_services_amount::float, a.discount_products_amount::float,
            a.discount_check_amount::float, a.pay_cert_amount::float, a.pay_bonus_money::float,
            a.bill_prepaid_amount::float, a.bill_sub_amount::float, a.bill_sent_at
       FROM appointments a LEFT JOIN services s ON s.id = a.service_id WHERE a.id = $1`, [apptId]);
  const a = ar.rows[0];
  if (!a) return null;
  const items = (await db.query(
    `SELECT COALESCE(p.name, 'Товар') AS name, am.qty_used::float AS qty,
            (${MAT_LINE_SQL})::float AS amount
       FROM appointment_materials am
       JOIN product_variants pv ON pv.id = am.variant_id
       LEFT JOIN products p ON p.id = pv.product_id
      WHERE am.appointment_id = $1 ORDER BY am.id`, [apptId])).rows.filter(r => Number(r.amount) > 0);
  const P = round2(items.reduce((s, r) => s + Number(r.amount), 0));
  const S = round2(a.price);
  const cash = (await db.query(
    `SELECT COALESCE(SUM(amount),0)::float AS paid, MIN(method) AS method, COUNT(DISTINCT method)::int AS n
       FROM cash_operations WHERE ref_type='appointment' AND ref_id=$1 AND type='in'`, [apptId])).rows[0];
  const paid = !!a.pay_settled_at || Number(cash.paid) > 0;
  const specs = storedSpecs(a);
  let bill;
  if (paid) {
    // фактичні цифри проведеної оплати (старі візити: уся знижка = «на чек»)
    const legacy = a.discount_services_amount == null && a.discount_products_amount == null && a.discount_check_amount == null;
    const Ds = legacy ? 0 : round2(a.discount_services_amount), Dp = legacy ? 0 : round2(a.discount_products_amount);
    const Dc = legacy ? round2(a.discount_amount) : round2(a.discount_check_amount);
    bill = {
      services_total: S, products_total: P, sub: round2(a.bill_sub_amount),
      discount_services: Ds, discount_products: Dp, discount_check: Dc, discount_total: round2(Ds + Dp + Dc),
      certificate: round2(a.pay_cert_amount), bonus: round2(a.pay_bonus_money), prepaid: round2(a.bill_prepaid_amount),
      final: round2(cash.paid),
    };
  } else {
    let prepaid = 0;
    if (a.client_id) {
      const pb = await db.query(
        `SELECT prepaid_amount::float AS amt FROM online_bookings
          WHERE client_id = $1 AND prepaid_amount > 0 AND prepaid_at IS NOT NULL AND prepaid_consumed_at IS NULL
            AND date_from <= $2 AND date_to > $2 ORDER BY prepaid_at DESC LIMIT 1`, [a.client_id, a.starts_at]);
      prepaid = pb.rows[0] ? Number(pb.rows[0].amt) : 0;
    }
    bill = computeBill({ S, P, svc: specs.svc, prod: specs.prod, check: specs.check, prepaid });
  }
  return {
    appointment_id: a.id, client_id: a.client_id, master_id: a.master_id, tenant_id: a.tenant_id,
    status: a.status, starts_at: a.starts_at, service_name: a.service_name || 'Послуга',
    items, specs, paid, paid_amount: paid ? round2(cash.paid) : 0, paid_method: paid ? (cash.n > 1 ? 'mixed' : cash.method) : null,
    bill_sent_at: a.bill_sent_at, ...bill,
    lines: billLines({ ...bill, service_name: a.service_name, items, specs }),
  };
}

const fmtSpec = (s) => (s && s.type === 'percent' ? ` (${s.value}%)` : '');
// Рядки розшифровки для клієнта (застосунок, повідомлення бота) — однакові всюди.
function billLines(b) {
  const L = [];
  L.push({ label: b.service_name || 'Послуга', amount: round2(b.services_total) });
  for (const it of (b.items || [])) L.push({ label: it.name, amount: round2(it.amount) });
  if (b.sub > 0) L.push({ label: 'Абонемент', amount: -round2(b.sub) });
  if (b.discount_services > 0) L.push({ label: 'Знижка на послуги' + fmtSpec(b.specs && b.specs.svc), amount: -round2(b.discount_services) });
  if (b.discount_products > 0) L.push({ label: 'Знижка на товари' + fmtSpec(b.specs && b.specs.prod), amount: -round2(b.discount_products) });
  if (b.discount_check > 0) L.push({ label: 'Знижка на чек' + fmtSpec(b.specs && b.specs.check), amount: -round2(b.discount_check) });
  if (b.certificate > 0) L.push({ label: 'Сертифікат', amount: -round2(b.certificate) });
  if (b.bonus > 0) L.push({ label: 'Бонуси', amount: -round2(b.bonus) });
  if (b.prepaid > 0) L.push({ label: 'Передоплата', amount: -round2(b.prepaid) });
  return L;
}

// Перерахунок УЖЕ оплаченого візиту нової моделі (зміна товарів або ціни після оплати):
// знижки у % перераховуються від нових сум, у грн — обрізаються до частини; сертифікат,
// бонуси, абонемент і передоплата — ті самі гроші. Каса (sale_service/sale_product) і база ЗП
// оновлюються. db — клієнт ВСЕРЕДИНІ транзакції з RLS. Старі візити (bill_services_total NULL)
// не чіпаємо — для них лишається попередня логіка.
async function resyncPaidVisit(db, apptId) {
  const a = (await db.query(
    `SELECT a.id, a.pay_settled_at, a.bill_services_total, COALESCE(a.price, s.price, 0)::float AS price,
            a.disc_svc_type, a.disc_svc_value::float, a.disc_prod_type, a.disc_prod_value::float,
            a.disc_check_type, a.disc_check_value::float, a.pay_cert_amount::float, a.pay_bonus_money::float,
            a.bill_sub_amount::float, a.bill_prepaid_amount::float, a.master_id, COALESCE(s.name, 'візит #' || a.id::text) AS sname
       FROM appointments a LEFT JOIN services s ON s.id = a.service_id WHERE a.id=$1 FOR UPDATE OF a`, [apptId])).rows[0];
  if (!a || !a.pay_settled_at || a.bill_services_total == null) return { skipped: true };
  const P = Number((await db.query(
    `SELECT COALESCE(SUM(${MAT_LINE_SQL}),0)::float AS t FROM appointment_materials am
       JOIN product_variants pv ON pv.id = am.variant_id LEFT JOIN products p ON p.id = pv.product_id
      WHERE am.appointment_id=$1`, [apptId])).rows[0].t) || 0;
  const sp = storedSpecs(a);
  const b = computeBill({ S: a.price, P, sub: a.bill_sub_amount > 0 ? a.price : 0, svc: sp.svc, prod: sp.prod, check: sp.check,
    cert: a.pay_cert_amount, bonus: a.pay_bonus_money, prepaid: a.bill_prepaid_amount });
  const ops = (await db.query(
    `SELECT id, category, method, amount::float, shift_id, master_id, created_at FROM cash_operations
      WHERE type='in' AND ref_type='appointment' AND ref_id=$1 AND category IN ('sale_service','sale_product')
      ORDER BY id FOR UPDATE`, [apptId])).rows;
  let cashNote = null;
  if (!ops.length) {
    if (b.final > 0) cashNote = 'no-cash-rows'; // оплачено без грошей (сертифікат/бонуси) — метод невідомий, касу не вигадуємо
  } else {
    // частки методів (змішана оплата) зберігаємо
    const byM = {};
    for (const o of ops) byM[o.method] = round2((byM[o.method] || 0) + o.amount);
    const methods = Object.keys(byM);
    const oldTotal = round2(Object.values(byM).reduce((s, x) => s + x, 0));
    let svcLeft = b.service_cash, prodLeft = b.product_cash;
    methods.forEach((m, i) => {
      const last = i === methods.length - 1;
      const mTotal = last ? round2(svcLeft + prodLeft) : round2(b.final * (oldTotal > 0 ? byM[m] / oldTotal : 1 / methods.length));
      const sv = last ? svcLeft : Math.min(svcLeft, mTotal);
      const pr = last ? prodLeft : round2(mTotal - sv);
      svcLeft = round2(svcLeft - sv); prodLeft = round2(prodLeft - pr);
      byM[m] = { sale_service: round2(sv), sale_product: round2(pr) };
    });
    const tmpl = ops[0];
    for (const m of methods) {
      for (const cat of ['sale_service', 'sale_product']) {
        const want = byM[m][cat];
        const row = ops.find(o => o.method === m && o.category === cat);
        if (row) {
          if (want > 0) await db.query(`UPDATE cash_operations SET amount=$2 WHERE id=$1`, [row.id, want]);
          else await db.query(`DELETE FROM cash_operations WHERE id=$1`, [row.id]);
        } else if (want > 0) {
          await db.query(
            `INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, ref_id, master_id, description, created_at)
             VALUES ($1,'in',$2,$3,$4,'appointment',$5,$6,$7,$8)
             ON CONFLICT (tenant_id, ref_type, ref_id, method, category) WHERE type='in' AND ref_type='appointment' DO NOTHING`,
            [tmpl.shift_id, cat, want, m, apptId, tmpl.master_id || a.master_id || null,
             (cat === 'sale_product' ? 'Матеріали/товари до візиту: ' : '') + a.sname, tmpl.created_at]);
        }
      }
    }
  }
  await db.query(
    `UPDATE appointments SET discount_services_amount=$2, discount_products_amount=$3, discount_check_amount=$4,
            discount_amount=$5, bill_services_total=$6, bill_products_total=$7, real_amount=$8, updated_at=NOW()
      WHERE id=$1`,
    [apptId, b.discount_services, b.discount_products, b.discount_check, b.discount_total || null, b.services_total, b.products_total, b.real_amount]);
  return { ok: true, bill: b, cashNote };
}

module.exports = { round2, normSpec, discOf, computeBill, splitCash, realServiceAmount, resolveSpecs, storedSpecs,
  loadVisitBill, billLines, resyncPaidVisit, MAT_LINE_SQL };
