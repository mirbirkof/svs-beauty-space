// 04.11: старі (закриті до правки) прод-візити → нова формула lib/visit-bill дає ті самі суми?
// Вхід: reports/discounts-0411/prod-snapshot-before.json (знімок READ ONLY). Без БД.
const path = require('path');
const VB = require(path.join(__dirname, '../backend/lib/visit-bill'));
const snap = require(path.join(__dirname, '../reports/discounts-0411/prod-snapshot-before.json'));
let bad = 0;
for (const v of snap) {
  const S = Number(v.price) || 0, P = Number(v.mat) || 0;
  // стара модель: знижка = «на чек» (сума), потім сертифікат, бонуси
  const b = VB.computeBill({ S, P, check: v.disc > 0 ? { type: 'fixed', value: v.disc } : null, cert: v.cert, bonus: v.bonus });
  const ra = VB.realServiceAmount({ S, P, other: VB.round2((v.disc || 0) + (v.cert || 0) + (v.bonus || 0)) });
  const ok = Math.abs(ra - v.real_amount) < 0.005 && Math.abs(b.service_cash - v.cash_svc) < 0.005 && Math.abs(b.product_cash - v.cash_prod) < 0.005;
  if (!ok) bad++;
  console.log(`${ok ? 'OK ' : 'DIFF'} #${v.id} ${v.k}: real ${v.real_amount}→${ra}  svc ${v.cash_svc}→${b.service_cash}  prod ${v.cash_prod}→${b.product_cash}`);
}
console.log(`ВСЬОГО ${snap.length}, розбіжностей ${bad}`);
process.exit(bad ? 1 : 0);
