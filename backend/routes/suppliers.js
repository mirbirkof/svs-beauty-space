/* ═══════════════════════════════════════════════════════
   SLS-05 — Поставщики (Suppliers). /api/suppliers
   Реєстр постачальників, контакти, каталог товарів,
   рейтинги, документи, порівняння цін.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const router = express.Router();
const pool = getPool();

const ERR = (e, res) => {
  console.error(e);
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
};

// Усі маршрути потребують авторизації
router.use(requirePerm());


// ══════════════════════════════════════════════════════════════
// 05.01 — РЕЄСТР ПОСТАЧАЛЬНИКІВ
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/suppliers
 * Список постачальників з фільтрацією та пошуком.
 * Query: ?status=active&search=&limit=50&offset=0
 * Spec: 05.01 — список, фільтрація (статус), пошук (назва, ІПН/ЄДРПОУ), пагінація.
 * Spec: 05.01 — швидкий перегляд: останній заказ, сума за період, рейтинг.
 */
router.get('/', requirePerm('supplier.read'), async (req, res) => {
  try {
    const { status, search, limit = 50, offset = 0 } = req.query;
    const cond = [];
    const args = [];

    if (status && ['active', 'paused', 'blocked'].includes(status)) {
      args.push(status);
      cond.push(`s.status = $${args.length}`);
    }
    if (search) {
      args.push(`%${search}%`);
      cond.push(`(s.name ILIKE $${args.length} OR s.legal_name ILIKE $${args.length} OR s.tax_id ILIKE $${args.length})`);
    }

    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    args.push(Math.min(parseInt(limit, 10) || 50, 200));
    args.push(parseInt(offset, 10) || 0);

    const r = await pool.query(
      `SELECT
         s.id, s.name, s.legal_name, s.tax_id, s.phone, s.email, s.website,
         s.status, s.rating, s.currency, s.payment_terms_days,
         s.min_order_amount, s.discount_percent, s.default_delivery,
         s.notes, s.created_at, s.updated_at,
         -- швидкий перегляд: останній заказ та загальна сума (з purchase_orders)
         (SELECT MAX(po.created_at) FROM purchase_orders po WHERE po.supplier_id = s.id)  AS last_order_at,
         (SELECT COALESCE(SUM(po.total_amount),0) FROM purchase_orders po
            WHERE po.supplier_id = s.id
              AND po.created_at >= NOW() - INTERVAL '365 days')                           AS amount_year,
         (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id)            AS total_orders
       FROM suppliers s
       ${where}
       ORDER BY s.name
       LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args
    );

    // загальна кількість для пагінації
    const countArgs = args.slice(0, args.length - 2);
    const countR = await pool.query(
      `SELECT COUNT(*) AS total FROM suppliers s ${where}`,
      countArgs
    );

    res.json({ ok: true, suppliers: r.rows, total: parseInt(countR.rows[0].total, 10) });
  } catch (e) { ERR(e, res); }
});


/**
 * GET /api/suppliers/compare
 * Порівняння постачальників по товару.
 * Query: ?product_id=UUID
 * Spec: 05.04 — порівняльна таблиця постачальників одного товару; рекомендація «кращий».
 * ВАЖЛИВО: цей маршрут має бути ВИЩЕ /:id, щоб не потрапити у параметр.
 */
router.get('/compare', requirePerm('supplier.read'), async (req, res) => {
  try {
    const { product_id } = req.query;
    if (!product_id) return res.status(400).json({ error: 'bad-request', message: 'product_id required' });

    const r = await pool.query(
      `SELECT
         s.id AS supplier_id, s.name AS supplier_name, s.status AS supplier_status,
         s.rating,
         sp.purchase_price, sp.delivery_days, sp.in_stock, sp.min_quantity,
         sp.supplier_sku, sp.last_price_update,
         p.name AS product_name, p.price AS retail_price,
         CASE WHEN p.price IS NOT NULL
              THEN ROUND((p.price - sp.purchase_price)::numeric, 2)
              ELSE NULL
         END AS margin
       FROM supplier_products sp
       JOIN suppliers s ON s.id = sp.supplier_id
       JOIN products  p ON p.id = sp.product_id
       WHERE sp.product_id = $1
       ORDER BY sp.purchase_price ASC, s.rating DESC`,
      [product_id]
    );

    // рекомендація: найдешевший з in_stock=true та найвищим рейтингом
    const available = r.rows.filter(row => row.in_stock);
    const best = available.length > 0 ? available[0] : (r.rows[0] || null);

    res.json({
      ok: true,
      product_id,
      comparisons: r.rows,
      best_supplier_id: best ? best.supplier_id : null
    });
  } catch (e) { ERR(e, res); }
});


// ══════════════════════════════════════════════════════════════
// 05.02 — КАРТКА ПОСТАЧАЛЬНИКА
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/suppliers/:id
 * Картка постачальника з контактами та статистикою.
 * Spec: 05.02 — повна картка; stats: total_orders, total_amount, avg_delivery_days, rating.
 */
router.get('/:id', requirePerm('supplier.read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad-id' });

    const [suppR, contactsR, statsR] = await Promise.all([
      pool.query(
        `SELECT * FROM suppliers WHERE id = $1`,
        [id]
      ),
      pool.query(
        `SELECT * FROM supplier_contacts WHERE supplier_id = $1 ORDER BY is_primary DESC, name`,
        [id]
      ),
      pool.query(
        `SELECT
           COUNT(*)::int                              AS total_orders,
           COALESCE(SUM(total_amount), 0)             AS total_amount,
           AVG(EXTRACT(EPOCH FROM (actual_delivery::timestamptz - created_at)) / 86400)
                                                      AS avg_delivery_days,
           MAX(created_at)                            AS last_order_at
         FROM purchase_orders
         WHERE supplier_id = $1`,
        [id]
      )
    ]);

    if (!suppR.rows[0]) return res.status(404).json({ error: 'not-found' });

    const stats = statsR.rows[0];
    stats.rating = suppR.rows[0].rating;

    res.json({
      ok: true,
      supplier: suppR.rows[0],
      contacts: contactsR.rows,
      stats
    });
  } catch (e) { ERR(e, res); }
});


/**
 * POST /api/suppliers
 * Створити постачальника.
 * Spec: 05.02 — повна картка: назва, ІПН, адреси, банк, умови, нотатки.
 * RBAC: supplier.write
 */
router.post('/', requirePerm('supplier.write'), async (req, res) => {
  try {
    const {
      name, legal_name, tax_id,
      legal_address, actual_address, warehouse_address,
      phone, email, website,
      bank_name, bank_account, bank_mfo,
      payment_terms_days = 0, min_order_amount = 0,
      discount_percent = 0, currency = 'UAH',
      default_delivery, status = 'active', notes,
      branch_id
    } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'bad-request', message: 'name обовʼязкове' });
    }

    const r = await pool.query(
      `INSERT INTO suppliers (
         name, legal_name, tax_id,
         legal_address, actual_address, warehouse_address,
         phone, email, website,
         bank_name, bank_account, bank_mfo,
         payment_terms_days, min_order_amount, discount_percent,
         currency, default_delivery, status, notes, branch_id,
         created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
         $13,$14,$15,$16,$17,$18,$19,$20,
         NOW(), NOW()
       ) RETURNING *`,
      [
        String(name).trim(), legal_name || null, tax_id || null,
        legal_address || null, actual_address || null, warehouse_address || null,
        phone || null, email || null, website || null,
        bank_name || null, bank_account || null, bank_mfo || null,
        parseInt(payment_terms_days, 10) || 0,
        parseFloat(min_order_amount) || 0,
        parseFloat(discount_percent) || 0,
        currency || 'UAH',
        default_delivery || null,
        ['active','paused','blocked'].includes(status) ? status : 'active',
        notes || null,
        branch_id || null
      ]
    );

    logAction({ user: req.user, action: 'supplier.create', entity: 'suppliers', entity_id: r.rows[0].id, ip: req.ip, meta: { name } });
    res.status(201).json({ ok: true, supplier: r.rows[0] });
  } catch (e) { ERR(e, res); }
});


/**
 * PATCH /api/suppliers/:id
 * Оновити картку постачальника.
 * Spec: 05.02 — редагування всіх полів картки.
 * RBAC: supplier.write
 */
router.patch('/:id', requirePerm('supplier.write'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad-id' });

    const allowed = [
      'name','legal_name','tax_id',
      'legal_address','actual_address','warehouse_address',
      'phone','email','website',
      'bank_name','bank_account','bank_mfo',
      'payment_terms_days','min_order_amount','discount_percent',
      'currency','default_delivery','status','notes','branch_id'
    ];

    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        vals.push(req.body[key]);
        sets.push(`${key} = $${vals.length}`);
      }
    }

    if (sets.length === 0) return res.status(400).json({ error: 'no-changes' });

    vals.push(id);
    const r = await pool.query(
      `UPDATE suppliers SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });

    logAction({ user: req.user, action: 'supplier.update', entity: 'suppliers', entity_id: id, ip: req.ip });
    res.json({ ok: true, supplier: r.rows[0] });
  } catch (e) { ERR(e, res); }
});


