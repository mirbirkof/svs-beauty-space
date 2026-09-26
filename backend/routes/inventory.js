/* Inventory audits: акты пересчёта, фиксация расхождений, авто-корректировка остатков
   Подключается как /api/inventory */
const express = require('express');
const { getPool, applyTenant } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();

// POST /api/inventory/audits — создать акт + наполнить позициями по scope
router.post('/audits', requirePerm('stock.manage'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { branch_id, scope, scope_filter, notes } = req.body || {};
    const scopeVal = scope || 'full';

    await client.query('BEGIN'); await applyTenant(client);

    // 25.09 (жалоба админа: «акт створений, але не відкривається» → жала «Створити» снова):
    // в проде 6 одинаковых актов за 9 минут, раньше — пары с разницей 3 с (двойной клик,
    // пока акт на 1100+ позиций собирался несколько секунд). Защита от дубля: тот же объём
    // (scope + фильтр + филиал), ещё в работе и создан < 2 мин назад → отдаём его, а не плодим.
    // Замок на транзакцию — чтобы два параллельных запроса двойного клика не проскочили оба.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('inventory_audits:create'))`);
    const dup = await client.query(
      `SELECT id, total_items FROM inventory_audits
        WHERE status = 'in_progress' AND scope = $1
          AND scope_filter IS NOT DISTINCT FROM $2::jsonb
          AND branch_id IS NOT DISTINCT FROM $3::int
          AND started_at > NOW() - INTERVAL '2 minutes'
        ORDER BY id DESC LIMIT 1`,
      [scopeVal, scope_filter ? JSON.stringify(scope_filter) : null, branch_id || null]
    );
    if (dup.rows[0]) {
      await client.query('COMMIT');
      return res.json({ ok: true, audit_id: dup.rows[0].id, items: dup.rows[0].total_items, reused: true });
    }

    const a = await client.query(
      `INSERT INTO inventory_audits (branch_id, status, started_by, scope, scope_filter, notes)
       VALUES ($1,'in_progress',$2,$3,$4,$5) RETURNING id`,
      [branch_id || null, req.user?.id || null, scopeVal, scope_filter ? JSON.stringify(scope_filter) : null, notes || null]
    );
    const auditId = a.rows[0].id;

    // Заполнение позиций — все товары или по фильтру
    let where = '1=1';
    const params = [];
    if (scopeVal === 'category' && scope_filter?.category_id) {
      params.push(scope_filter.category_id);
      where = `p.category_id = $${params.length}::text`;
    } else if (scopeVal === 'brand' && scope_filter?.brand_id) {
      params.push(scope_filter.brand_id);
      where = `p.brand_id = $${params.length}::text`;
    } else if (scopeVal === 'spot' && Array.isArray(scope_filter?.variant_ids)) {
      params.push(scope_filter.variant_ids);
      where = `v.id = ANY($${params.length}::int[])`;
    }

    // Наполнение ОДНИМ запросом (раньше — 1100+ отдельных INSERT по сети к Neon, несколько секунд
    // без индикации на экране; из-за этой паузы админ и жал «Створити» повторно).
    const auditParam = params.length + 1;
    const filled = await client.query(
      `INSERT INTO inventory_audit_items (audit_id, variant_id, product_name, sku, expected_qty, cost_per_unit)
       SELECT $${auditParam}, v.id, p.name, v.sku, COALESCE(v.stock_qty,0),
              -- Major #14: у ГРАМОВИХ товарів (price_per_gram) склад у мл, wholesale за пляшку → ÷unit_ml.
              -- Роздрібні банки: склад у ШТУКАХ (18.07), wholesale вже за одиницю — не ділимо.
              CASE WHEN p.price_per_gram IS NOT NULL
                   THEN COALESCE(v.wholesale,0) / NULLIF(GREATEST(v.unit_ml,1),0)
                   ELSE COALESCE(v.wholesale,0) END
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
        WHERE ${where}
          -- 26.09: вимкнені/видалені/склеєні картки в акт не потрапляють (раніше кожен акт
          -- містив їх: зайві рядки + підрахунок на мертву картку давав залишок, якого ніхто не бачить)
          AND v.active IS NOT FALSE AND p.active IS NOT FALSE
        ORDER BY v.id`,
      [...params, auditId]
    );
    const itemsCount = filled.rowCount;

    await client.query(`UPDATE inventory_audits SET total_items=$1 WHERE id=$2`, [itemsCount, auditId]);
    await client.query('COMMIT');
    await logAction({ user: req.user, action: 'inventory.start', entity: 'audit', entity_id: auditId, meta: { scope: scopeVal, items: itemsCount } });
    res.json({ ok: true, audit_id: auditId, items: itemsCount });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  } finally { client.release(); }
});

