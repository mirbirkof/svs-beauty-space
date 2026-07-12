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
const { getPool, applyTenant } = require('../db-pg');
const { notifyOrderStatus } = require('./telegram-notify');
const { requirePerm, logAction, hasPermission } = require('../lib/rbac');
const { normalizePhoneDb } = require('../lib/phone');
const { findDuplicateClients, mergeClients } = require('../lib/client-merge');

// ── middleware: RBAC проверка (legacy X-Admin-Token поддерживается автоматически) ──
router.use(requirePerm('admin.*'));

// «Склад і ціни»: установка цен и правка остатков — только с правом stock.manage.
// У owner оно есть через '*', администратору включается тумблером в «Керуванні доступом».
function canManageStock(req) { return hasPermission(req.user && req.user.permissions, 'stock.manage'); }
const STOCK_MANAGE_403 = { error: 'forbidden', need: 'stock.manage', message: 'Немає права «Склад і ціни» — власник може увімкнути його в «Керуванні доступом»' };

// ═══════════════════════════════════════════════════════
//   ТОВАРЫ И ВАРИАНТЫ
// ═══════════════════════════════════════════════════════

router.get('/products', async (req, res) => {
  try {
    const pool = getPool();
    const { search, brand, category, active, limit, offset = 0 } = req.query;
    const cond = [];
    const args = [];
    if (search) { args.push(`%${search}%`); cond.push(`p.name ILIKE $${args.length}`); }
    if (brand) { args.push(brand); cond.push(`p.brand_id = $${args.length}`); }
    if (category) { args.push(category); cond.push(`p.category_id = $${args.length}`); }
    if (active != null) { args.push(active === 'true'); cond.push(`p.active = $${args.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    // Ліміт: за замовчуванням показуємо ВСЕ (без обрізки на 50/100), клемп до 5000 як запобіжник.
    const lim = Math.min(Math.max(parseInt(limit, 10) || 5000, 1), 5000);
    args.push(lim, parseInt(offset, 10) || 0);
    const r = await pool.query(
      `SELECT p.id, p.name, p.brand_id, p.category_id, p.active, p.featured, p.price_per_gram, p.cost_per_gram,
              (SELECT COUNT(*) FROM product_variants WHERE product_id = p.id) AS variants_count,
              (SELECT SUM(stock_qty) FROM product_variants WHERE product_id = p.id) AS total_stock,
              (SELECT MIN(price) FROM product_variants WHERE product_id = p.id) AS price_from
       FROM products p
       ${where}
       ORDER BY LOWER(p.name) ASC
       LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args
    );
    const total = (await pool.query(`SELECT COUNT(*)::int n FROM products p ${where}`, args.slice(0, -2))).rows[0].n;
    res.json({ ok: true, items: r.rows, total });
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
  } catch (e) { console.error('[admin:create-product]', e); res.status(500).json({ error: 'internal', ...(process.env.NODE_ENV !== "production" && { detail: e.message }) }); }
});

// Профіль товару: повна картка + всі варіанти одним запитом
router.get('/products/:id', async (req, res) => {
  try {
    const pool = getPool();
    const p = await pool.query(`SELECT * FROM products WHERE id = $1`, [req.params.id]);
    if (!p.rows[0]) return res.status(404).json({ error: 'not-found' });
    const v = await pool.query(
      `SELECT id, volume, price, wholesale, sku, stock_qty, unit_ml, active
         FROM product_variants WHERE product_id = $1 ORDER BY id`, [req.params.id]);
    res.json({ ok: true, product: p.rows[0], variants: v.rows });
  } catch (e) { console.error('[admin:get-product]', e); res.status(500).json({ error: 'internal' }); }
});

router.patch('/products/:id', async (req, res) => {
  try {
    const { name, brand_id, category_id, photo, description, featured, active, meta_title, meta_description, attrs, price_per_gram, cost_per_gram } = req.body || {};
    if (attrs !== undefined && (typeof attrs !== 'object' || Array.isArray(attrs) || attrs === null))
      return res.status(400).json({ error: 'attrs-must-be-object' });
    if ((price_per_gram !== undefined || cost_per_gram !== undefined) && !canManageStock(req)) return res.status(403).json(STOCK_MANAGE_403);
    // price_per_gram: число > 0 — встановити; 0/'' — прибрати (NULL); undefined — не чіпати
    let ppg; // undefined = не чіпати
    if (price_per_gram !== undefined) {
      const n = Number(price_per_gram);
      ppg = (Number.isFinite(n) && n > 0) ? n : null;
    }
    // cost_per_gram (собівартість за грам): та ж логіка
    let cpg;
    if (cost_per_gram !== undefined) {
      const n = Number(cost_per_gram);
      cpg = (Number.isFinite(n) && n > 0) ? n : null;
    }
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
         meta_title = COALESCE($9, meta_title),
         meta_description = COALESCE($10, meta_description),
         attrs = COALESCE($11::jsonb, attrs),
         price_per_gram = CASE WHEN $12::text IS NULL THEN price_per_gram ELSE NULLIF($12::text,'null')::numeric END,
         cost_per_gram = CASE WHEN $13::text IS NULL THEN cost_per_gram ELSE NULLIF($13::text,'null')::numeric END,
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, name, brand_id, category_id, photo, description, featured, active,
       meta_title, meta_description, attrs === undefined ? null : JSON.stringify(attrs),
       price_per_gram === undefined ? null : (ppg === null ? 'null' : String(ppg)),
       cost_per_gram === undefined ? null : (cpg === null ? 'null' : String(cpg))]
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

// Список вариантов товара (для выбора в форме закупки, аудит #10)
router.get('/products/:id/variants', async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(
      `SELECT id, volume, price, wholesale, sku, stock_qty, unit_ml, active
         FROM product_variants WHERE product_id = $1 ORDER BY id`,
      [req.params.id]
    );
    res.json({ items: r.rows, count: r.rowCount });
  } catch (e) { console.error('[admin:get-variants]', e); res.status(500).json({ error: 'internal' }); }
});

router.post('/products/:id/variants', async (req, res) => {
  try {
    const { volume, price, wholesale, sku, stock_qty = 0, branch_id } = req.body || {};
    if (!volume || price == null) return res.status(400).json({ error: 'volume-price-required' });
    if (!canManageStock(req)) return res.status(403).json(STOCK_MANAGE_403);
    const pool = getPool();
    const r = await pool.query(
      `INSERT INTO product_variants (product_id, volume, price, wholesale, sku, stock_qty, active, branch_id)
       VALUES ($1,$2,$3,$4,$5,$6,true,
               COALESCE($7, (SELECT id FROM branches WHERE is_default = true LIMIT 1)))
       RETURNING *`,
      [req.params.id, volume, price, wholesale || price, sku, stock_qty, branch_id || null]
    );
    res.status(201).json({ ok: true, variant: r.rows[0] });
  } catch (e) { console.error('[admin:add-variant]', e); res.status(500).json({ error: 'internal', ...(process.env.NODE_ENV !== "production" && { detail: e.message }) }); }
});

router.patch('/variants/:id', async (req, res) => {
  try {
    const { volume, price, wholesale, sku, stock_qty, active, unit_ml } = req.body || {};
    if ((price !== undefined || wholesale !== undefined || stock_qty !== undefined || unit_ml !== undefined) && !canManageStock(req))
      return res.status(403).json(STOCK_MANAGE_403);
    const pool = getPool();
    const r = await pool.query(
      `UPDATE product_variants SET
         volume = COALESCE($2, volume),
         price = COALESCE($3, price),
         wholesale = COALESCE($4, wholesale),
         sku = COALESCE($5, sku),
         stock_qty = COALESCE($6, stock_qty),
         active = COALESCE($7, active),
         unit_ml = COALESCE($8, unit_ml)
       WHERE id = $1 RETURNING *`,
      [req.params.id, volume, price, wholesale, sku, stock_qty, active, unit_ml]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, variant: r.rows[0] });
  } catch (e) { console.error('[admin:patch-variant]', e); res.status(500).json({ error: 'internal' }); }
});