/**
 * DELETE /api/suppliers/:id
 * Soft-delete: статус → 'blocked'.
 * Spec: 05.01 — статуси: активний, на паузі, заблокований. DELETE = soft-block.
 * RBAC: supplier.delete
 */
router.delete('/:id', requirePerm('supplier.delete'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad-id' });

    const r = await pool.query(
      `UPDATE suppliers SET status = 'blocked', updated_at = NOW() WHERE id = $1 RETURNING id, name`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });

    logAction({ user: req.user, action: 'supplier.delete', entity: 'suppliers', entity_id: id, ip: req.ip });
    res.json({ ok: true, supplier: r.rows[0] });
  } catch (e) { ERR(e, res); }
});


// ══════════════════════════════════════════════════════════════
// КОНТАКТНІ ОСОБИ
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/suppliers/:id/contacts
 * Список контактних осіб постачальника.
 * Spec: 05.02 — кілька контактних осіб: ПІБ, посада, телефон, email, telegram.
 */
router.get('/:id/contacts', requirePerm('supplier.read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad-id' });

    const r = await pool.query(
      `SELECT * FROM supplier_contacts WHERE supplier_id = $1 ORDER BY is_primary DESC, name`,
      [id]
    );
    res.json({ ok: true, contacts: r.rows });
  } catch (e) { ERR(e, res); }
});