// GET /api/inventory/scopes — довідники для форми нового акту.
// ПРИЧИНА: category_id/brand_id у БД — ТЕКСТОВІ коди ('coloring', 'raywell'),
// а форма просила ввести числовий ID → акт «по категорії/бренду» не збирався ніколи.
// Віддаємо готові списки з кількістю позицій, щоб обирати мишкою, а не вгадувати.
router.get('/scopes', requirePerm('stock.read'), async (req, res) => {
  try {
    const cats = await pool.query(
      `SELECT c.id::text AS id, c.name, COUNT(v.id)::int AS items
         FROM categories c
         JOIN products p ON p.category_id = c.id
         JOIN product_variants v ON v.product_id = p.id
        GROUP BY c.id, c.name
       HAVING COUNT(v.id) > 0
        ORDER BY c.name`
    );
    const brands = await pool.query(
      `SELECT b.id::text AS id, b.name, COUNT(v.id)::int AS items
         FROM brands b
         JOIN products p ON p.brand_id = b.id
         JOIN product_variants v ON v.product_id = p.id
        GROUP BY b.id, b.name
       HAVING COUNT(v.id) > 0
        ORDER BY b.name`
    );
    res.json({ categories: cats.rows, brands: brands.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/inventory/audits — список
router.get('/audits', requirePerm('stock.read'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.*,
              (SELECT COUNT(*) FROM inventory_audit_items i WHERE i.audit_id=a.id AND i.actual_qty IS NOT NULL)::int AS counted,
              (SELECT COUNT(*) FROM inventory_audit_items i WHERE i.audit_id=a.id AND i.diff_qty <> 0)::int AS discrepancies
         FROM inventory_audits a
        ORDER BY a.started_at DESC LIMIT 50`
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/inventory/audits/:id — детали + позиции
router.get('/audits/:id', requirePerm('stock.read'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const a = await pool.query(`SELECT * FROM inventory_audits WHERE id=$1`, [id]);
    if (!a.rows[0]) return res.status(404).json({ error: 'not-found' });
    // 26.09 (crm-sort-2609): порядок Тип → Бренд → назва по-людськи (тони 1.0 < 6.04 < 10.1 < 1002, регістр не рве
    // групи) — та сама функція, що на складі (lib/stock-sort). Раніше ORDER BY product_name — текстом.
    const items = await pool.query(
      `SELECT i.*, v.volume, v.unit_ml, p.brand_id, b.name AS brand_name, p.category_id, p.attrs, p.price_per_gram
         FROM inventory_audit_items i
         LEFT JOIN product_variants v ON v.id = i.variant_id
         LEFT JOIN products p ON p.id = v.product_id
         LEFT JOIN brands b ON b.id = p.brand_id
        WHERE i.audit_id=$1`, [id]
    );
    // 26.09 (Босс: «щоб можна було редагувати ціну й зберігати»): поточна роздрібна/оптова ціна
    // варіанта — для поля ціни в акті (зберігається через PATCH /api/admin/variants/:id).
    const vids = [...new Set(items.rows.map((r) => r.variant_id).filter(Boolean))];
    if (vids.length) {
      const pr = await pool.query(`SELECT id, price, wholesale FROM product_variants WHERE id = ANY($1::int[])`, [vids]);
      const byId = new Map(pr.rows.map((r) => [r.id, r]));
      for (const r of items.rows) { const v = byId.get(r.variant_id); r.price = v ? v.price : null; r.wholesale = v ? v.wholesale : null; }
    }
    res.json({ audit: a.rows[0], items: require('../lib/stock-sort').prepareStockRows(items.rows) });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// PATCH /api/inventory/items/:id — внести факт по одной позиции
// 26.09 (Босс: «факт зберігається, але не переноситься в залишки»). ПРИЧИНА (прод, акт №10):
// акт провели в 14:30, а факт по «BIO HIDRA Крем 10 в 1» внесли в 14:37 — PATCH не смотрел на
// статус акта, цифра легла в закрытый акт, а в остаток не попала никогда (перенос — только при
// проведении). Теперь:
//   • акт в работе      → как раньше: факт в акт, в остаток — при проведении;
//   • акт ПРОВЕДЁН      → правка сразу применяется к остатку как корректировка: движение
//                         'inventory_audit' на (новое расхождение − уже применённое по строке,
//                         applied_qty) — повторное сохранение того же числа ничего не меняет,
//                         двойного применения нет (строка акта и строка акта-шапки под FOR UPDATE);
//   • акт СКАСОВАНО     → 409 с понятным текстом, ничего не пишем.
router.patch('/items/:id', requirePerm('stock.manage'), async (req, res) => {
  const id = Number(req.params.id);
  const { actual_qty, reason, notes } = req.body || {};
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad-id' });
  if (actual_qty == null || actual_qty === '') return res.status(400).json({ error: 'actual_qty required', message: 'Введіть фактичну кількість' });
  const actual = Number(actual_qty);
  if (!Number.isFinite(actual) || actual < 0 || actual > 1e9) {
    return res.status(400).json({ error: 'actual_qty must be >= 0', message: 'Фактична кількість — число від 0' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await applyTenant(client);
    const it = await client.query(
      `SELECT i.id, i.audit_id, i.variant_id, i.cost_per_unit, i.expected_qty, i.applied_qty, a.status
         FROM inventory_audit_items i JOIN inventory_audits a ON a.id = i.audit_id
        WHERE i.id=$1 FOR UPDATE OF i, a`, [id]);
    const row = it.rows[0];
    if (!row) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not-found' }); }
    if (row.status !== 'in_progress' && row.status !== 'completed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'audit-closed', status: row.status,
        message: 'Акт скасовано — факт у нього не вноситься. Створіть новий акт.' });
    }
    const diffQty = Math.round((actual - Number(row.expected_qty)) * 1000) / 1000;
    const diffVal = diffQty * Number(row.cost_per_unit || 0);
    let applied = null; let stockDelta = 0;
    if (row.status === 'completed') {
      const already = Number(row.applied_qty || 0);
      stockDelta = Math.round((diffQty - already) * 1000) / 1000;
      if (stockDelta !== 0) {
        await client.query(`UPDATE product_variants SET stock_qty = GREATEST(0, COALESCE(stock_qty,0) + $1) WHERE id=$2`, [stockDelta, row.variant_id]);
        const who = (req.user && (req.user.display_name || req.user.name)) || '';
        await client.query(
          `INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes)
           VALUES ($1,$2,'inventory_audit',$3,$4)`,
          [row.variant_id, stockDelta, row.audit_id, 'правка факту в проведеному акті' + (who ? ' · ' + who : '')]);
        await client.query(
          `UPDATE inventory_audits SET total_diff = COALESCE(total_diff,0) + $1 WHERE id=$2`,
          [stockDelta * Number(row.cost_per_unit || 0), row.audit_id]);
      }
      applied = diffQty;
    }
    await client.query(
      `UPDATE inventory_audit_items
          SET actual_qty=$1, reason=$2, notes=$3, diff_value=$4, counted_at=NOW(), counted_by=$5,
              applied_qty = CASE WHEN $7::boolean THEN $8::numeric ELSE applied_qty END
        WHERE id=$6`,
      [actual, reason || null, notes || null, diffVal, req.user?.id || null, id, row.status === 'completed', applied]
    );
    await client.query('COMMIT');
    if (stockDelta !== 0) {
      await logAction({ user: req.user, action: 'inventory.item_after_complete', entity: 'audit', entity_id: row.audit_id,
        meta: { item: id, variant_id: row.variant_id, actual, stock_delta: stockDelta } });
    }
    res.json({ ok: true, diff_value: diffVal, diff_qty: diffQty, audit_status: row.status,
               applied_to_stock: row.status === 'completed', stock_delta: stockDelta });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  } finally { client.release(); }
});

// POST /api/inventory/audits/:id/complete — закрыть акт + применить корректировки
router.post('/audits/:id/complete', requirePerm('stock.manage'), async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    await client.query('BEGIN'); await applyTenant(client);
    const a = await client.query(`SELECT * FROM inventory_audits WHERE id=$1 FOR UPDATE`, [id]);
    if (!a.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not-found' }); }
    if (a.rows[0].status === 'completed') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'already-completed', message: 'Акт уже проведено' }); }
    // скасований акт провести не можна (раніше проходив — «воскресав» і змінював залишки)
    if (a.rows[0].status !== 'in_progress') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'not-in-progress', message: 'Акт скасовано — провести його не можна' }); }

    // Все посчитанные позиции с расхождением → корректировка остатков + лог
    const diffs = await client.query(
      `SELECT * FROM inventory_audit_items WHERE audit_id=$1 AND actual_qty IS NOT NULL AND diff_qty <> 0`,
      [id]
    );

    let totalDiff = 0;
    for (const row of diffs.rows) {
      // КРИТИЧНО: expected_qty — снапшот остатка на МОМЕНТ СТАРТА акта. Если пока акт был
      // открыт, случились другие движения (приход/списание/продажа), они уже изменили
      // текущий stock_qty независимо от акта. Раньше здесь ставили stock_qty=actual_qty
      // (абсолютное значение из подсчёта) — это стирало все движения, случившиеся после
      // старта акта, откатывая остаток к моменту снапшота. Правильно — прибавить К ТЕКУЩЕМУ
      // остатку именно найденное расхождение (diff_qty = actual - expected), тогда чужие
      // движения, которые уже применились к stock_qty, сохраняются, а поправка от акта
      // накладывается поверх них.
      await client.query(`UPDATE product_variants SET stock_qty = GREATEST(0, COALESCE(stock_qty,0) + $1) WHERE id=$2`, [row.diff_qty, row.variant_id]);
      // лог движения: delta = diff_qty (actual - expected), reason фиксирует акт инвентаризации
      await client.query(
        `INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes)
         VALUES ($1,$2,'inventory_audit',$3,$4)`,
        [row.variant_id, row.diff_qty, id, row.reason || null]
      );
      totalDiff += Number(row.diff_value || 0);
    }
    // 26.09: фиксируем, сколько по каждой строке применено к остатку (applied_qty) — от этого
    // считается корректировка, если факт поправят уже после проведения (без двойного применения).
    await client.query(
      `UPDATE inventory_audit_items SET applied_qty = COALESCE(diff_qty, 0)
        WHERE audit_id=$1 AND actual_qty IS NOT NULL`, [id]);
    const cnt = await client.query(
      `SELECT COUNT(*) FILTER (WHERE actual_qty IS NOT NULL)::int AS counted, COUNT(*)::int AS total
         FROM inventory_audit_items WHERE audit_id=$1`, [id]);

    await client.query(
      `UPDATE inventory_audits
          SET status='completed', completed_at=NOW(), completed_by=$1, total_diff=$2
        WHERE id=$3`,
      [req.user?.id || null, totalDiff, id]
    );

    await client.query('COMMIT');
    await logAction({ user: req.user, action: 'inventory.complete', entity: 'audit', entity_id: id, meta: { adjusted: diffs.rows.length, total_diff: totalDiff } });
    res.json({ ok: true, adjusted: diffs.rows.length, total_diff: totalDiff,
               counted: cnt.rows[0].counted, total: cnt.rows[0].total });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  } finally { client.release(); }
});

// DELETE /api/inventory/audits/:id — отменить незавершённый
router.delete('/audits/:id', requirePerm('stock.manage'), async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE inventory_audits SET status='cancelled' WHERE id=$1 AND status<>'completed' RETURNING id`,
      [Number(req.params.id)]
    );
    if (!r.rows[0]) return res.status(400).json({ error: 'cannot-cancel' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
