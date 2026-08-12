#!/usr/bin/env node
/* ops/reserve-watch.js — СТОРОЖ РЕЗЕРВОВ СКЛАДА.
 *
 * ЗАЧЕМ (найдено 12.08 при работе над модулем магазина). Заказ с витрины резервирует товар:
 * available = stock_qty − reserved_qty. Резерв снимается при оплате или при отмене неоплаченного.
 * Если заказ где-то оборвался (сбой, брошенная корзина, прерванный тест) — резерв остаётся
 * висеть НАВСЕГДА и молча уменьшает доступный остаток. Симптом для владельца: «товар есть на
 * складе, а заказать нельзя» — при этом ни в одном отчёте причина не видна.
 *
 * ЧТО ДЕЛАЕТ. Считает эталон: сколько единиц ДОЛЖНО быть зарезервировано = сумма позиций
 * заказов в статусе 'new' (только они держат резерв). Сравнивает с фактом в product_variants.
 * Расхождение — либо висячий резерв (факт больше), либо потерянный (факт меньше).
 *
 * ПОЧЕМУ ЭТО МОЖНО ЧИНИТЬ АВТОМАТОМ (в отличие от money-watch, который не трогает деньги):
 * резерв — не деньги и не остаток товара, а служебная блокировка, вычисляемая из заказов
 * на 100% детерминированно. Ошибиться здесь нельзя: эталон считается из тех же заказов,
 * ради которых резерв и существует. Сам stock_qty НЕ трогаем никогда.
 *
 * Запуск:  node -r dotenv/config ops/reserve-watch.js [--fix] [--quiet]
 *   без --fix  — только показать расхождения (dry-run)
 *   --fix      — выровнять reserved_qty по эталону и уведомить владельца
 *   --quiet    — молчать, когда всё чисто (для крона)
 */
const { Client } = require('pg');
const { execSync } = require('child_process');

const FIX = process.argv.includes('--fix');
const QUIET = process.argv.includes('--quiet');

function notify(text) {
  try {
    execSync(
      `curl -s -m 15 -X POST http://127.0.0.1:3005/notify -H "x-notify-token: ${process.env.RESTART_TOKEN || 'jarvis-restart-2026'}" -H "Content-Type: application/json" -d @-`,
      { input: JSON.stringify({ text }), encoding: 'utf8' }
    );
    return true;
  } catch (e) { console.log('[reserve-watch] notify failed:', e.message); return false; }
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    // эталон: резерв держат ТОЛЬКО заказы в статусе 'new'
    const r = await c.query(`
      SELECT v.id, p.name AS product_name, v.volume,
             COALESCE(v.reserved_qty,0)::numeric AS actual,
             COALESCE(e.expected,0)::numeric     AS expected,
             COALESCE(v.stock_qty,0)::numeric    AS stock
        FROM product_variants v
        JOIN products p ON p.id = v.product_id
        LEFT JOIN (
          SELECT oi.variant_id, SUM(oi.qty) AS expected
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
           WHERE o.status = 'new'
           GROUP BY oi.variant_id
        ) e ON e.variant_id = v.id
       WHERE COALESCE(v.reserved_qty,0) <> COALESCE(e.expected,0)
       ORDER BY (COALESCE(v.reserved_qty,0) - COALESCE(e.expected,0)) DESC`);

    if (!r.rowCount) {
      if (!QUIET) console.log('[reserve-watch] чисто: резервы совпадают с активными заказами');
      return;
    }

    const stuck = r.rows.filter(x => Number(x.actual) > Number(x.expected));
    const lost  = r.rows.filter(x => Number(x.actual) < Number(x.expected));
    const blocked = stuck.filter(x => Number(x.stock) - Number(x.actual) <= 0 && Number(x.stock) > 0);

    console.log(`[reserve-watch] расхождений: ${r.rowCount} (висячих: ${stuck.length}, потерянных: ${lost.length}, блокируют продажу: ${blocked.length})`);
    for (const x of r.rows.slice(0, 20)) {
      console.log(`  ${x.product_name} ${x.volume || ''}: резерв ${x.actual}, должно ${x.expected}, на складе ${x.stock}`);
    }

    if (!FIX) { console.log('[reserve-watch] dry-run. Для исправления: --fix'); return; }

    await c.query('BEGIN');
    for (const x of r.rows) {
      await c.query(`UPDATE product_variants SET reserved_qty = $2 WHERE id = $1`, [x.id, Number(x.expected)]);
    }
    await c.query('COMMIT');
    console.log(`[reserve-watch] выровнено позиций: ${r.rowCount}`);

    const top = stuck.slice(0, 5)
      .map(x => `• ${x.product_name} ${x.volume || ''} — висело ${x.actual}, доступно стало +${Number(x.actual) - Number(x.expected)}`)
      .join('\n');
    notify(
      `<b>Склад: знятi зайвi резерви</b>\n` +
      `Товар був на складi, але його не можна було замовити — заважали резерви вiд обiрваних замовлень.\n` +
      `Виправлено позицiй: <b>${r.rowCount}</b>${blocked.length ? ` (з них повнiстю блокували продаж: ${blocked.length})` : ''}\n` +
      (top ? `\n${top}` : '')
    );
  } finally {
    await c.end();
  }
})().catch(e => { console.error('[reserve-watch] FAIL:', e.message); process.exit(1); });