/**
 * POST /api/suppliers/:id/contacts
 * Додати контактну особу.
 * Spec: 05.02 — ФИО, должность, телефон, email, telegram.
 * RBAC: supplier.write
 */
router.post('/:id/contacts', requirePerm('supplier.write'), async (req, res) => {
  try {
    const supplier_id = parseInt(req.params.id, 10);
    if (!supplier_id) return res.status(400).json({ error: 'bad-id' });

    const { name, position, phone, email, telegram, is_primary = false } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'bad-request', message: 'name обовʼязкове' });
    }

    // якщо is_primary=true — знімаємо прапор у решти
    if (is_primary) {
      await pool.query(
        `UPDATE supplier_contacts SET is_primary = false WHERE supplier_id = $1`,
        [supplier_id]
      );
    }

    const r = await pool.query(
      `INSERT INTO supplier_contacts (supplier_id, name, position, phone, email, telegram, is_primary)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [supplier_id, String(name).trim(), position || null, phone || null, email || null, telegram || null, !!is_primary]
    );

    logAction({ user: req.user, action: 'supplier.contact.create', entity: 'supplier_contacts', entity_id: r.rows[0].id, ip: req.ip, meta: { supplier_id } });
    res.status(201).json({ ok: true, contact: r.rows[0] });
  } catch (e) { ERR(e, res); }
});


/**
 * PATCH /api/suppliers/:id/contacts/:cid
 * Оновити контактну особу.
 * RBAC: supplier.write
 */
router.patch('/:id/contacts/:cid', requirePerm('supplier.write'), async (req, res) => {
  try {
    const supplier_id = parseInt(req.params.id, 10);
    const cid = parseInt(req.params.cid, 10);
    if (!supplier_id || !cid) return res.status(400).json({ error: 'bad-id' });

    const allowed = ['name','position','phone','email','telegram','is_primary'];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        vals.push(req.body[key]);
        sets.push(`${key} = $${vals.length}`);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'no-changes' });

    if (req.body.is_primary) {
      await pool.query(`UPDATE supplier_contacts SET is_primary=false WHERE supplier_id=$1`, [supplier_id]);
    }

    vals.push(cid); vals.push(supplier_id);
    const r = await pool.query(
      `UPDATE supplier_contacts SET ${sets.join(', ')}, updated_at=NOW()
       WHERE id=$${vals.length - 1} AND supplier_id=$${vals.length} RETURNING *`,
      vals
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });

    logAction({ user: req.user, action: 'supplier.contact.update', entity: 'supplier_contacts', entity_id: cid, ip: req.ip });
    res.json({ ok: true, contact: r.rows[0] });
  } catch (e) { ERR(e, res); }
});


/**
 * DELETE /api/suppliers/:id/contacts/:cid
 * Видалити контактну особу.
 * RBAC: supplier.write
 */
router.delete('/:id/contacts/:cid', requirePerm('supplier.write'), async (req, res) => {
  try {
    const cid = parseInt(req.params.cid, 10);
    const supplier_id = parseInt(req.params.id, 10);
    if (!cid || !supplier_id) return res.status(400).json({ error: 'bad-id' });

    const r = await pool.query(
      `DELETE FROM supplier_contacts WHERE id=$1 AND supplier_id=$2 RETURNING id`,
      [cid, supplier_id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });

    logAction({ user: req.user, action: 'supplier.contact.delete', entity: 'supplier_contacts', entity_id: cid, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { ERR(e, res); }
});


// ══════════════════════════════════════════════════════════════
// 05.03 — КАТАЛОГ ТОВАРІВ ПОСТАЧАЛЬНИКА
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/suppliers/:id/products
 * Каталог товарів постачальника з пошуком.
 * Query: ?search=&in_stock=true
 * Spec: 05.03 — прив'язка товарів, закупівельна ціна, SKU, мінімальна партія,
 *               термін поставки, наявність, маржа (роздрібна − закупівельна).
 * RBAC: supplier.prices.read
 */
router.get('/:id/products', requirePerm('supplier.prices.read'), async (req, res) => {
  try {
    const supplier_id = parseInt(req.params.id, 10);
    if (!supplier_id) return res.status(400).json({ error: 'bad-id' });

    const { search, in_stock } = req.query;
    const cond = ['sp.supplier_id = $1'];
    const args = [supplier_id];

    if (search) {
      args.push(`%${search}%`);
      cond.push(`(p.name ILIKE $${args.length} OR sp.supplier_sku ILIKE $${args.length})`);
    }
    if (in_stock === 'true') {
      cond.push('sp.in_stock = true');
    } else if (in_stock === 'false') {
      cond.push('sp.in_stock = false');
    }

    const r = await pool.query(
      `SELECT
         sp.id, sp.supplier_sku, sp.purchase_price, sp.min_quantity,
         sp.delivery_days, sp.in_stock, sp.last_price_update,
         sp.created_at, sp.updated_at,
         p.id AS product_id, p.name AS product_name,
         p.price AS retail_price,
         CASE WHEN p.price IS NOT NULL
              THEN ROUND((p.price - sp.purchase_price)::numeric, 2)
              ELSE NULL
         END AS margin
       FROM supplier_products sp
       JOIN products p ON p.id = sp.product_id
       WHERE ${cond.join(' AND ')}
       ORDER BY p.name`,
      args
    );
    res.json({ ok: true, products: r.rows });
  } catch (e) { ERR(e, res); }
});


/**
 * POST /api/suppliers/:id/products
 * Прив'язати товар до постачальника.
 * Spec: 05.03 — product_id, purchase_price, supplier_sku, min_quantity, delivery_days.
 * При зміні ціни — фіксуємо в supplier_price_history.
 * RBAC: supplier.write
 */
router.post('/:id/products', requirePerm('supplier.write'), async (req, res) => {
  try {
    const supplier_id = parseInt(req.params.id, 10);
    if (!supplier_id) return res.status(400).json({ error: 'bad-id' });

    const { product_id, purchase_price, supplier_sku, min_quantity = 1, delivery_days = 3, in_stock = true } = req.body;
    if (!product_id) return res.status(400).json({ error: 'bad-request', message: 'product_id обовʼязковий' });
    if (purchase_price === undefined || purchase_price === null) {
      return res.status(400).json({ error: 'bad-request', message: 'purchase_price обовʼязкова' });
    }

    const r = await pool.query(
      `INSERT INTO supplier_products
         (supplier_id, product_id, supplier_sku, purchase_price, min_quantity, delivery_days, in_stock, last_price_update)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       RETURNING *`,
      [supplier_id, product_id, supplier_sku || null, parseFloat(purchase_price),
       parseInt(min_quantity, 10) || 1, parseInt(delivery_days, 10) || 3, !!in_stock]
    );

    // перший запис — одразу ж логуємо в history як new_price
    await pool.query(
      `INSERT INTO supplier_price_history (supplier_product_id, old_price, new_price, changed_at)
       VALUES ($1, NULL, $2, NOW())`,
      [r.rows[0].id, parseFloat(purchase_price)]
    );

    logAction({ user: req.user, action: 'supplier.product.add', entity: 'supplier_products', entity_id: r.rows[0].id, ip: req.ip, meta: { supplier_id, product_id } });
    res.status(201).json({ ok: true, supplier_product: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'duplicate', message: 'Товар вже прив\'язано до цього постачальника' });
    ERR(e, res);
  }
});


/**
 * PATCH /api/suppliers/:id/products/:sp_id
 * Оновити ціну/умови товару постачальника.
 * Spec: 05.03 — оновлення закупівельної ціни → фіксація в history.
 * RBAC: supplier.write
 */
router.patch('/:id/products/:sp_id', requirePerm('supplier.write'), async (req, res) => {
  try {
    const supplier_id = parseInt(req.params.id, 10);
    const sp_id = parseInt(req.params.sp_id, 10);
    if (!supplier_id || !sp_id) return res.status(400).json({ error: 'bad-id' });

    // отримуємо поточну ціну для history
    const cur = await pool.query(
      `SELECT purchase_price FROM supplier_products WHERE id=$1 AND supplier_id=$2`,
      [sp_id, supplier_id]
    );
    if (!cur.rows[0]) return res.status(404).json({ error: 'not-found' });

    const allowed = ['supplier_sku','purchase_price','min_quantity','delivery_days','in_stock'];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        vals.push(req.body[key]);
        sets.push(`${key} = $${vals.length}`);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'no-changes' });

    // якщо змінилась ціна — оновлюємо last_price_update
    if (req.body.purchase_price !== undefined) {
      sets.push('last_price_update = NOW()');
    }

    vals.push(sp_id); vals.push(supplier_id);
    const r = await pool.query(
      `UPDATE supplier_products SET ${sets.join(', ')}, updated_at=NOW()
       WHERE id=$${vals.length - 1} AND supplier_id=$${vals.length}
       RETURNING *`,
      vals
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });

    // логуємо зміну ціни в history
    if (req.body.purchase_price !== undefined &&
        parseFloat(req.body.purchase_price) !== parseFloat(cur.rows[0].purchase_price)) {
      await pool.query(
        `INSERT INTO supplier_price_history (supplier_product_id, old_price, new_price, changed_at)
         VALUES ($1,$2,$3,NOW())`,
        [sp_id, cur.rows[0].purchase_price, parseFloat(req.body.purchase_price)]
      );
    }

    logAction({ user: req.user, action: 'supplier.product.update', entity: 'supplier_products', entity_id: sp_id, ip: req.ip });
    res.json({ ok: true, supplier_product: r.rows[0] });
  } catch (e) { ERR(e, res); }
});


/**
 * DELETE /api/suppliers/:id/products/:sp_id
 * Відв'язати товар від постачальника.
 * Spec: 05.03 — відв'язка товару з каталогу.
 * RBAC: supplier.write
 */
router.delete('/:id/products/:sp_id', requirePerm('supplier.write'), async (req, res) => {
  try {
    const supplier_id = parseInt(req.params.id, 10);
    const sp_id = parseInt(req.params.sp_id, 10);
    if (!supplier_id || !sp_id) return res.status(400).json({ error: 'bad-id' });

    const r = await pool.query(
      `DELETE FROM supplier_products WHERE id=$1 AND supplier_id=$2 RETURNING id`,
      [sp_id, supplier_id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });

    logAction({ user: req.user, action: 'supplier.product.remove', entity: 'supplier_products', entity_id: sp_id, ip: req.ip, meta: { supplier_id } });
    res.json({ ok: true });
  } catch (e) { ERR(e, res); }
});


/**
 * GET /api/suppliers/:id/products/:sp_id/price-history
 * Історія зміни закупівельних цін.
 * Spec: 05.03 — history зміни ціни.
 * RBAC: supplier.prices.read
 */
router.get('/:id/products/:sp_id/price-history', requirePerm('supplier.prices.read'), async (req, res) => {
  try {
    const supplier_id = parseInt(req.params.id, 10);
    const sp_id = parseInt(req.params.sp_id, 10);
    if (!supplier_id || !sp_id) return res.status(400).json({ error: 'bad-id' });

    const r = await pool.query(
      `SELECT sph.* FROM supplier_price_history sph
       JOIN supplier_products sp ON sp.id = sph.supplier_product_id
       WHERE sph.supplier_product_id = $1 AND sp.supplier_id = $2
       ORDER BY sph.changed_at DESC`,
      [sp_id, supplier_id]
    );
    res.json({ ok: true, history: r.rows });
  } catch (e) { ERR(e, res); }
});


// ══════════════════════════════════════════════════════════════
// 05.04 — РЕЙТИНГИ
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/suppliers/:id/ratings
 * Історія оцінок постачальника.
 * Spec: 05.04 — история оценок (score, delivery_on_time, quality_ok, comment).
 */
router.get('/:id/ratings', requirePerm('supplier.read'), async (req, res) => {
  try {
    const supplier_id = parseInt(req.params.id, 10);
    if (!supplier_id) return res.status(400).json({ error: 'bad-id' });

    const r = await pool.query(
      `SELECT sr.*, po.po_number
       FROM supplier_ratings sr
       LEFT JOIN purchase_orders po ON po.id = sr.purchase_order_id
       WHERE sr.supplier_id = $1
       ORDER BY sr.created_at DESC`,
      [supplier_id]
    );
    res.json({ ok: true, ratings: r.rows });
  } catch (e) { ERR(e, res); }
});


/**
 * POST /api/suppliers/:id/ratings
 * Оцінити поставку вручну.
 * Spec: 05.04 — ручна оцінка по шкалі 1-5 після кожної поставки.
 * Після запису — перераховуємо aggregate rating на suppliers.
 * RBAC: supplier.rate
 */
router.post('/:id/ratings', requirePerm('supplier.rate'), async (req, res) => {
  try {
    const supplier_id = parseInt(req.params.id, 10);
    if (!supplier_id) return res.status(400).json({ error: 'bad-id' });

    const { purchase_order_id, score, delivery_on_time, quality_ok, comment } = req.body;
    const scoreInt = parseInt(score, 10);
    if (!scoreInt || scoreInt < 1 || scoreInt > 5) {
      return res.status(400).json({ error: 'bad-request', message: 'score має бути від 1 до 5' });
    }

    const r = await pool.query(
      `INSERT INTO supplier_ratings
         (supplier_id, purchase_order_id, score, delivery_on_time, quality_ok, comment, rated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [supplier_id, purchase_order_id || null, scoreInt,
       delivery_on_time !== undefined ? !!delivery_on_time : null,
       quality_ok !== undefined ? !!quality_ok : null,
       comment || null,
       req.user?.id || null]
    );

    // перераховуємо aggregate rating (avg за останні 20 оцінок)
    await pool.query(
      `UPDATE suppliers
       SET rating = (
         SELECT ROUND(AVG(score)::numeric, 2)
         FROM (SELECT score FROM supplier_ratings WHERE supplier_id=$1 ORDER BY created_at DESC LIMIT 20) sub
       ), updated_at = NOW()
       WHERE id = $1`,
      [supplier_id]
    );

    logAction({ user: req.user, action: 'supplier.rate', entity: 'supplier_ratings', entity_id: r.rows[0].id, ip: req.ip, meta: { supplier_id, score: scoreInt } });
    res.status(201).json({ ok: true, rating: r.rows[0] });
  } catch (e) { ERR(e, res); }
});


