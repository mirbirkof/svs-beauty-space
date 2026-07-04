/* Data-аудитор денег CRM. ТОЛЬКО ЧТЕНИЕ — ничего не меняет.
   Проверяет не «кнопка есть», а «цифра верна»: сверяет формулы денег
   с реальными данными БД. Ловит класс багов уровня грамм-цены и ЗП-нулей,
   которые не видны через клики UI.

   Запуск:  node -r dotenv/config scripts/money_audit.js
   Опция:   YM=2026-06 node -r dotenv/config scripts/money_audit.js  (месяц ЗП) */
require('dotenv').config();
const { Client } = require('pg');

const q = async (c, sql, p = []) => (await c.query(sql, p)).rows;
const has = async (c, t) => (await c.query(
  `SELECT 1 FROM information_schema.tables WHERE table_name=$1`, [t])).rowCount > 0;
const col = async (c, t, n) => (await c.query(
  `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [t, n])).rowCount > 0;
const n = (v) => Math.round((+v || 0) * 100) / 100;

// лимиты из настроек салона (подтверждены Боссом 04.07)
const BONUS_LIMIT_PCT = 10;   // бонусами можно гасить не больше 10% чека
const CASHBACK_PCT = 3;       // кешбек 3% от оплаченного
const EPS = 0.5;              // допуск округления, грн

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const out = [];
  let fails = 0;
  const sec = (t) => out.push('\n━━ ' + t + ' ━━');
  const ok = (m) => out.push('  [+] ' + m);
  const bad = (m) => { out.push('  [-] ' + m); fails++; };
  const info = (m) => out.push('  [x] ' + m);

  try {
    // ═══ 1. ЗП МАСТЕРА = КАССА (класс бага «у всех 0») ═══
    sec('ЗП ↔ КАССА');
    const ym = process.env.YM || null; // YYYY-MM, по умолчанию — весь период
    const range = ym
      ? `AND created_at >= date_trunc('month', to_date($1,'YYYY-MM')) AND created_at < date_trunc('month', to_date($1,'YYYY-MM')) + interval '1 month'`
      : '';
    const rangeP = ym ? [ym] : [];
    if (await has(c, 'cash_operations')) {
      // выручка мастеров из кассы — источник истины для ЗП
      const perM = await q(c, `SELECT master_id, sum(amount) rev, count(*) ops
        FROM cash_operations WHERE type='in' AND master_id IS NOT NULL ${range}
        GROUP BY master_id ORDER BY rev DESC`, rangeP);
      if (!perM.length) {
        info(`в кассе нет доходных операций с master_id${ym ? ' за ' + ym : ''} — ЗП будет 0 у всех (это может быть правдой, а может — обрыв привязки)`);
      } else {
        ok(`мастеров с выручкой в кассе: ${perM.length}${ym ? ' за ' + ym : ''}, топ: ${perM.slice(0,3).map(x=>'#'+x.master_id+'='+n(x.rev)).join(', ')}`);
        const zero = perM.filter(x => n(x.rev) === 0);
        zero.length ? bad(`мастера с операциями но нулевой выручкой: ${zero.map(x=>'#'+x.master_id).join(', ')}`) : ok('нет мастеров с операциями и нулём в сумме');
      }
      // осиротевшие доходы — деньги есть, мастера нет → ЗП недосчитается
      const orph = await q(c, `SELECT count(*) k, sum(amount) s FROM cash_operations co
        LEFT JOIN masters m ON m.id=co.master_id
        WHERE co.type='in' AND co.master_id IS NOT NULL AND m.id IS NULL ${range}`, rangeP);
      +orph[0].k ? bad(`доход в кассе на несуществующих мастеров: ${orph[0].k} оп на ${n(orph[0].s)} грн (эти деньги выпадут из ЗП)`) : ok('вся выручка привязана к живым мастерам');
    } else info('таблицы cash_operations нет — пропуск');

    // ═══ 2. БОНУСЫ ≤ 10% ЧЕКА (лимит списания) ═══
    sec('БОНУСЫ ↔ ЛИМИТ 10%');
    if (await has(c, 'appointments') && await col(c, 'appointments', 'pay_bonus_money')) {
      const over = await q(c, `SELECT id, price, pay_bonus_money FROM appointments
        WHERE pay_settled_at IS NOT NULL AND COALESCE(pay_bonus_money,0) > 0
          AND COALESCE(pay_bonus_money,0) > (COALESCE(price,0) * ${BONUS_LIMIT_PCT}/100.0) + ${EPS}`);
      over.length ? bad(`визитов где бонусами погашено >10% чека: ${over.length} (напр. #${over[0].id}: чек ${n(over[0].price)}, бонусов ${n(over[0].pay_bonus_money)})`) : ok(`лимит 10% соблюдён на всех оплаченных визитах`);
      const neg = await q(c, `SELECT count(*) k FROM appointments WHERE COALESCE(pay_bonus_money,0)<0 OR COALESCE(pay_bonus_redeemed,0)<0`);
      +neg[0].k ? bad(`визитов с отрицательным списанием бонусов: ${neg[0].k}`) : ok('отрицательных списаний бонусов нет');
    } else info('колонок оплаты бонусами нет — пропуск');

    // ═══ 3. КЕШБЕК = 3% ОПЛАЧЕННОГО ═══
    sec('КЕШБЕК ↔ 3%');
    if (await has(c, 'appointments') && await col(c, 'appointments', 'pay_bonus_accrued')) {
      // начислено больше чем 3% живыми деньгами (после вычета скидок/бонусов) — переплата кешбека
      const badCb = await q(c, `SELECT id, price, discount_amount, pay_bonus_money, pay_cert_amount, pay_bonus_accrued
        FROM appointments WHERE pay_settled_at IS NOT NULL AND COALESCE(pay_bonus_accrued,0) > 0
          AND COALESCE(pay_bonus_accrued,0) > (
            GREATEST(COALESCE(price,0) - COALESCE(discount_amount,0) - COALESCE(pay_bonus_money,0) - COALESCE(pay_cert_amount,0), 0) * ${CASHBACK_PCT}/100.0) + ${EPS}
        ORDER BY id DESC LIMIT 5`);
      badCb.length ? bad(`визитов с кешбеком >3% реально оплаченного: ${badCb.length} (напр. #${badCb[0].id}: начислено ${n(badCb[0].pay_bonus_accrued)})`) : ok('кешбек нигде не превышает 3% оплаченного');
    } else info('колонки начисления кешбека нет — пропуск');

    // ═══ 4. ГРАММ-ЦЕНА: заряд материала = граммы × ₴/грам ═══
    sec('ГРАММ-ЦЕНА ↔ МАТЕРИАЛЫ');
    if (await has(c, 'appointment_materials') && await has(c, 'product_variants')) {
      const totalMat = await q(c, `SELECT count(*) k, count(*) FILTER(WHERE billable) bill FROM appointment_materials`);
      info(`материалов в визитах: ${totalMat[0].k}, из них платных: ${totalMat[0].bill}`);
      // платный материал, но у товара нет грамм-цены → нечем считать заряд
      const noPrice = await q(c, `SELECT am.id, pv.product_id FROM appointment_materials am
        JOIN product_variants pv ON pv.id=am.variant_id
        JOIN products p ON p.id=pv.product_id
        WHERE am.billable=true AND (p.price_per_gram IS NULL OR p.price_per_gram<=0)`);
      noPrice.length ? bad(`платных материалов без грамм-цены товара: ${noPrice.length} (заряд посчитается как 0 — тихая потеря денег)`) : ok('у всех платных материалов есть грамм-цена');
      // отрицательный или нулевой расход при billable
      const badQty = await q(c, `SELECT count(*) k FROM appointment_materials WHERE billable=true AND COALESCE(qty_used,0)<=0`);
      +badQty[0].k ? bad(`платных материалов с нулевым/отрицательным расходом: ${badQty[0].k}`) : ok('расход платных материалов положителен');
      // товар с грамм-ценой но без unit_ml на вариантах → склад в мл не спишется
      const noUnit = await q(c, `SELECT count(DISTINCT p.id) k FROM products p
        JOIN product_variants pv ON pv.product_id=p.id
        WHERE p.price_per_gram>0 AND (pv.unit_ml IS NULL OR pv.unit_ml<=0)`);
      +noUnit[0].k ? bad(`товаров с грамм-ценой но без объёма упаковки (unit_ml): ${noUnit[0].k} (списание из бутылки в мл сломается)`) : ok('у грамм-товаров задан объём упаковки');
    } else info('таблиц материалов/вариантов нет — пропуск');

    // ═══ 5. СКЛАД: не уходит в минус ═══
    sec('СКЛАД ↔ ОСТАТКИ');
    if (await has(c, 'product_variants')) {
      const negStock = await q(c, `SELECT count(*) k FROM product_variants WHERE COALESCE(stock_qty,0) < 0`);
      +negStock[0].k ? bad(`вариантов с отрицательным остатком: ${negStock[0].k} (продали больше чем было)`) : ok('отрицательных остатков нет');
      const negRes = await q(c, `SELECT count(*) k FROM product_variants WHERE COALESCE(reserved_qty,0) > COALESCE(stock_qty,0) AND COALESCE(reserved_qty,0)>0`);
      +negRes[0].k ? bad(`вариантов где резерв больше остатка: ${negRes[0].k}`) : ok('резерв нигде не превышает остаток');
    } else info('таблицы вариантов нет — пропуск');

    // ═══ 6. ОПЛАТА ВИЗИТА: идемпотентность расчёта ═══
    sec('ОПЛАТА ВИЗИТА ↔ ЦЕЛОСТНОСТЬ');
    if (await has(c, 'appointments') && await col(c, 'appointments', 'pay_settled_at')) {
      // визит помечен оплаченным, но чек 0 или отрицательный
      const zeroPaid = await q(c, `SELECT count(*) k FROM appointments WHERE pay_settled_at IS NOT NULL AND COALESCE(price,0)<0`);
      +zeroPaid[0].k ? bad(`оплаченных визитов с отрицательным чеком: ${zeroPaid[0].k}`) : ok('нет оплаченных визитов с отрицательным чеком');
      // сертификатом погашено больше чека
      if (await col(c, 'appointments', 'pay_cert_amount')) {
        const certOver = await q(c, `SELECT count(*) k FROM appointments
          WHERE pay_settled_at IS NOT NULL AND COALESCE(pay_cert_amount,0) > COALESCE(price,0)+${EPS}`);
        +certOver[0].k ? bad(`визитов где сертификатом погашено больше чека: ${certOver[0].k}`) : ok('сертификат нигде не превышает чек');
      }
    } else info('колонки расчёта визита нет — пропуск');

    out.push('\n' + '─'.repeat(42));
    out.push(fails === 0
      ? '  ИТОГ: [+] расхождений в деньгах не найдено'
      : `  ИТОГ: [-] найдено расхождений: ${fails} — смотри выше`);
  } catch (e) {
    bad('аудитор упал: ' + e.message);
  } finally {
    await c.end();
  }
  console.log(out.join('\n'));
  process.exit(fails === 0 ? 0 : 1);
})();
