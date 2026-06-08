/* E2E стресс-тест экосистемы SVS
   Полный путь: открыть смену → создать заказ → paid → касса → закрыть смену → Z-звіт → P&L
   Запуск: node scripts/e2e-stress.js
*/
require('dotenv').config({ path: __dirname + '/../.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const log = (ok, msg, extra) => {
  const m = (ok ? '✓ ' : '✗ ') + msg + (extra ? ' — ' + JSON.stringify(extra) : '');
  console.log(m);
  return ok;
};

async function run() {
  let pass = 0, fail = 0;
  const T = async (name, fn) => {
    try { const r = await fn(); log(true, name, r); pass++; return r; }
    catch (e) { log(false, name + ': ' + e.message); fail++; return null; }
  };

  console.log('═══ SVS E2E STRESS TEST ═══\n');

  // === 0. Sanity: схема в порядке ===
  const tablesCheck = await T('Схема: все CRM-таблицы существуют', async () => {
    const r = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
      AND tablename IN ('cash_shifts','cash_operations','z_reports','roles','users','user_tokens',
                        'audit_log','inventory_audits','inventory_audit_items','branches','tax_records',
                        'orders','order_items','product_variants','clients','payroll_records')`);
    const found = r.rows.map(x => x.tablename).sort();
    if (found.length < 16) throw new Error('missing tables, found: ' + found.length);
    return { tables: found.length };
  });

  // === 1. Подготовка: чистый клиент, товар, мастер ===
  const setup = await T('Setup: тестовый клиент + товар', async () => {
    const c = await pool.query(
      `INSERT INTO clients (phone, name, email) VALUES ('+380999000001','E2E Test Client','e2e@test.local')
       ON CONFLICT (phone) DO UPDATE SET name=EXCLUDED.name RETURNING id`);

    let prod = await pool.query(`SELECT id FROM products LIMIT 1`);
    if (!prod.rows[0]) throw new Error('нет товаров в БД');
    let variant = await pool.query(
      `SELECT id, stock_qty, price FROM product_variants WHERE product_id=$1 LIMIT 1`, [prod.rows[0].id]);
    if (!variant.rows[0]) throw new Error('нет вариантов товара');

    // обеспечить stock
    await pool.query(`UPDATE product_variants SET stock_qty=100 WHERE id=$1`, [variant.rows[0].id]);
    return { client_id: c.rows[0].id, variant_id: variant.rows[0].id, price: variant.rows[0].price };
  });
  if (!setup) return;

  // === 2. Открыть кассовую смену ===
  // закрыть прошлую если осталась
  await pool.query(`UPDATE cash_shifts SET status='closed', closed_at=NOW() WHERE status='open'`);
  const shift = await T('Касса: открытие смены с opening_cash=1000', async () => {
    const r = await pool.query(
      `INSERT INTO cash_shifts (opening_cash, notes) VALUES (1000, 'E2E test') RETURNING id, opening_cash`);
    return r.rows[0];
  });

  // === 3. Создать заказ в new ===
  const PRICE = Number(setup.price) || 500;
  const order = await T('Магазин: создать заказ (new, total=' + PRICE + ')', async () => {
    const o = await pool.query(
      `INSERT INTO orders (client_id, total, status, created_at) VALUES ($1, $2, 'new', NOW()) RETURNING id`,
      [setup.client_id, PRICE]);
    const v = await pool.query(`SELECT p.name AS pname, v.volume FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1`, [setup.variant_id]);
    await pool.query(
      `INSERT INTO order_items (order_id, variant_id, product_name, volume, qty, unit_price, line_total)
       VALUES ($1, $2, $3, $4, 1, $5, $5)`,
      [o.rows[0].id, setup.variant_id, v.rows[0]?.pname || 'Test', v.rows[0]?.volume || null, PRICE]);
    return { order_id: o.rows[0].id };
  });

  // === 4. Перевести в paid через API logic ===
  // Эмулируем то что делает admin.js PATCH /orders/:id/status
  await T('Заказ: переход new→paid (склад -1, бонусы +3%, касса +' + PRICE + ')', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(`SELECT status, client_id, total FROM orders WHERE id=$1 FOR UPDATE`, [order.order_id]);

      // склад
      const items = await client.query(`SELECT variant_id, qty FROM order_items WHERE order_id=$1`, [order.order_id]);
      for (const it of items.rows) {
        await client.query(`UPDATE product_variants SET stock_qty=GREATEST(0, COALESCE(stock_qty,0)-$1) WHERE id=$2`, [it.qty, it.variant_id]);
        await client.query(`INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes) VALUES ($1,$2,'sale',$3,$4)`,
          [it.variant_id, -it.qty, String(order.order_id), 'E2E']);
      }

      // бонусы
      await client.query(
        `UPDATE clients SET loyalty_points = COALESCE(loyalty_points,0) + FLOOR($2*0.03)::int,
                            total_spent = COALESCE(total_spent,0) + $2 WHERE id=$1`,
        [cur.rows[0].client_id, cur.rows[0].total]);

      // касса
      const sh = await client.query(`SELECT id FROM cash_shifts WHERE status='open' ORDER BY opened_at DESC LIMIT 1`);
      await client.query(
        `INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, ref_id, description)
         VALUES ($1,'in','sale_product',$2,'card','order',$3,$4)`,
        [sh.rows[0].id, cur.rows[0].total, order.order_id, `Замовлення #${order.order_id}`]);

      await client.query(`UPDATE orders SET status='paid', updated_at=NOW() WHERE id=$1`, [order.order_id]);
      await client.query('COMMIT');
      return { ok: true };
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  });

  // === 5. Проверка: склад уменьшился ===
  await T('Проверка: склад уменьшился ровно на 1', async () => {
    const r = await pool.query(`SELECT stock_qty FROM product_variants WHERE id=$1`, [setup.variant_id]);
    if (r.rows[0].stock_qty !== 99) throw new Error('expected 99, got ' + r.rows[0].stock_qty);
    return { stock: r.rows[0].stock_qty };
  });

  // === 6. Проверка: бонусы начислены ===
  await T('Проверка: бонусы клиента ≥ FLOOR(price*0.03)', async () => {
    const r = await pool.query(`SELECT loyalty_points FROM clients WHERE id=$1`, [setup.client_id]);
    const expected = Math.floor(PRICE * 0.03);
    if (Number(r.rows[0].loyalty_points) < expected) throw new Error('expected ≥' + expected + ', got ' + r.rows[0].loyalty_points);
    return { points: r.rows[0].loyalty_points, expected };
  });

  // === 7. Проверка: касса видит операцию ===
  await T('Проверка: касса имеет операцию +' + PRICE, async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n, SUM(amount)::numeric AS sum FROM cash_operations WHERE shift_id=$1 AND type='in'`, [shift.id]);
    if (Number(r.rows[0].sum) < PRICE) throw new Error('cash_in mismatch');
    return { ops: r.rows[0].n, sum: Number(r.rows[0].sum) };
  });

  // === 8. Добавить ручной расход (аренда) ===
  await T('Касса: ручной расход (аренда 500)', async () => {
    await pool.query(
      `INSERT INTO cash_operations (shift_id, type, category, amount, method, description)
       VALUES ($1,'out','rent',500,'cash','E2E аренда')`, [shift.id]);
    return { ok: true };
  });

  // === 9. Закрыть смену + Z-отчёт ===
  const z = await T('Касса: закрытие смены + Z-звіт', async () => {
    const sums = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN type='in' THEN amount ELSE 0 END),0) AS tin,
              COALESCE(SUM(CASE WHEN type='out' THEN amount ELSE 0 END),0) AS tout,
              COALESCE(SUM(CASE WHEN type='in' AND method='cash' THEN amount ELSE 0 END),0) AS cin,
              COALESCE(SUM(CASE WHEN type='out' AND method='cash' THEN amount ELSE 0 END),0) AS cout
         FROM cash_operations WHERE shift_id=$1`, [shift.id]);
    const expected = Number(shift.opening_cash) + Number(sums.rows[0].cin) - Number(sums.rows[0].cout);
    await pool.query(
      `UPDATE cash_shifts SET status='closed', closed_at=NOW(), closing_cash=$1, expected_cash=$1, difference=0 WHERE id=$2`,
      [expected, shift.id]);
    const zRes = await pool.query(
      `INSERT INTO z_reports (shift_id, period_start, period_end, total_in, total_out, cash_in, cash_out,
                              opening_cash, closing_cash, expected_cash, difference, operations_cnt)
       VALUES ($1, (SELECT opened_at FROM cash_shifts WHERE id=$1), NOW(), $2, $3, $4, $5,
               (SELECT opening_cash FROM cash_shifts WHERE id=$1), $6, $6, 0,
               (SELECT COUNT(*) FROM cash_operations WHERE shift_id=$1)) RETURNING report_no, total_in, total_out`,
      [shift.id, sums.rows[0].tin, sums.rows[0].tout, sums.rows[0].cin, sums.rows[0].cout, expected]);
    return zRes.rows[0];
  });

  // === 10. P&L за сегодня ===
  await T('P&L: доход ≥ ' + PRICE + ', расходы ≥ 500', async () => {
    const today = new Date(); today.setHours(0,0,0,0);
    const r = await pool.query(
      `SELECT (SELECT COALESCE(SUM(total),0) FROM orders WHERE status='paid' AND created_at>=$1) AS rev,
              (SELECT COALESCE(SUM(amount),0) FROM cash_operations WHERE type='out' AND created_at>=$1) AS exp`,
      [today.toISOString()]);
    const rev = Number(r.rows[0].rev), exp = Number(r.rows[0].exp);
    if (rev < PRICE) throw new Error('revenue ' + rev + ' < ' + PRICE);
    if (exp < 500) throw new Error('expense ' + exp + ' < 500');
    return { revenue: rev, expense: exp, profit: rev - exp };
  });

  // === 11. Cleanup ===
  await T('Cleanup: удалить тестовые записи', async () => {
    await pool.query(`DELETE FROM cash_operations WHERE shift_id=$1`, [shift.id]);
    await pool.query(`DELETE FROM z_reports WHERE shift_id=$1`, [shift.id]);
    await pool.query(`DELETE FROM cash_shifts WHERE id=$1`, [shift.id]);
    // удаляем все хвосты клиента (на случай предыдущих падений)
    await pool.query(`DELETE FROM stock_movements WHERE ref_id IN (SELECT id::text FROM orders WHERE client_id=$1)`, [setup.client_id]).catch(()=>{});
    await pool.query(`DELETE FROM loyalty_ledger WHERE client_id=$1`, [setup.client_id]).catch(()=>{});
    await pool.query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE client_id=$1)`, [setup.client_id]);
    await pool.query(`DELETE FROM orders WHERE client_id=$1`, [setup.client_id]);
    await pool.query(`DELETE FROM clients WHERE id=$1`, [setup.client_id]);
    await pool.query(`UPDATE product_variants SET stock_qty=stock_qty+1 WHERE id=$1`, [setup.variant_id]);
    return { ok: true };
  });

  console.log(`\n═══ Result: ${pass} passed · ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(2); });