// ══════════════════════════════════════════════════════════════
// 05.05 — ДОКУМЕНТИ
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/suppliers/:id/documents
 * Документи постачальника.
 * Spec: 05.05 — договір, прайс, сертифікати; термін дії.
 */
router.get('/:id/documents', requirePerm('supplier.read'), async (req, res) => {
  try {
    const supplier_id = parseInt(req.params.id, 10);
    if (!supplier_id) return res.status(400).json({ error: 'bad-id' });

    const { doc_type } = req.query;
    const cond = ['supplier_id = $1'];
    const args = [supplier_id];

    if (doc_type) {
      args.push(doc_type);
      cond.push(`doc_type = $${args.length}`);
    }

    const r = await pool.query(
      `SELECT *,
         CASE WHEN valid_until IS NOT NULL AND valid_until < CURRENT_DATE THEN true ELSE false END AS is_expired,
         CASE WHEN valid_until IS NOT NULL AND valid_until BETWEEN CURRENT_DATE AND CURRENT_DATE + 30 THEN true ELSE false END AS expires_soon
       FROM supplier_documents
       WHERE ${cond.join(' AND ')}
       ORDER BY doc_type, version DESC`,
      args
    );
    res.json({ ok: true, documents: r.rows });
  } catch (e) { ERR(e, res); }
});


