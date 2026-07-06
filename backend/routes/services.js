/* ═══════════════════════════════════════════════════════
   SAL-01 — SERVICES (Услуги салона)
   Реестр, карточка, вариации, индивидуальные цены мастеров,
   составные услуги (комплексы), история изменения цен.
   Базовая схема: services (integer id), поля duration_min/price/category/active.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();

const WRITE = requirePerm('catalog.write');

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9а-яёіїєґ]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

// #100: валидация category_id — категория должна существовать и не быть удалённой.
// Возвращает строку категории или null.
async function findCategory(categoryId) {
  const r = await pool.query(
    `SELECT id, name FROM service_categories WHERE id=$1 AND deleted_at IS NULL`, [categoryId]);
  return r.rowCount ? r.rows[0] : null;
}

// #102: rebook_interval_days — целое >= 1 или null
function normalizeRebookInterval(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return undefined; // undefined = невалидно
  return n;
}

async function uniqueSlug(base, table = 'services', excludeId = null) {
  let slug = slugify(base) || 'service';
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const q = excludeId
      ? `SELECT 1 FROM ${table} WHERE slug=$1 AND id<>$2`
      : `SELECT 1 FROM ${table} WHERE slug=$1`;
    const params = excludeId ? [slug, excludeId] : [slug];
    const r = await pool.query(q, params);
    if (!r.rowCount) return slug;
    n += 1;
    slug = `${slugify(base)}-${n}`;
  }
}

/* ─────────────── 01.01 Реестр услуг ─────────────── */
router.get('/', async (req, res) => {
  try {
    const { category, status, search, min_price, max_price, min_duration, max_duration } = req.query;
    const sortMap = { name: 'name', price: 'price', duration: 'duration_min', created: 'created_at', sort: 'sort_order' };
    const sortCol = sortMap[req.query.sort] || 'sort_order';
    const order = (req.query.order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;

    const conds = ['deleted_at IS NULL'];
    const params = [];
    // #100: фильтр по FK-категории; переходный период — учитываем и старое текстовое поле
    if (req.query.category_id) {
      const cid = parseInt(req.query.category_id);
      if (Number.isInteger(cid)) {
        const cat = await findCategory(cid);
        params.push(cid);
        const p1 = params.length;
        if (cat) {
          params.push(cat.name);
          conds.push(`(category_id = $${p1} OR (category_id IS NULL AND category = $${params.length}))`);
        } else {
          conds.push(`category_id = $${p1}`);
        }
      }
    } else if (category) { params.push(category); conds.push(`category = $${params.length}`); }
    if (status) { params.push(status); conds.push(`status = $${params.length}`); }
    if (search) { params.push('%' + String(search).toLowerCase() + '%'); conds.push(`LOWER(name) LIKE $${params.length}`); }
    if (min_price) { params.push(min_price); conds.push(`price >= $${params.length}`); }
    if (max_price) { params.push(max_price); conds.push(`price <= $${params.length}`); }
    if (min_duration) { params.push(min_duration); conds.push(`duration_min >= $${params.length}`); }
    if (max_duration) { params.push(max_duration); conds.push(`duration_min <= $${params.length}`); }
    const where = conds.join(' AND ');

    params.push(limit); const lp = params.length;
    params.push(offset); const op = params.length;
    const r = await pool.query(
      `SELECT id, name, category, category_id, price, duration_min, status, active, photo_urls,
              is_new, is_hit, is_discounted, sort_order,
              (SELECT COUNT(*)::int FROM service_variations v WHERE v.service_id=s.id AND v.active) AS variations_count
         FROM services s
        WHERE ${where}
        ORDER BY ${sortCol} ${order}, id
        LIMIT $${lp} OFFSET $${op}`,
      params
    );
    const cr = await pool.query(`SELECT COUNT(*)::int AS total FROM services s WHERE ${where}`, params.slice(0, params.length - 2));
    res.json({ items: r.rows, total: cr.rows[0].total, limit, offset });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* Список категорий услуг (distinct) + счётчики */
router.get('/categories', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT category, COUNT(*)::int AS count
         FROM services WHERE deleted_at IS NULL AND category IS NOT NULL
        GROUP BY category ORDER BY category`
    );
    res.json({ items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ─────────────── 01.05 Комплексы (список) ─────────────── */
router.get('/combos', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM service_combos ORDER BY sort_order, id`);
    res.json({ items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/combos/:id', async (req, res) => {
  try {
    const c = await pool.query(`SELECT * FROM service_combos WHERE id=$1`, [req.params.id]);
    if (!c.rowCount) return res.status(404).json({ error: 'not_found' });
    const items = await pool.query(
      `SELECT ci.*, s.name AS service_name, v.name AS variation_name
         FROM service_combo_items ci
         JOIN services s ON s.id=ci.service_id
    LEFT JOIN service_variations v ON v.id=ci.variation_id
        WHERE ci.combo_id=$1 ORDER BY ci.execution_order, ci.id`,
      [req.params.id]
    );
    res.json({ ...c.rows[0], items: items.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ─────────────── 01.02 Карточка услуги ─────────────── */
router.get('/:id', async (req, res) => {
  try {
    const s = await pool.query(`SELECT * FROM services WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
    if (!s.rowCount) return res.status(404).json({ error: 'not_found' });
    const variations = await pool.query(
      `SELECT * FROM service_variations WHERE service_id=$1 ORDER BY sort_order, id`, [req.params.id]);
    const masterPrices = await pool.query(
      `SELECT mp.*, m.name AS master_name FROM service_master_prices mp
         JOIN masters m ON m.id=mp.master_id WHERE mp.service_id=$1 ORDER BY m.name`, [req.params.id]);
    const history = await pool.query(
      `SELECT * FROM service_price_history WHERE service_id=$1 ORDER BY changed_at DESC LIMIT 50`, [req.params.id]);
    const combos = await pool.query(
      `SELECT DISTINCT c.id, c.name, c.combo_price FROM service_combos c
         JOIN service_combo_items ci ON ci.combo_id=c.id WHERE ci.service_id=$1`, [req.params.id]);
    res.json({
      service: s.rows[0],
      variations: variations.rows,
      master_prices: masterPrices.rows,
      price_history: history.rows,
      combos: combos.rows,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ─────────────── POST /  Создать услугу ─────────────── */
const CARD_FIELDS = [
  'name', 'name_ua', 'name_en', 'category', 'description', 'internal_note',
  'buffer_before', 'buffer_after', 'min_booking_interval', 'max_simultaneous',
  'required_room_type', 'icon', 'color', 'status', 'is_new', 'is_hit', 'is_discounted',
  'age_restriction', 'contraindications', 'meta_title', 'meta_description', 'sort_order',
  'is_material', // рядок-послуга є матеріалом → не входить у базу % майстра (SaaS-аудит 06.07)
];

router.post('/', WRITE,
  require('../lib/plan-limits').enforcePlanLimit('max_services',
    "SELECT COUNT(*)::int AS n FROM services WHERE COALESCE(active,true)=true"),
  async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name required' });
    const price = b.price != null ? b.price : b.base_price;
    const duration = b.duration_min != null ? b.duration_min : b.base_duration;
    if (price == null || duration == null) return res.status(400).json({ error: 'price and duration required' });
    if (!Number.isFinite(Number(price)) || Number(price) < 0) return res.status(400).json({ error: 'price-must-be-non-negative' });
    if (!Number.isFinite(Number(duration)) || Number(duration) <= 0) return res.status(400).json({ error: 'duration-must-be-positive' });
    // #100: FK-категория (текстовое category остаётся для совместимости)
    let categoryId = null;
    let categoryText = b.category || null;
    if (b.category_id != null && b.category_id !== '') {
      const cat = await findCategory(b.category_id);
      if (!cat) return res.status(400).json({ error: 'category_not_found' });
      categoryId = cat.id;
      if (!categoryText) categoryText = cat.name; // синхронизируем текстовое поле
    }
    // #102: интервал повторного визита
    const rebook = normalizeRebookInterval(b.rebook_interval_days);
    if (rebook === undefined) return res.status(400).json({ error: 'rebook_interval_days-must-be-positive-integer' });
    const slug = await uniqueSlug(b.slug || b.name);
    const photoUrls = JSON.stringify(Array.isArray(b.photo_urls) ? b.photo_urls : []);
    const status = b.status || 'active';
    const r = await pool.query(
      `INSERT INTO services
        (name, name_ua, name_en, slug, category, category_id, rebook_interval_days, description, internal_note, price, duration_min,
         buffer_before, buffer_after, min_booking_interval, max_simultaneous, required_room_type,
         photo_urls, icon, color, status, active, is_new, is_hit, is_discounted, age_restriction,
         contraindications, meta_title, meta_description, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               COALESCE($12,0),COALESCE($13,0),COALESCE($14,30),COALESCE($15,1),$16,
               $17::jsonb,$18,$19,$20,$21,COALESCE($22,FALSE),COALESCE($23,FALSE),COALESCE($24,FALSE),$25,
               $26,$27,$28,COALESCE($29,0))
       RETURNING *`,
      [b.name, b.name_ua || null, b.name_en || null, slug, categoryText, categoryId, rebook, b.description || null,
       b.internal_note || null, price, duration, b.buffer_before, b.buffer_after, b.min_booking_interval,
       b.max_simultaneous, b.required_room_type || null, photoUrls, b.icon || null, b.color || null,
       status, status === 'active', b.is_new, b.is_hit, b.is_discounted, b.age_restriction || null,
       b.contraindications || null, b.meta_title || null, b.meta_description || null, b.sort_order]
    );
    const svc = r.rows[0];
    await pool.query(
      `INSERT INTO service_price_history (service_id, old_price, new_price, changed_by, changed_by_name, reason)
       VALUES ($1,NULL,$2,$3,$4,'создание услуги')`,
      [svc.id, price, req.user?.id || null, req.user?.display_name || null]
    );
    await logAction({ user: req.user, action: 'service.create', entity: 'service', entity_id: svc.id, meta: { name: b.name } });
    res.json({ ok: true, service: svc });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ─────────────── PATCH /:id  Обновить ─────────────── */
router.patch('/:id', WRITE, async (req, res) => {
  try {
    const id = req.params.id;
    const cur = await pool.query(`SELECT * FROM services WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'not_found' });
    const old = cur.rows[0];
    const b = req.body || {};

    const sets = [];
    const params = [];
    const setCol = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };

    for (const f of CARD_FIELDS) {
      if (b[f] !== undefined) setCol(f, b[f]);
    }
    // #100: FK-категория (валидация существования; текстовое category синхронизируем)
    if (b.category_id !== undefined) {
      if (b.category_id === null || b.category_id === '') {
        setCol('category_id', null);
      } else {
        const cat = await findCategory(b.category_id);
        if (!cat) return res.status(400).json({ error: 'category_not_found' });
        setCol('category_id', cat.id);
        if (b.category === undefined) setCol('category', cat.name);
      }
    }
    // #102: интервал повторного визита (целое >= 1 или null)
    if (b.rebook_interval_days !== undefined) {
      const rebook = normalizeRebookInterval(b.rebook_interval_days);
      if (rebook === undefined) return res.status(400).json({ error: 'rebook_interval_days-must-be-positive-integer' });
      setCol('rebook_interval_days', rebook);
    }
    if (b.price !== undefined || b.base_price !== undefined) setCol('price', b.price !== undefined ? b.price : b.base_price);
    if (b.duration_min !== undefined || b.base_duration !== undefined) setCol('duration_min', b.duration_min !== undefined ? b.duration_min : b.base_duration);
    if (b.slug !== undefined) setCol('slug', await uniqueSlug(b.slug, 'services', id));
    if (b.photo_urls !== undefined) { params.push(JSON.stringify(b.photo_urls || [])); sets.push(`photo_urls=$${params.length}::jsonb`); }
    if (b.status !== undefined) setCol('active', b.status === 'active');
    if (b.active !== undefined && b.status === undefined) { setCol('active', !!b.active); setCol('status', b.active ? 'active' : 'inactive'); }

    if (!sets.length) return res.json({ ok: true, service: old });
    sets.push('updated_at=NOW()');
    params.push(id);
    const r = await pool.query(`UPDATE services SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`, params);
    const svc = r.rows[0];

    const newPrice = b.price !== undefined ? b.price : (b.base_price !== undefined ? b.base_price : null);
    if (newPrice != null && Number(newPrice) !== Number(old.price)) {
      await pool.query(
        `INSERT INTO service_price_history (service_id, old_price, new_price, changed_by, changed_by_name, reason)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, old.price, newPrice, req.user?.id || null, req.user?.display_name || null, b.price_reason || 'изменение цены']
      );
    }
    await logAction({ user: req.user, action: 'service.update', entity: 'service', entity_id: id, meta: { fields: Object.keys(b) } });
    res.json({ ok: true, service: svc });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ─────────────── DELETE /:id  Soft-delete ─────────────── */
router.delete('/:id', WRITE, async (req, res) => {
  try {
    const id = req.params.id;
    const fut = await pool.query(
      `SELECT COUNT(*)::int AS c FROM appointments
        WHERE service_id=$1 AND starts_at > NOW() AND status IN ('booked','confirmed')`, [id]);
    if (fut.rows[0].c > 0) return res.status(409).json({ error: 'has_future_appointments', count: fut.rows[0].c });
    const r = await pool.query(
      `UPDATE services SET deleted_at=NOW(), active=FALSE, status='inactive', updated_at=NOW()
        WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    await logAction({ user: req.user, action: 'service.delete', entity: 'service', entity_id: id });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ─────────────── POST /:id/duplicate ─────────────── */
router.post('/:id/duplicate', WRITE, async (req, res) => {
  try {
    const id = req.params.id;
    const cur = await pool.query(`SELECT * FROM services WHERE id=$1`, [id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'not_found' });
    const s = cur.rows[0];
    const newName = req.body?.new_name || `${s.name} (копія)`;
    const slug = await uniqueSlug(newName);
    const r = await pool.query(
      `INSERT INTO services
        (name, name_ua, name_en, slug, category, category_id, rebook_interval_days, description, internal_note, price, duration_min,
         buffer_before, buffer_after, min_booking_interval, max_simultaneous, required_room_type,
         photo_urls, icon, color, status, active, age_restriction, contraindications,
         meta_title, meta_description, sort_order)
       SELECT $1, name_ua, name_en, $2, category, category_id, rebook_interval_days, description, internal_note, price, duration_min,
              buffer_before, buffer_after, min_booking_interval, max_simultaneous, required_room_type,
              photo_urls, icon, color, 'draft', FALSE, age_restriction, contraindications,
              meta_title, meta_description, sort_order
         FROM services WHERE id=$3 RETURNING *`,
      [newName, slug, id]
    );
    const nid = r.rows[0].id;
    await pool.query(
      `INSERT INTO service_variations (service_id, name, variation_type, price, duration_min, description, sort_order, active)
       SELECT $1, name, variation_type, price, duration_min, description, sort_order, active
         FROM service_variations WHERE service_id=$2`, [nid, id]);
    await logAction({ user: req.user, action: 'service.duplicate', entity: 'service', entity_id: nid, meta: { from: id } });
    res.json({ ok: true, service: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ─────────────── 01.03 Вариации ─────────────── */
router.get('/:id/variations', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM service_variations WHERE service_id=$1 ORDER BY sort_order, id`, [req.params.id]);
    res.json({ items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/:id/variations', WRITE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || b.price == null || b.duration_min == null)
      return res.status(400).json({ error: 'name, price, duration_min required' });
    const r = await pool.query(
      `INSERT INTO service_variations (service_id, name, variation_type, price, duration_min, description, sort_order, active)
       VALUES ($1,$2,COALESCE($3,'custom'),$4,$5,$6,COALESCE($7,0),COALESCE($8,TRUE))
       ON CONFLICT (service_id, name) DO UPDATE SET
         variation_type=EXCLUDED.variation_type, price=EXCLUDED.price, duration_min=EXCLUDED.duration_min,
         description=EXCLUDED.description, sort_order=EXCLUDED.sort_order, active=EXCLUDED.active, updated_at=NOW()
       RETURNING *`,
      [req.params.id, b.name, b.variation_type, b.price, b.duration_min, b.description || null, b.sort_order, b.active]
    );
    await logAction({ user: req.user, action: 'service.variation.upsert', entity: 'service', entity_id: req.params.id, meta: { variation: b.name } });
    res.json({ ok: true, variation: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.patch('/variations/:vid', WRITE, async (req, res) => {
  try {
    const cur = await pool.query(`SELECT * FROM service_variations WHERE id=$1`, [req.params.vid]);
    if (!cur.rowCount) return res.status(404).json({ error: 'not_found' });
    const old = cur.rows[0];
    const b = req.body || {};
    const sets = []; const params = [];
    for (const f of ['name', 'variation_type', 'price', 'duration_min', 'description', 'sort_order', 'active']) {
      if (b[f] !== undefined) { params.push(b[f]); sets.push(`${f}=$${params.length}`); }
    }
    if (!sets.length) return res.json({ ok: true, variation: old });
    sets.push('updated_at=NOW()'); params.push(req.params.vid);
    const r = await pool.query(`UPDATE service_variations SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`, params);
    if (b.price !== undefined && Number(b.price) !== Number(old.price)) {
      await pool.query(
        `INSERT INTO service_price_history (service_id, variation_id, old_price, new_price, changed_by, changed_by_name, reason)
         VALUES ($1,$2,$3,$4,$5,$6,'изменение цены вариации')`,
        [old.service_id, old.id, old.price, b.price, req.user?.id || null, req.user?.display_name || null]);
    }
    res.json({ ok: true, variation: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/variations/:vid', WRITE, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM service_variations WHERE id=$1 RETURNING id`, [req.params.vid]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ─────────────── 01.04 Индивидуальные цены мастеров ─────────────── */
router.get('/:id/master-prices', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT mp.*, m.name AS master_name FROM service_master_prices mp
         JOIN masters m ON m.id=mp.master_id WHERE mp.service_id=$1 ORDER BY m.name`, [req.params.id]);
    res.json({ items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/:id/master-prices', WRITE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.master_id) return res.status(400).json({ error: 'master_id required' });
    const r = await pool.query(
      `INSERT INTO service_master_prices (service_id, master_id, price, duration_min, active)
       VALUES ($1,$2,$3,$4,COALESCE($5,TRUE))
       ON CONFLICT (service_id, master_id) DO UPDATE SET
         price=EXCLUDED.price, duration_min=EXCLUDED.duration_min, active=EXCLUDED.active, updated_at=NOW()
       RETURNING *`,
      [req.params.id, b.master_id, b.price ?? null, b.duration_min ?? null, b.active]);
    await logAction({ user: req.user, action: 'service.master_price.upsert', entity: 'service', entity_id: req.params.id, meta: { master_id: b.master_id } });
    res.json({ ok: true, master_price: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/master-prices/:mpid', WRITE, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM service_master_prices WHERE id=$1 RETURNING id`, [req.params.mpid]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ─────────────── 01.05 Комплексы (создание/правка) ─────────────── */
async function recalcComboDuration(comboId) {
  await pool.query(
    `UPDATE service_combos SET total_duration = COALESCE((
        SELECT SUM(COALESCE(v.duration_min, s.duration_min))
          FROM service_combo_items ci
          JOIN services s ON s.id=ci.service_id
     LEFT JOIN service_variations v ON v.id=ci.variation_id
         WHERE ci.combo_id=$1), 0), updated_at=NOW()
      WHERE id=$1`, [comboId]);
}

router.post('/combos', WRITE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || b.combo_price == null) return res.status(400).json({ error: 'name, combo_price required' });
    const slug = await uniqueSlug(b.slug || b.name, 'service_combos');
    const r = await pool.query(
      `INSERT INTO service_combos (name, slug, description, combo_price, photo_url, status, valid_from, valid_until, max_sales, sort_order)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'active'),$7,$8,$9,COALESCE($10,0)) RETURNING *`,
      [b.name, slug, b.description || null, b.combo_price, b.photo_url || null, b.status,
       b.valid_from || null, b.valid_until || null, b.max_sales || null, b.sort_order]);
    await logAction({ user: req.user, action: 'service.combo.create', entity: 'combo', entity_id: r.rows[0].id, meta: { name: b.name } });
    res.json({ ok: true, combo: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.patch('/combos/:id', WRITE, async (req, res) => {
  try {
    const b = req.body || {};
    const sets = []; const params = [];
    for (const f of ['name', 'description', 'combo_price', 'photo_url', 'status', 'valid_from', 'valid_until', 'max_sales', 'sort_order']) {
      if (b[f] !== undefined) { params.push(b[f]); sets.push(`${f}=$${params.length}`); }
    }
    if (b.slug !== undefined) { params.push(await uniqueSlug(b.slug, 'service_combos', req.params.id)); sets.push(`slug=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    sets.push('updated_at=NOW()'); params.push(req.params.id);
    const r = await pool.query(`UPDATE service_combos SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`, params);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, combo: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/combos/:id', WRITE, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM service_combos WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/combos/:id/items', WRITE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.service_id) return res.status(400).json({ error: 'service_id required' });
    const r = await pool.query(
      `INSERT INTO service_combo_items (combo_id, service_id, variation_id, execution_order, allow_different_master)
       VALUES ($1,$2,$3,COALESCE($4,0),COALESCE($5,FALSE))
       ON CONFLICT (combo_id, service_id) DO UPDATE SET
         variation_id=EXCLUDED.variation_id, execution_order=EXCLUDED.execution_order,
         allow_different_master=EXCLUDED.allow_different_master
       RETURNING *`,
      [req.params.id, b.service_id, b.variation_id || null, b.execution_order, b.allow_different_master]);
    await recalcComboDuration(req.params.id);
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/combos/items/:itemId', WRITE, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM service_combo_items WHERE id=$1 RETURNING combo_id`, [req.params.itemId]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    await recalcComboDuration(r.rows[0].combo_id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ─────────────── 01.01 Групповые действия ─────────────── */
router.post('/bulk', WRITE, async (req, res) => {
  try {
    const { action, ids, category, pct } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    let r;
    if (action === 'deactivate') {
      r = await pool.query(`UPDATE services SET active=FALSE, status='inactive', updated_at=NOW() WHERE id=ANY($1) AND deleted_at IS NULL RETURNING id`, [ids]);
    } else if (action === 'activate') {
      r = await pool.query(`UPDATE services SET active=TRUE, status='active', updated_at=NOW() WHERE id=ANY($1) AND deleted_at IS NULL RETURNING id`, [ids]);
    } else if (action === 'set_category') {
      // #100: синхронизируем и FK — если имя есть в справочнике, привязываем по id
      r = await pool.query(
        `UPDATE services SET category=$2,
                category_id=(SELECT sc.id FROM service_categories sc WHERE sc.deleted_at IS NULL AND (sc.name=$2 OR sc.name_ua=$2) ORDER BY (sc.name=$2) DESC LIMIT 1),
                updated_at=NOW()
          WHERE id=ANY($1) AND deleted_at IS NULL RETURNING id`, [ids, category || null]);
    } else if (action === 'price_pct') {
      const k = 1 + (Number(pct) || 0) / 100;
      r = await pool.query(`UPDATE services SET price=ROUND(price*$2,2), updated_at=NOW() WHERE id=ANY($1) AND deleted_at IS NULL RETURNING id`, [ids, k]);
    } else {
      return res.status(400).json({ error: 'unknown action' });
    }
    await logAction({ user: req.user, action: 'service.bulk', entity: 'service', meta: { action, count: r.rowCount } });
    res.json({ ok: true, affected: r.rowCount });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