// приход товара (склад)
// Залишки на складі: плоский список варіантів з назвами, цінами і залишком
router.get('/stock/list', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const vals = [];
    let where = `pv.active IS NOT FALSE AND p.active IS NOT FALSE`;
    if (q) { vals.push('%' + q + '%'); where += ` AND (p.name ILIKE $1 OR pv.sku ILIKE $1 OR pv.volume ILIKE $1 OR (p.name || ' ' || pv.volume) ILIKE $1)`; }
    const r = await getPool().query(
      `SELECT pv.id, pv.product_id, p.name AS product_name, pv.volume, pv.sku,
              COALESCE(pv.stock_qty,0) AS stock_qty, pv.price, pv.wholesale,
              pv.unit_ml, p.price_per_gram
         FROM product_variants pv
         JOIN products p ON p.id = pv.product_id
        WHERE ${where}
        ORDER BY p.name, pv.volume LIMIT 400`, vals);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error('[admin:stock-list]', e); res.status(500).json({ error: 'internal' }); }
});

// Історія руху товару: останні рухи з назвами (прихід/списання/продаж/послуги)
router.get('/stock/movements', async (req, res) => {
  try {
    const lim = Math.min(Number(req.query.limit) || 40, 200);
    const vals = [lim];
    let where = '1=1';
    if (Number(req.query.variant_id) > 0) { vals.push(Number(req.query.variant_id)); where = 'sm.variant_id = $2'; }
    const r = await getPool().query(
      `SELECT sm.id, sm.variant_id, sm.delta, sm.reason, sm.notes, sm.created_at,
              p.name AS product_name, pv.volume
         FROM stock_movements sm
         LEFT JOIN product_variants pv ON pv.id = sm.variant_id
         LEFT JOIN products p ON p.id = pv.product_id
        WHERE ${where}
        ORDER BY sm.created_at DESC, sm.id DESC LIMIT $1`, vals);
    res.json({ items: r.rows });
  } catch (e) { console.error('[admin:stock-movements]', e); res.status(500).json({ error: 'internal' }); }
});