/**
 * POST /api/suppliers/:id/documents
 * Завантажити документ.
 * Spec: 05.05 — договір (скан), прайс-лист, сертифікати; версіонування прайсів.
 * RBAC: supplier.docs.write
 */
router.post('/:id/documents', requirePerm('supplier.docs.write'), async (req, res) => {
  try {
    const supplier_id = parseInt(req.params.id, 10);
    if (!supplier_id) return res.status(400).json({ error: 'bad-id' });

    const { doc_type = 'other', title, file_url, valid_from, valid_until } = req.body;
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'bad-request', message: 'title обовʼязковий' });
    }
    if (!file_url || !String(file_url).trim()) {
      return res.status(400).json({ error: 'bad-request', message: 'file_url обовʼязковий' });
    }
    if (!['contract','pricelist','certificate','other'].includes(doc_type)) {
      return res.status(400).json({ error: 'bad-request', message: 'doc_type: contract|pricelist|certificate|other' });
    }

    // версіонування: визначаємо наступну версію для типу
    const versionR = await pool.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
       FROM supplier_documents WHERE supplier_id=$1 AND doc_type=$2`,
      [supplier_id, doc_type]
    );
    const version = versionR.rows[0].next_version;

    const r = await pool.query(
      `INSERT INTO supplier_documents (supplier_id, doc_type, title, file_url, version, valid_from, valid_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [supplier_id, doc_type, String(title).trim(), String(file_url).trim(),
       version, valid_from || null, valid_until || null]
    );

    logAction({ user: req.user, action: 'supplier.document.upload', entity: 'supplier_documents', entity_id: r.rows[0].id, ip: req.ip, meta: { supplier_id, doc_type } });
    res.status(201).json({ ok: true, document: r.rows[0] });
  } catch (e) { ERR(e, res); }
});


