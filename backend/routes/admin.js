/* ═══════════════════════════════════════════════════════
   SVS Beauty World — Admin API
   Все эндпоинты требуют header: X-Admin-Token

   Товары / варианты:
     GET    /api/admin/products              — список с фильтрами
     POST   /api/admin/products              — создать товар
     PATCH  /api/admin/products/:id          — обновить товар
     DELETE /api/admin/products/:id          — отключить (soft delete)
     POST   /api/admin/products/:id/variants — добавить вариант
     PATCH  /api/admin/variants/:id          — изменить цену/остаток
     POST   /api/admin/variants/:id/stock    — приход товара (склад)

   Заказы:
     GET    /api/admin/orders                — список всех заказов
     GET    /api/admin/orders/:id            — заказ + позиции + клиент
     PATCH  /api/admin/orders/:id/status     — смена статуса

   Клиенты:
     GET    /api/admin/clients               — список клиентов
     GET    /api/admin/clients/:id           — клиент + история заказов

   Аналитика:
     GET    /api/admin/stats                 — KPI: выручка/заказы/клиенты
     GET    /api/admin/stats/top-products    — топ товаров по выручке
     GET    /api/admin/stats/low-stock       — товары с низким остатком
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { notifyOrderStatus } = require('./telegram-notify');

// ── middleware: проверка ADMIN_TOKEN ────────────────────
router.use((req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN) {
    return res.status(503).json({ error: 'admin-not-configured' });
  }
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// ═══════════════════════════════════════════════════════
//   ТОВАРЫ И ВАРИАНТЫ
// ═══════════════════════════════════════════════════════

router.get('/products', async (req, res) => {
  try {
    const pool = getPool();
    const { search, brand, category, active, limit = 50, offset = 0 } = req.query;
    const cond = [];
    const args = [];
    if (search) { args.push(`%${search}%`); cond.push(`p.name ILIKE $${args.length}`); }
    if (brand) { args.push(brand); cond.push(`p.brand_id = $${args.length}`); }
    if (category) { args.push(category); cond.push(`p.category_id = $${args.length}`); }
    if (active != null) { args.push(active === 'true'); cond.push(`p.active = $${args.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    args.push(parseInt(limit, 10), parseInt(offset, 10));
    const r = await pool.query(
      `SELECT p.id, p.name, p.brand_id, p.category_id, p.active, p.featured,
              (SELECT COUNT(*) FROM product_variants WHERE product_id = p.id) AS variants_count,
              (SELECT SUM(stock_qty) FROM product_variants WHERE product_id = p.id) AS total_stock,
              (SELECT MIN(price) FROM product_variants WHERE product_id = p.id) AS price_from
       FROM products p
       ${where}
       ORDER BY p.id DESC
       LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args
    );
    res.json({ ok: true, items: r.rows });
  } catch (e) { console.error('[admin:products]', e); res.status(500).json({ error: 'internal' }); }
});

router.post('/products', async (req, res) => {
  try {
    const { id, name, brand_id, category_id, photo, description, featured = false } = req.body || {};
    if (!id || !name || !brand_id) return res.status(400).json({ error: 'id-name-brand-required' });
    const pool = getPool();
    const r = await pool.query(
      `INSERT INTO products (id, name, brand_id, category_id, photo, description, featured, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
      [id, name, brand_id, category_id, photo, description, featured]
    );
    res.status(201).json({ ok: true, product: r.rows[0] });
  } catch (e) { console.error('[admin:create-product]', e); res.status(500).json({ error: 'internal', detail: e.message }); }
});

router.patch('/products/:id', async (req, res) => {
  try {
    const { name, brand_id, category_id, photo, description, featured, active } = req.body || {};
    const pool = getPool();
    const r = await pool.query(
      `UPDATE products SET
         name = COALESCE($2, name),
         brand_id = COALESCE($3, brand_id),
         category_id = COALESCE($4, category_id),
         photo = COALESCE($5, photo),
         description = COALESCE($6, description),
         featured = COALESCE($7, featured),
         active = COALESCE($8, active),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, name, brand_id, category_id, photo, description, featured, active]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, product: r.rows[0] });
  } catch (e) { console.error('[admin:patch-product]', e); res.status(500).json({ error: 'internal' }); }
});

router.delete('/products/:id', async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE products SET active = false, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, deactivated: r.rows[0].id });
  } catch (e) { console.error('[admin:del-product]', e); res.status(500).json({ error: 'internal' }); }
});

router.post('/products/:id/variants', async (req, res) => {
  try {
    const { volume, price, wholesale, sku, stock_qty = 0, branch_id } = req.body || {};
    if (!volume || price == null) return res.status(400).json({ error: 'volume-price-required' });
    const pool = getPool();
    const r = await pool.query(
      `INSERT INTO product_variants (product_id, volume, price, wholesale, sku, stock_qty, active, branch_id)
       VALUES ($1,$2,$3,$4,$5,$6,true,
               COALESCE($7, (SELECT id FROM branches WHERE is_default = true LIMIT 1)))
       RETURNING *`,
      [req.params.id, volume, price, wholesale || price, sku, stock_qty, branch_id || null]
    );
    res.status(201).json({ ok: true, variant: r.rows[0] });
  } catch (e) { console.error('[admin:add-variant]', e); res.status(500).json({ error: 'internal', detail: e.message }); }
});

router.patch('/variants/:id', async (req, res) => {
  try {
    const { volume, price, wholesale, sku, stock_qty, active } = req.body || {};
    const pool = getPool();
    const r = await pool.query(
      `UPDATE product_variants SET
         volume = COALESCE($2, volume),
         price = COALESCE($3, price),
         wholesale = COALESCE($4, wholesale),
         sku = COALESCE($5, sku),
         stock_qty = COALESCE($6, stock_qty),
         active = COALESCE($7, active)
       WHERE id = $1 RETURNING *`,
      [req.params.id, volume, price, wholesale, sku, stock_qty, active]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, variant: r.rows[0] });
  } catch (e) { console.error('[admin:patch-variant]', e); res.status(500).json({ error: 'internal' }); }
});

// приход товара (склад)
router.post('/variants/:id/stock', async (req, res) => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { qty, note } = req.body || {};
    const delta = parseInt(qty, 10);
    if (!delta) return res.status(400).json({ error: 'qty-required' });
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE product_variants SET stock_qty = COALESCE(stock_qty,0) + $1 WHERE id = $2 RETURNING *`,
      [delta, req.params.id]
    );
    if (r.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not-found' });
    }
    await client.query(
      `INSERT INTO stock_movements (variant_id, delta, reason, notes)
       VALUES ($1,$2,$3,$4)`,
      [req.params.id, delta, delta > 0 ? 'income' : 'writeoff', note || null]
    );
    await client.query('COMMIT');
    res.json({ ok: true, variant: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin:stock]', e); res.status(500).json({ error: 'internal', detail: e.message });
  } finally { client.release(); }
});

// ═══════════════════════════════════════════════════════
//   ЗАКАЗЫ
// ═══════════════════════════════════════════════════════

router.get('/orders', async (req, res) => {
  try {
    const pool = getPool();
    const { status, from, to, limit = 50, offset = 0 } = req.query;
    const cond = []; const args = [];
    if (status) { args.push(status); cond.push(`o.status = $${args.length}`); }
    if (from) { args.push(from); cond.push(`o.created_at >= $${args.length}`); }
    if (to) { args.push(to); cond.push(`o.created_at <= $${args.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    args.push(parseInt(limit, 10), parseInt(offset, 10));
    const r = await pool.query(
      `SELECT o.id, o.total, o.status, o.payment_method, o.delivery_type,
              o.created_at, c.phone, c.name AS client_name
       FROM orders o LEFT JOIN clients c ON c.id = o.client_id
       ${where}
       ORDER BY o.id DESC
       LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args
    );
    res.json({ ok: true, items: r.rows });
  } catch (e) { console.error('[admin:orders]', e); res.status(500).json({ error: 'internal' }); }
});

router.get('/orders/:id', async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const o = await pool.query(
      `SELECT o.*, c.phone, c.name AS client_name, c.email AS client_email
       FROM orders o LEFT JOIN clients c ON c.id = o.client_id WHERE o.id = $1`, [id]);
    if (o.rowCount === 0) return res.status(404).json({ error: 'not-found' });
    const items = await pool.query(`SELECT * FROM order_items WHERE order_id = $1 ORDER BY id`, [id]);
    res.json({ ok: true, order: { ...o.rows[0], items: items.rows } });
  } catch (e) { console.error('[admin:order-get]', e); res.status(500).json({ error: 'internal' }); }
});

const ORDER_STATUSES = ['new','paid','packing','shipped','delivered','cancelled','refunded'];
router.patch('/orders/:id/status', async (req, res) => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { status } = req.body || {};
    if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'bad-status' });
    const orderId = parseInt(req.params.id, 10);

    await client.query('BEGIN');

    // текущий статус
    const cur = await client.query(`SELECT status, client_id, total FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    if (cur.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not-found' });
    }
    const prevStatus = cur.rows[0].status;

    // переход new → paid: списываем со склада и снимаем резерв
    if (prevStatus === 'new' && status === 'paid') {
      const items = await client.query(`SELECT variant_id, qty FROM order_items WHERE order_id = $1`, [orderId]);
      for (const it of items.rows) {
        await client.query(
          `UPDATE product_variants SET
             stock_qty = GREATEST(0, COALESCE(stock_qty,0) - $1),
             reserved_qty = GREATEST(0, COALESCE(reserved_qty,0) - $1)
           WHERE id = $2`,
          [it.qty, it.variant_id]
        );
        await client.query(
          `INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes)
           VALUES ($1, $2, 'sale', $3, $4)`,
          [it.variant_id, -it.qty, String(orderId), `Замовлення #${orderId}`]
        );
      }
      // бонусы лояльности 3% от суммы → клиенту
      await client.query(
        `UPDATE clients SET
           loyalty_points = COALESCE(loyalty_points,0) + FLOOR($2 * 0.03)::int,
           total_spent = COALESCE(total_spent,0) + $2,
           last_visit_at = NOW()
         WHERE id = $1`,
        [cur.rows[0].client_id, cur.rows[0].total]
      );
      await client.query(
        `INSERT INTO loyalty_ledger (client_id, delta, reason, ref_id)
         VALUES ($1, FLOOR($2 * 0.03)::int, 'order-paid', $3)`,
        [cur.rows[0].client_id, cur.rows[0].total, String(orderId)]
      );
      // авто-приход в открытую кассовую смену (если есть)
      try {
        const sh = await client.query(`SELECT id FROM cash_shifts WHERE status='open' ORDER BY opened_at DESC LIMIT 1`);
        if (sh.rows[0]) {
          await client.query(
            `INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, ref_id, description)
             VALUES ($1,'in','sale_product',$2,'card','order',$3,$4)`,
            [sh.rows[0].id, cur.rows[0].total, orderId, `Замовлення #${orderId}`]
          );
        }
      } catch (e) { console.warn('[cashbox-auto]', e.message); }
    }

    // переход paid → refunded: возвращаем товар, отзываем бонусы
    if (prevStatus === 'paid' && status === 'refunded') {
      const items = await client.query(`SELECT variant_id, qty FROM order_items WHERE order_id = $1`, [orderId]);
      for (const it of items.rows) {
        await client.query(
          `UPDATE product_variants SET stock_qty = COALESCE(stock_qty,0) + $1 WHERE id = $2`,
          [it.qty, it.variant_id]
        );
        await client.query(
          `INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes)
           VALUES ($1, $2, 'refund', $3, $4)`,
          [it.variant_id, it.qty, String(orderId), `Повернення замовлення #${orderId}`]
        );
      }
      await client.query(
        `UPDATE clients SET
           loyalty_points = GREATEST(0, COALESCE(loyalty_points,0) - FLOOR($2 * 0.03)::int),
           total_spent = GREATEST(0, COALESCE(total_spent,0) - $2)
         WHERE id = $1`,
        [cur.rows[0].client_id, cur.rows[0].total]
      );
      // авто-расход (возврат денег) в открытую смену
      try {
        const sh = await client.query(`SELECT id FROM cash_shifts WHERE status='open' ORDER BY opened_at DESC LIMIT 1`);
        if (sh.rows[0]) {
          await client.query(
            `INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, ref_id, description)
             VALUES ($1,'out','refund',$2,'card','order',$3,$4)`,
            [sh.rows[0].id, cur.rows[0].total, orderId, `Повернення замовлення #${orderId}`]
          );
        }
      } catch (e) { console.warn('[cashbox-auto-refund]', e.message); }
    }

    const r = await client.query(
      `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, orderId]
    );
    await client.query('COMMIT');

    // фоновое уведомление клиенту — не блокирует ответ
    notifyOrderStatus(orderId, status).catch(e => console.error('[notify-bg]', e.message));

    res.json({ ok: true, order: r.rows[0], side_effects: { stock_updated: prevStatus === 'new' && status === 'paid' } });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin:order-status]', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  } finally { client.release(); }
});

// ═══════════════════════════════════════════════════════
//   КЛИЕНТЫ
// ═══════════════════════════════════════════════════════

router.get('/clients', async (req, res) => {
  try {
    const pool = getPool();
    const { search, limit = 50, offset = 0 } = req.query;
    const cond = []; const args = [];
    if (search) {
      args.push(`%${search}%`); args.push(`%${search}%`);
      cond.push(`(c.phone ILIKE $${args.length - 1} OR c.name ILIKE $${args.length})`);
    }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    args.push(parseInt(limit, 10), parseInt(offset, 10));
    const r = await pool.query(
      `SELECT c.id, c.phone, c.name, c.email, c.loyalty_points, c.total_spent,
              c.created_at, c.last_visit_at,
              (SELECT COUNT(*) FROM orders WHERE client_id = c.id) AS orders_count
       FROM clients c
       ${where}
       ORDER BY c.id DESC
       LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args
    );
    res.json({ ok: true, items: r.rows });
  } catch (e) { console.error('[admin:clients]', e); res.status(500).json({ error: 'internal' }); }
});

router.get('/clients/:id', async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const c = await pool.query(`SELECT * FROM clients WHERE id = $1`, [id]);
    if (c.rowCount === 0) return res.status(404).json({ error: 'not-found' });
    const orders = await pool.query(
      `SELECT id, total, status, created_at FROM orders WHERE client_id = $1 ORDER BY id DESC`,
      [id]
    );
    res.json({ ok: true, client: { ...c.rows[0], orders: orders.rows } });
  } catch (e) { console.error('[admin:client]', e); res.status(500).json({ error: 'internal' }); }
});

// ═══════════════════════════════════════════════════════
//   АНАЛИТИКА
// ═══════════════════════════════════════════════════════

router.get('/stats', async (req, res) => {
  try {
    const pool = getPool();
    const [r1, r2, r3, r4] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total, COALESCE(SUM(total),0)::float AS revenue
                  FROM orders WHERE status IN ('paid','packing','shipped','delivered')`),
      pool.query(`SELECT COUNT(*)::int AS pending FROM orders WHERE status = 'new'`),
      pool.query(`SELECT COUNT(*)::int AS clients FROM clients`),
      pool.query(`SELECT COUNT(*)::int AS products FROM products WHERE active = true`),
    ]);
    res.json({
      ok: true,
      stats: {
        revenue: r1.rows[0].revenue,
        orders_completed: r1.rows[0].total,
        orders_pending: r2.rows[0].pending,
        clients: r3.rows[0].clients,
        products_active: r4.rows[0].products,
      },
    });
  } catch (e) { console.error('[admin:stats]', e); res.status(500).json({ error: 'internal' }); }
});

router.get('/stats/top-products', async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(
      `SELECT oi.product_name, SUM(oi.qty)::int AS qty,
              SUM(oi.line_total)::float AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status IN ('paid','packing','shipped','delivered')
       GROUP BY oi.product_name
       ORDER BY revenue DESC
       LIMIT 20`
    );
    res.json({ ok: true, items: r.rows });
  } catch (e) { console.error('[admin:top]', e); res.status(500).json({ error: 'internal' }); }
});

router.get('/stats/revenue-by-day', async (req, res) => {
  try {
    const pool = getPool();
    const days = Math.min(parseInt(req.query.days || '14', 10), 90);
    const r = await pool.query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS orders,
              COALESCE(SUM(total),0)::float AS revenue
       FROM orders
       WHERE created_at >= NOW() - ($1 || ' days')::interval
         AND status IN ('paid','packing','shipped','delivered')
       GROUP BY 1
       ORDER BY 1 ASC`,
      [String(days)]
    );
    res.json({ ok: true, days, items: r.rows });
  } catch (e) { console.error('[admin:rev-day]', e); res.status(500).json({ error: 'internal' }); }
});

router.get('/stats/low-stock', async (req, res) => {
  try {
    const pool = getPool();
    const threshold = parseInt(req.query.threshold || '5', 10);
    const r = await pool.query(
      `SELECT pv.id, pv.volume, pv.stock_qty, pv.reserved_qty,
              p.name AS product_name, p.id AS product_id
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE pv.active = true AND COALESCE(pv.stock_qty,0) <= $1
       ORDER BY pv.stock_qty ASC NULLS FIRST
       LIMIT 100`,
      [threshold]
    );
    res.json({ ok: true, threshold, items: r.rows });
  } catch (e) { console.error('[admin:low]', e); res.status(500).json({ error: 'internal' }); }
});

module.exports = router;