router.post('/variants/:id/stock', async (req, res) => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { qty, note } = req.body || {};
    if (!canManageStock(req)) return res.status(403).json(STOCK_MANAGE_403);
    // #109: склад у грамах — дробові кількості дозволені (parseInt різав "45.5")
    const delta = Number(qty);
    if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: 'qty-required' });
    await client.query('BEGIN'); await applyTenant(client);
    // списання не заганяє залишок у мінус (помилковий ввід -1000 замість +1000)
    const r = await client.query(
      `UPDATE product_variants SET stock_qty = GREATEST(0, COALESCE(stock_qty,0) + $1) WHERE id = $2 RETURNING *`,
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
    console.error('[admin:stock]', e); res.status(500).json({ error: 'internal', ...(process.env.NODE_ENV !== "production" && { detail: e.message }) });
  } finally { client.release(); }
});

// ═══════════════════════════════════════════════════════
//   ЗАКАЗЫ
// ═══════════════════════════════════════════════════════

router.get('/orders', async (req, res) => {
  try {
    const pool = getPool();
    const { status, from, to, limit = 50, offset = 0 } = req.query;
    // потолок limit: без него ?limit=999999 выкачивает всю таблицу одним запросом (аудит v7)
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const cond = []; const args = [];
    if (status) { args.push(status); cond.push(`o.status = $${args.length}`); }
    if (from) { args.push(from); cond.push(`o.created_at >= $${args.length}`); }
    if (to) { args.push(to); cond.push(`o.created_at <= $${args.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    args.push(lim, Math.max(parseInt(offset, 10) || 0, 0));
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

    await client.query('BEGIN'); await applyTenant(client);

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
      // Аудит v6: слепые -3% без записи в loyalty_ledger — баланс в кабинете клиента
      // не менялся, а при Mono-оплате (бонусы не начислялись) снимались чужие баллы.
      // Эталон orders.js: отзываем РОВНО начисленное по ledger + компенсирующая запись.
      const accr = await client.query(
        `SELECT COALESCE(SUM(delta),0)::int AS pts FROM loyalty_ledger
          WHERE ref_id = $1 AND reason = 'order-paid'`, [String(orderId)]);
      const pts = accr.rows[0].pts;
      if (cur.rows[0].client_id) {
        await client.query(
          `UPDATE clients SET
             loyalty_points = GREATEST(0, COALESCE(loyalty_points,0) - $2),
             total_spent = GREATEST(0, COALESCE(total_spent,0) - $3)
           WHERE id = $1`,
          [cur.rows[0].client_id, Math.max(0, pts), cur.rows[0].total]
        );
        if (pts > 0) {
          await client.query(
            `INSERT INTO loyalty_ledger (client_id, delta, reason, ref_id)
             VALUES ($1, $2, 'order-refund', $3)`,
            [cur.rows[0].client_id, -pts, String(orderId)]
          );
        }
      }
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

    // FIN-01: авто-нарахування бонусів за оплачене замовлення (no-op якщо правило не налаштоване).
    // Фоном після коміту, у HTTP tenant-контексті (ALS) — accrue сам відкриє свою транзакцію.
    if (prevStatus === 'new' && status === 'paid' && cur.rows[0].client_id) {
      require('../lib/bonus').accrue({
        clientId: cur.rows[0].client_id, checkAmount: cur.rows[0].total, autoRule: true,
        triggerEvent: 'payment', category: 'products', sourceType: 'order', sourceId: orderId,
        description: `Замовлення #${orderId}`,
      }).catch(e => console.error('[bonus-accrue-bg]', e.message));
    }

    res.json({ ok: true, order: r.rows[0], side_effects: { stock_updated: prevStatus === 'new' && status === 'paid' } });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin:order-status]', e);
    res.status(500).json({ error: 'internal', ...(process.env.NODE_ENV !== "production" && { detail: e.message }) });
  } finally { client.release(); }
});

// ═══════════════════════════════════════════════════════
//   КЛИЕНТЫ
// ═══════════════════════════════════════════════════════

// ── GET /api/admin/clients/duplicates — кандидаты на слияние (дубли) ──
// ВАЖНО: объявлено ДО '/clients/:id', иначе :id перехватит 'duplicates'.
router.get('/clients/duplicates', async (req, res) => {
  try {
    const pool = getPool();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const groups = await findDuplicateClients(pool, { limit });
    res.json({ ok: true, groups, count: groups.length });
  } catch (e) { console.error('[admin:client:duplicates]', e); res.status(500).json({ error: 'internal' }); }
});