/**
 * DELETE /api/suppliers/:id/documents/:doc_id
 * Видалити документ.
 * RBAC: supplier.docs.write
 */
router.delete('/:id/documents/:doc_id', requirePerm('supplier.docs.write'), async (req, res) => {
  try {
    const supplier_id = parseInt(req.params.id, 10);
    const doc_id = parseInt(req.params.doc_id, 10);
    if (!supplier_id || !doc_id) return res.status(400).json({ error: 'bad-id' });

    const r = await pool.query(
      `DELETE FROM supplier_documents WHERE id=$1 AND supplier_id=$2 RETURNING id`,
      [doc_id, supplier_id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });

    logAction({ user: req.user, action: 'supplier.document.delete', entity: 'supplier_documents', entity_id: doc_id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { ERR(e, res); }
});


// ══════════════════════════════════════════════════════════════
// ІСТОРІЯ ЗАКУПІВЕЛЬ постачальника
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/suppliers/:id/orders
 * Історія заказів у постачальника (з purchase_orders).
 * Spec: 05.01 — «останній заказ, сума за період»; інтеграція SLS-06.
 * Query: ?status=&from=&to=&limit=50&offset=0
 */
router.get('/:id/orders', requirePerm('supplier.read'), async (req, res) => {
  try {
    const supplier_id = parseInt(req.params.id, 10);
    if (!supplier_id) return res.status(400).json({ error: 'bad-id' });

    const { status, from, to, limit = 50, offset = 0 } = req.query;
    const cond = ['po.supplier_id = $1'];
    const args = [supplier_id];

    if (status) { args.push(status); cond.push(`po.status = $${args.length}`); }
    if (from)   { args.push(from);   cond.push(`po.created_at >= $${args.length}`); }
    if (to)     { args.push(to);     cond.push(`po.created_at <= $${args.length}`); }

    args.push(Math.min(parseInt(limit, 10) || 50, 200));
    args.push(parseInt(offset, 10) || 0);

    const r = await pool.query(
      `SELECT po.id, po.po_number, po.status, po.total_amount,
              po.expected_delivery, po.actual_delivery,
              po.created_at, po.ordered_at, po.received_at
       FROM purchase_orders po
       WHERE ${cond.join(' AND ')}
       ORDER BY po.created_at DESC
       LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args
    );
    res.json({ ok: true, orders: r.rows });
  } catch (e) { ERR(e, res); }
});

module.exports = router;