// ── POST /api/admin/clients — создать клиента вручную (кнопка «Добавить клиента») ──
// Раньше клиента можно было завести только CSV-импортом или неявно при записи (пробел, найден 02.07).
router.post('/clients',
  require('../lib/plan-limits').enforcePlanLimit('max_clients',
    "SELECT COUNT(*)::int AS n FROM clients WHERE deleted_at IS NULL"),
  async (req, res) => {
  try {
    const pool = getPool();
    const { name, phone, email } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Ім’я обов’язкове' });
    if (!phone || !String(phone).trim()) return res.status(400).json({ error: 'Телефон обов’язковий' });
    const normPhone = normalizePhoneDb(phone);
    if (!normPhone) return res.status(400).json({ error: 'Невірний формат телефону' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim()))
      return res.status(400).json({ error: 'Невірний email' });
    // защита от дубля по телефону
    const dup = await pool.query('SELECT id, name FROM clients WHERE phone = $1 AND deleted_at IS NULL LIMIT 1', [normPhone]);
    if (dup.rowCount) return res.status(409).json({ error: 'Клієнт з таким телефоном вже існує', existing_id: dup.rows[0].id });
    const r = await pool.query(
      `INSERT INTO clients (name, phone, email, created_at, consent_given_at, consent_source)
       VALUES ($1, $2, $3, NOW(), NOW(), 'admin')
       RETURNING id, name, phone, email`,
      [String(name).trim(), normPhone, email ? String(email).trim() : null]);
    logAction({ user: req.user, action: 'client.create', entity: 'client', entity_id: r.rows[0].id, ip: req.ip }).catch(() => {});
    res.status(201).json({ ok: true, client: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Клієнт з таким телефоном вже існує' });
    console.error('[admin:create-client]', e); res.status(500).json({ error: 'internal' });
  }
});

router.get('/clients', async (req, res) => {
  try {
    const pool = getPool();
    const { search, limit = 50, offset = 0, tag_id } = req.query;
    // потолок limit: защита PII от выкачки всей базы клиентов одним запросом (аудит v7)
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const cond = ['c.deleted_at IS NULL']; const args = [];
    if (search) {
      args.push(`%${search}%`); args.push(`%${search}%`);
      cond.push(`(c.phone ILIKE $${args.length - 1} OR c.name ILIKE $${args.length})`);
    }
    if (tag_id) {
      args.push(parseInt(tag_id, 10));
      cond.push(`EXISTS (SELECT 1 FROM client_tags ct WHERE ct.client_id = c.id AND ct.tag_id = $${args.length})`);
    }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const cnt = await pool.query(`SELECT COUNT(*)::int AS total FROM clients c ${where}`, args.slice());
    args.push(lim, Math.max(parseInt(offset, 10) || 0, 0));
    const r = await pool.query(
      `SELECT c.id, c.phone, c.name, c.email, c.loyalty_points,
              c.created_at, c.last_visit_at, c.first_visit_at,
              -- Витрачено/візити — еталонні цифри з BeautyPro/букона (синхронізовані по телефону)
              -- + живі візити після вигрузки. Не рахуємо з appointments (там стара склейка по імені).
              COALESCE(c.total_spent, 0) AS total_spent,
              COALESCE(c.total_visits, 0) AS visits_count,
              (SELECT COUNT(*) FROM orders WHERE client_id = c.id) AS orders_count,
              COALESCE((SELECT json_agg(json_build_object('id',d.id,'name',d.name,'color',d.color) ORDER BY d.sort_order)
                          FROM client_tags ct JOIN client_tag_defs d ON d.id = ct.tag_id
                         WHERE ct.client_id = c.id), '[]'::json) AS tags
       FROM clients c
       ${where}
       ORDER BY c.last_visit_at DESC NULLS LAST, c.total_spent DESC NULLS LAST, c.id DESC
       LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args
    );
    res.json({ ok: true, items: r.rows, total: cnt.rows[0].total,
               limit: lim, offset: parseInt(offset, 10) || 0 });
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
    // Візити салону (записи BeautyPro/CRM)
    const appts = await pool.query(
      `SELECT a.id, a.starts_at, a.status, a.price, a.services_text, a.payment_method,
              m.name AS master_name
         FROM appointments a
         LEFT JOIN masters m ON m.id = a.master_id
        WHERE a.client_id = $1
        ORDER BY a.starts_at DESC NULLS LAST
        LIMIT 200`,
      [id]
    );
    // Покупки товарів у салоні (BeautyPro /sales type=Product)
    let productSales = [];
    try {
      const ps = await pool.query(
        `SELECT id, sale_date, product_name, qty, total_price, master_name
           FROM salon_product_sales
          WHERE client_id = $1
          ORDER BY sale_date DESC NULLS LAST
          LIMIT 200`,
        [id]
      );
      productSales = ps.rows;
    } catch (_) { /* міграція 037 ще не застосована */ }
    // Теги клієнта (CRM-03)
    const tagsRows = await pool.query(
      `SELECT d.id, d.name, d.color FROM client_tags ct
         JOIN client_tag_defs d ON d.id = ct.tag_id
        WHERE ct.client_id = $1 ORDER BY d.sort_order, LOWER(d.name)`, [id]);
    const visits = appts.rows;
    const doneVisits = visits.filter(v => v.status === 'done');
    const productsSpent = productSales.reduce((s, p) => s + Number(p.total_price || 0), 0);
    const stats = {
      visits_total: visits.length,
      visits_done: doneVisits.length,
      visits_spent: doneVisits.reduce((s, v) => s + Number(v.price || 0), 0),
      products_count: productSales.length,
      products_spent: productsSpent,
      orders_count: orders.rowCount,
      orders_spent: orders.rows.filter(o => ['paid','packing','shipped','delivered'].includes(o.status))
                                .reduce((s, o) => s + Number(o.total || 0), 0),
      last_visit_at: visits[0] ? visits[0].starts_at : (c.rows[0].last_visit_at || null),
    };
    // Major #20: audit trail доступу до ПД — читання повної картки клієнта (ПІБ/телефон/
    // email/візити) логуємо, як і мутації. GDPR Art.30: доступ до ПД має бути підзвітним.
    logAction({ user: req.user, action: 'client.view', entity: 'client', entity_id: id, ip: req.ip }).catch(() => {});
    res.json({ ok: true, client: { ...c.rows[0], orders: orders.rows, visits, product_sales: productSales, stats, tags: tagsRows.rows } });
  } catch (e) { console.error('[admin:client]', e); res.status(500).json({ error: 'internal' }); }
});

// ── PATCH /api/admin/clients/:id — редактирование карточки клиента ──
// Body: { name, phone, email, birthday (YYYY-MM-DD|null), notes }
router.patch('/clients/:id', async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const allowed = ['name', 'phone', 'email', 'birthday', 'notes', 'prepayment_required'];
    // старое состояние — для истории изменений (CRM-03)
    const before = (await pool.query(`SELECT * FROM clients WHERE id = $1`, [id])).rows[0];
    if (!before) return res.status(404).json({ error: 'not-found' });
    const sets = [], vals = [];
    for (const f of allowed) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
        let v = req.body[f];
        if (f === 'birthday' && (v === '' || v == null)) v = null;
        if (f === 'phone') v = normalizePhoneDb(v); // канон 380... — без второго формата (аудит #31)
        if (f === 'prepayment_required') v = (v === true || v === 'true' || v === 1); // нормалізуємо в boolean
        vals.push(v); sets.push(`${f} = $${vals.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'no fields' });
    vals.push(id);
    const r = await pool.query(
      `UPDATE clients SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not-found' });
    // diff изменённых полей → audit_log
    const norm = (v) => v == null ? null : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
    const changes = {};
    for (const f of allowed) {
      if (!Object.prototype.hasOwnProperty.call(req.body, f)) continue;
      const from = norm(before[f]), to = norm(r.rows[0][f]);
      if (from !== to) changes[f] = { from, to };
    }
    if (Object.keys(changes).length) {
      logAction({ user: req.user, action: 'client.update', entity: 'client', entity_id: id,
        ip: req.ip, meta: { changes } });
    }
    res.json({ ok: true, client: r.rows[0] });
  } catch (e) { console.error('[admin:client:patch]', e); res.status(500).json({ error: 'internal' }); }
});

// ── DELETE /api/admin/clients/:id — архивация клиента (soft-delete) ──
// Зв'язки/історія/витрати збережені. Прибирає з активних списків, дані не стираються.
router.delete('/clients/:id', async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const r = await pool.query(
      `UPDATE clients SET deleted_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL RETURNING id, name, phone`, [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not-found' });
    logAction({ user: req.user, action: 'client.archive', entity: 'client', entity_id: id,
      ip: req.ip, meta: { name: r.rows[0].name, phone: r.rows[0].phone } });
    res.json({ ok: true, archived: id });
  } catch (e) { console.error('[admin:client:archive]', e); res.status(500).json({ error: 'internal' }); }
});

// ── POST /api/admin/clients/:id/erase — GDPR «право на забуття» (Art. 17) ──
// РЕАЛЬНЕ стирання ПД: знеособлюємо клієнта (ПІБ/телефон/email/telegram/дата народження)
// і видаляємо чисті ПД (нотатки, вподобання, медкартку). Знеособлені фінансові/візитні
// записи ЛИШАЮТЬСЯ (податкове зберігання) — але вже без прив'язки до особи.
router.post('/clients/:id/erase', async (req, res) => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad-id' });
    await client.query('BEGIN'); await applyTenant(client);
    // Раунд3: захоплюємо старий телефон ДО зануління — деякі таблиці ключовані по client_phone.
    const _oldPhone = (await client.query('SELECT phone FROM clients WHERE id=$1', [id])).rows[0]?.phone || null;
    const r = await client.query(
      `UPDATE clients SET
         name = 'Видалений клієнт', phone = NULL, email = NULL,
         phone_enc = NULL, phone_bidx = NULL,
         telegram_id = NULL, tg_first_name = NULL, tg_last_name = NULL, tg_username = NULL,
         birthday = NULL, notes = NULL, deleted_at = COALESCE(deleted_at, NOW()), updated_at = NOW()
       WHERE id = $1 RETURNING id`, [id]);
    if (!r.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not-found' }); }
    // чисті ПД — фізичне видалення (в т.ч. медичні: алергії, формули, згоди, журнал доступу)
    for (const t of ['client_notes', 'client_preferences', 'medical_cards',
                     'allergy_tests', 'coloring_formulas', 'procedure_consents', 'medical_access_log']) {
      await client.query(`DELETE FROM ${t} WHERE client_id = $1`, [id]).catch(() => {});
    }
    // Журнали подій/аудиту зберігаємо (цілісність), але знеособлюємо PII в payload/meta
    // саме цього клієнта — інакше ПІБ/телефон відновлюються з payload за незмінним id.
    await client.query(
      `UPDATE domain_events SET payload = '{"redacted":"gdpr-erase"}'::jsonb
        WHERE entity_type = 'client' AND entity_id = $1::text`, [String(id)]).catch(() => {});
    await client.query(
      `UPDATE audit_log SET meta = '{"redacted":"gdpr-erase"}'::jsonb
        WHERE entity = 'client' AND entity_id = $1`, [id]).catch(() => {});
    // Major #6/#7 (верифікація): решта таблиць з телефоном клієнта — знеособлюємо PII
    // (записи лишаємо як історію/фінанси, але телефон/ім'я/telegram стираємо).
    await client.query(`UPDATE online_bookings  SET client_phone=NULL, client_name='Видалений', telegram_id=NULL WHERE client_id=$1`, [id]).catch(() => {});
    await client.query(`UPDATE waitlist          SET client_phone=NULL, client_name='Видалений', telegram_id=NULL WHERE client_id=$1`, [id]).catch(() => {});
    await client.query(`UPDATE callback_requests SET phone=NULL, name='Видалений' WHERE client_id=$1`, [id]).catch(() => {});
    await client.query(`UPDATE meta_leads        SET phone=NULL, client_name='Видалений', email=NULL WHERE client_id=$1`, [id]).catch(() => {});
    await client.query(`UPDATE review_request_log SET client_phone=NULL WHERE client_id=$1`, [id]).catch(() => {});
    await client.query(`UPDATE ai_call_recordings SET client_phone=NULL WHERE client_id=$1`, [id]).catch(() => {});
    await client.query(`UPDATE reviews           SET client_phone=NULL WHERE client_id=$1`, [id]).catch(() => {});
    await client.query(`UPDATE favorites         SET client_phone=NULL WHERE client_id=$1`, [id]).catch(() => {});
    // Раунд2: ще дві PII-колонки — ім'я клієнта в записах і підпис у фото-згодах.
    await client.query(`UPDATE appointments      SET client_name='Видалений' WHERE client_id=$1`, [id]).catch(() => {});
    await client.query(`UPDATE photo_consents    SET signed_by_name='Видалений' WHERE client_id=$1`, [id]).catch(() => {});
    // Раунд3: phone-keyed таблиці (без client_id) — чистимо за старим телефоном.
    if (_oldPhone) {
      await client.query(`UPDATE birthday_bonuses SET client_phone=NULL WHERE client_phone=$1`, [_oldPhone]).catch(() => {});
      await client.query(`UPDATE client_loyalty   SET client_phone=NULL WHERE client_phone=$1`, [_oldPhone]).catch(() => {});
    }
    await client.query('COMMIT');
    logAction({ user: req.user, action: 'client.gdpr_erase', entity: 'client', entity_id: id, ip: req.ip, meta: { legal: 'GDPR Art.17' } });
    res.json({ ok: true, erased: id, note: 'ПД знеособлено, фінансова історія збережена обезличеною' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin:client:erase]', e); res.status(500).json({ error: 'internal' });
  } finally { client.release(); }
});

// ── POST /api/admin/clients/:id/restore — вернуть из архива ──
router.post('/clients/:id/restore', async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const r = await pool.query(
      `UPDATE clients SET deleted_at = NULL, updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id`, [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not-found' });
    logAction({ user: req.user, action: 'client.restore', entity: 'client', entity_id: id, ip: req.ip });
    res.json({ ok: true, restored: id });
  } catch (e) { console.error('[admin:client:restore]', e); res.status(500).json({ error: 'internal' }); }
});

// ── POST /api/admin/clients/:id/merge — слить дубль в этого клиента ──
// body: { duplicate_id }. :id — основной (остаётся), duplicate_id — архивируется.
// Вся история (записи, заказы, баллы, абонементы) переносится на основного.
router.post('/clients/:id/merge', async (req, res) => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const primaryId = parseInt(req.params.id, 10);
    const dupId = parseInt(req.body && req.body.duplicate_id, 10);
    if (!primaryId || !dupId) return res.status(400).json({ error: 'bad-request', message: 'нужны id и duplicate_id' });
    if (primaryId === dupId) return res.status(400).json({ error: 'same-client' });
    await client.query('BEGIN'); await applyTenant(client);
    const result = await mergeClients(client, primaryId, dupId);
    await client.query('COMMIT');
    logAction({ user: req.user, action: 'client.merge', entity: 'client', entity_id: primaryId,
      ip: req.ip, meta: { duplicate_id: dupId, moved: result.moved, points_added: result.points_added } });
    res.json({ ok: true, ...result });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    const code = ['same-client','bad-ids'].includes(e.message) ? 400
               : e.message === 'not-found' ? 404 : 500;
    if (code === 500) console.error('[admin:client:merge]', e);
    res.status(code).json({ error: e.message || 'internal' });
  } finally { client.release(); }
});

// ── GET /api/admin/clients/:id/history — история изменений карточки (CRM-03) ──
router.get('/clients/:id/history', async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const r = await pool.query(
      `SELECT id, user_label, action, meta, created_at
         FROM audit_log
        WHERE entity = 'client' AND entity_id = $1
        ORDER BY created_at DESC LIMIT $2`, [id, limit]);
    res.json({ ok: true, items: r.rows, count: r.rowCount });
  } catch (e) { console.error('[admin:client:history]', e); res.status(500).json({ error: 'internal' }); }
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

// ═══════════════════════════════════════════════════════
//   СПРАВОЧНИКИ: brands, categories, masters, services, roles
// ═══════════════════════════════════════════════════════

// --- BRANDS ---
router.get('/brands', async (req, res) => {
  try {
    const r = await getPool().query('SELECT * FROM brands ORDER BY name');
    res.json({ ok: true, items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/brands', async (req, res) => {
  try {
    const { id, name, logo, about } = req.body || {};
    if (!id || !name) return res.status(400).json({ error: 'id and name required' });
    const r = await getPool().query(
      'INSERT INTO brands (id, name, logo, about) VALUES ($1,$2,$3,$4) RETURNING *',
      [id, name, logo || null, about || null]
    );
    res.status(201).json({ ok: true, brand: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.patch('/brands/:id', async (req, res) => {
  try {
    const { name, logo, about } = req.body || {};
    const r = await getPool().query(
      `UPDATE brands SET name=COALESCE($2,name), logo=COALESCE($3,logo), about=COALESCE($4,about) WHERE id=$1 RETURNING *`,
      [req.params.id, name, logo, about]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, brand: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/brands/:id', async (req, res) => {
  try {
    const r = await getPool().query('DELETE FROM brands WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, deleted: req.params.id });
  } catch (e) {
    if (e.code === '23503') return res.status(409).json({ error: 'has-linked-products' });
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

// --- CATEGORIES ---
router.get('/categories', async (req, res) => {
  try {
    const r = await getPool().query('SELECT * FROM categories ORDER BY group_name, name');
    res.json({ ok: true, items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/categories', async (req, res) => {
  try {
    const { id, name, icon, group_name } = req.body || {};
    if (!id || !name) return res.status(400).json({ error: 'id and name required' });
    const r = await getPool().query(
      'INSERT INTO categories (id, name, icon, group_name) VALUES ($1,$2,$3,$4) RETURNING *',
      [id, name, icon || null, group_name || null]
    );
    res.status(201).json({ ok: true, category: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.patch('/categories/:id', async (req, res) => {
  try {
    const { name, icon, group_name } = req.body || {};
    // commissionable: чи дає категорія товару % майстру з продажу (фарби/окисники=FALSE — розхідник).
    // Керується з UI (SaaS-аудит 06.07: раніше правилось лише міграцією). null → не змінюємо.
    const comm = (req.body && req.body.commissionable != null) ? !!req.body.commissionable : null;
    const r = await getPool().query(
      `UPDATE categories SET name=COALESCE($2,name), icon=COALESCE($3,icon), group_name=COALESCE($4,group_name),
              commissionable=COALESCE($5,commissionable) WHERE id=$1 RETURNING *`,
      [req.params.id, name, icon, group_name, comm]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, category: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/categories/:id', async (req, res) => {
  try {
    const r = await getPool().query('DELETE FROM categories WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, deleted: req.params.id });
  } catch (e) {
    if (e.code === '23503') return res.status(409).json({ error: 'has-linked-products' });
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

// --- MASTERS ---
router.get('/masters', async (req, res) => {
  try {
    const r = await getPool().query('SELECT * FROM masters ORDER BY name');
    res.json({ ok: true, items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/masters',
  require('../lib/plan-limits').enforcePlanLimit('max_employees',
    "SELECT COUNT(*)::int AS n FROM masters WHERE COALESCE(active,true)=true"),
  async (req, res) => {
  try {
    const { name, phone, specialty, bio, avatar, beautypro_id, commission_pct } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const r = await getPool().query(
      `INSERT INTO masters (name, phone, specialty, bio, avatar, beautypro_id, commission_pct, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
      [name, phone || null, specialty || null, bio || null, avatar || null, beautypro_id || null, commission_pct || null]
    );
    res.status(201).json({ ok: true, master: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.patch('/masters/:id', async (req, res) => {
  try {
    const { name, phone, specialty, bio, avatar, beautypro_id, commission_pct, active } = req.body || {};
    const r = await getPool().query(
      `UPDATE masters SET
         name=COALESCE($2,name), phone=COALESCE($3,phone), specialty=COALESCE($4,specialty),
         bio=COALESCE($5,bio), avatar=COALESCE($6,avatar), beautypro_id=COALESCE($7,beautypro_id),
         commission_pct=COALESCE($8,commission_pct), active=COALESCE($9,active)
       WHERE id=$1 RETURNING *`,
      [parseInt(req.params.id), name, phone, specialty, bio, avatar, beautypro_id, commission_pct, active]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, master: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/masters/:id', async (req, res) => {
  try {
    const r = await getPool().query(
      'UPDATE masters SET active=false WHERE id=$1 RETURNING id', [parseInt(req.params.id)]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, deactivated: r.rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// --- SERVICES ---
router.get('/services', async (req, res) => {
  try {
    const r = await getPool().query('SELECT * FROM services ORDER BY category, name');
    res.json({ ok: true, items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/services', async (req, res) => {
  try {
    const { name, category, duration_min, price, beautypro_id, description } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const r = await getPool().query(
      `INSERT INTO services (name, category, duration_min, price, beautypro_id, description, active)
       VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING *`,
      [name, category || null, duration_min || null, price || null, beautypro_id || null, description || null]
    );
    res.status(201).json({ ok: true, service: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.patch('/services/:id', async (req, res) => {
  try {
    const { name, category, duration_min, price, beautypro_id, description, active } = req.body || {};
    const r = await getPool().query(
      `UPDATE services SET
         name=COALESCE($2,name), category=COALESCE($3,category), duration_min=COALESCE($4,duration_min),
         price=COALESCE($5,price), beautypro_id=COALESCE($6,beautypro_id), description=COALESCE($7,description),
         active=COALESCE($8,active)
       WHERE id=$1 RETURNING *`,
      [parseInt(req.params.id), name, category, duration_min, price, beautypro_id, description, active]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, service: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/services/:id', async (req, res) => {
  try {
    const r = await getPool().query(
      'UPDATE services SET active=false WHERE id=$1 RETURNING id', [parseInt(req.params.id)]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, deactivated: r.rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// --- ROLES ---
router.get('/roles', async (req, res) => {
  try {
    const r = await getPool().query('SELECT * FROM roles ORDER BY level DESC, name');
    res.json({ ok: true, items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Защита от вертикальной эскалации: создание/изменение/удаление РОЛЕЙ (структуры прав)
// доступно только владельцу. Иначе admin (имеющий admin.*) мог бы выписать своей роли
// reports.finance / payroll.write / '*' и обойти все ограничения доступа.
function ownerOnlyRoles(req, res, next) {
  const u = req.user || {};
  if (u.role === 'owner' || (u.role_level || 0) >= 100) return next();
  return res.status(403).json({ error: 'owner-only', message: 'Керування ролями доступне лише власнику' });
}

router.post('/roles', ownerOnlyRoles, async (req, res) => {
  try {
    const { code, name, level, permissions } = req.body || {};
    if (!code || !name) return res.status(400).json({ error: 'code and name required' });
    const r = await getPool().query(
      `INSERT INTO roles (code, name, level, permissions) VALUES ($1,$2,$3,$4) RETURNING *`,
      [code, name, level || 0, JSON.stringify(permissions || [])]
    );
    res.status(201).json({ ok: true, role: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'code-already-exists' });
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

router.patch('/roles/:id', ownerOnlyRoles, async (req, res) => {
  try {
    const { code, name, level, permissions } = req.body || {};
    const r = await getPool().query(
      `UPDATE roles SET
         code=COALESCE($2,code), name=COALESCE($3,name), level=COALESCE($4,level),
         permissions=COALESCE($5,permissions)
       WHERE id=$1 RETURNING *`,
      [parseInt(req.params.id), code, name, level, permissions ? JSON.stringify(permissions) : null]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, role: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/roles/:id', ownerOnlyRoles, async (req, res) => {
  try {
    const r = await getPool().query('DELETE FROM roles WHERE id=$1 RETURNING id', [parseInt(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, deleted: r.rows[0].id });
  } catch (e) {
    if (e.code === '23503') return res.status(409).json({ error: 'has-linked-users' });
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

module.exports = router;
