/* ═══════════════════════════════════════════════════════
   SAL-02 — SERVICE CATEGORIES (Категории услуг)
   Иерархический справочник: дерево (parent_id + materialized_path),
   мультиязык, иконки, SEO, статус, сортировка.
   Связь с услугами по ИМЕНИ: services.category = service_categories.name.
   Переименование категории каскадно переименовывает category у услуг.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();
const WRITE = requirePerm('catalog.write');

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9а-яёіїєґ]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 180);
}

// Прямой + поддеревный счётчик услуг для набора категорий.
// Возвращает Map id -> { direct, total } по именам категорий (services.category = name).
async function buildCounts(rows) {
  if (!rows.length) return new Map();
  // прямой счётчик по имени
  const names = rows.map(r => r.name);
  const direct = await pool.query(
    `SELECT category AS name, COUNT(*)::int AS c FROM services
      WHERE deleted_at IS NULL AND active AND category = ANY($1) GROUP BY category`, [names]);
  const directMap = new Map(direct.rows.map(r => [r.name, r.c]));
  const byId = new Map(rows.map(r => [r.id, r]));
  const m = new Map();
  for (const r of rows) m.set(r.id, { direct: directMap.get(r.name) || 0, total: directMap.get(r.name) || 0 });
  // поддеревные: для каждой категории прибавляем direct всех потомков (по materialized_path)
  for (const r of rows) {
    for (const d of rows) {
      if (d.id !== r.id && d.materialized_path && d.materialized_path.startsWith(r.materialized_path + '.')) {
        m.get(r.id).total += (directMap.get(d.name) || 0);
      }
    }
  }
  return m;
}

function buildTree(rows, counts) {
  const byId = new Map();
  rows.forEach(r => byId.set(r.id, {
    id: r.id, name: r.name, name_ua: r.name_ua, name_en: r.name_en, slug: r.slug,
    icon: r.icon, photo_url: r.photo_url, parent_id: r.parent_id, depth: r.depth,
    status: r.status, sort_order: r.sort_order, materialized_path: r.materialized_path,
    services_count: counts.get(r.id)?.direct || 0,
    services_count_total: counts.get(r.id)?.total || 0,
    children: [],
  }));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) byId.get(node.parent_id).children.push(node);
    else roots.push(node);
  }
  const sortRec = arr => { arr.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)); arr.forEach(n => sortRec(n.children)); };
  sortRec(roots);
  return roots;
}

/* ─────────────── GET / — дерево или плоский список ─────────────── */
router.get('/', async (req, res) => {
  try {
    const { status, search, type } = req.query;
    const flat = req.query.flat === 'true' || req.query.flat === '1';
    const conds = ['deleted_at IS NULL'];
    const params = [];
    if (status) { params.push(status); conds.push(`status = $${params.length}`); }
    if (type) { params.push(type); conds.push(`(category_type = $${params.length} OR category_type='both')`); }
    if (search) { params.push('%' + String(search).toLowerCase() + '%'); conds.push(`LOWER(name) LIKE $${params.length}`); }
    const r = await pool.query(`SELECT * FROM service_categories WHERE ${conds.join(' AND ')} ORDER BY depth, sort_order, name`, params);
    const counts = await buildCounts(r.rows);
    if (flat) {
      const items = r.rows.map(x => ({ ...x, services_count: counts.get(x.id)?.direct || 0, services_count_total: counts.get(x.id)?.total || 0 }));
      return res.json({ items, total: items.length });
    }
    res.json({ tree: buildTree(r.rows, counts) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ─────────────── GET /public — активные, без пустых ─────────────── */
router.get('/public', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM service_categories WHERE deleted_at IS NULL AND status='active' ORDER BY depth, sort_order, name`);
    const counts = await buildCounts(r.rows);
    // скрываем категории без услуг в поддереве
    const visible = r.rows.filter(x => (counts.get(x.id)?.total || 0) > 0);
    res.json({ tree: buildTree(visible, counts) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ─────────────── GET /:id — карточка ─────────────── */
router.get('/:id', async (req, res) => {
  try {
    const c = await pool.query(`SELECT * FROM service_categories WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
    if (!c.rowCount) return res.status(404).json({ error: 'not_found' });
    const cat = c.rows[0];
    const parent = cat.parent_id ? (await pool.query(`SELECT id,name,slug FROM service_categories WHERE id=$1`, [cat.parent_id])).rows[0] : null;
    const children = (await pool.query(`SELECT id,name,slug,status,sort_order FROM service_categories WHERE parent_id=$1 AND deleted_at IS NULL ORDER BY sort_order,name`, [cat.id])).rows;
    // breadcrumbs по materialized_path
    const ids = (cat.materialized_path || String(cat.id)).split('.').map(Number);
    const bc = await pool.query(`SELECT id,name,slug FROM service_categories WHERE id=ANY($1)`, [ids]);
    const bcMap = new Map(bc.rows.map(r => [r.id, r]));
    const breadcrumbs = ids.map(i => bcMap.get(i)).filter(Boolean);
    const direct = (await pool.query(`SELECT COUNT(*)::int c FROM services WHERE deleted_at IS NULL AND active AND category=$1`, [cat.name])).rows[0].c;
    res.json({ category: cat, parent, children, breadcrumbs, services_count: direct });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ─────────────── GET /:id/breadcrumbs ─────────────── */
router.get('/:id/breadcrumbs', async (req, res) => {
  try {
    const c = await pool.query(`SELECT materialized_path,id FROM service_categories WHERE id=$1`, [req.params.id]);
    if (!c.rowCount) return res.status(404).json({ error: 'not_found' });
    const ids = (c.rows[0].materialized_path || String(c.rows[0].id)).split('.').map(Number);
    const bc = await pool.query(`SELECT id,name,slug FROM service_categories WHERE id=ANY($1)`, [ids]);
    const m = new Map(bc.rows.map(r => [r.id, r]));
    res.json({ breadcrumbs: ids.map(i => m.get(i)).filter(Boolean) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ─────────────── GET /:id/services ─────────────── */
router.get('/:id/services', async (req, res) => {
  try {
    const c = await pool.query(`SELECT * FROM service_categories WHERE id=$1`, [req.params.id]);
    if (!c.rowCount) return res.status(404).json({ error: 'not_found' });
    const cat = c.rows[0];
    let names = [cat.name];
    if (req.query.include_subcategories === 'true' || req.query.include_subcategories === '1') {
      const subs = await pool.query(`SELECT name FROM service_categories WHERE deleted_at IS NULL AND materialized_path LIKE $1`, [cat.materialized_path + '.%']);
      names = names.concat(subs.rows.map(r => r.name));
    }
    const conds = ['deleted_at IS NULL', 'category = ANY($1)'];
    const params = [names];
    if (req.query.status) { params.push(req.query.status); conds.push(`status = $${params.length}`); }
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    params.push(limit); const lp = params.length; params.push(offset); const op = params.length;
    const r = await pool.query(
      `SELECT id,name,category,price,duration_min,status FROM services WHERE ${conds.join(' AND ')} ORDER BY name LIMIT $${lp} OFFSET $${op}`, params);
    const cr = await pool.query(`SELECT COUNT(*)::int total FROM services WHERE ${conds.join(' AND ')}`, params.slice(0, params.length - 2));
    res.json({ items: r.rows, total: cr.rows[0].total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ─────────────── POST / — создать ─────────────── */
router.post('/', WRITE, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name required' });
    const dup = await pool.query(`SELECT 1 FROM service_categories WHERE LOWER(name)=LOWER($1) AND deleted_at IS NULL`, [b.name]);
    if (dup.rowCount) return res.status(409).json({ error: 'name_exists' });
    let depth = 0, parentPath = null;
    if (b.parent_id) {
      const p = await pool.query(`SELECT depth,materialized_path FROM service_categories WHERE id=$1 AND deleted_at IS NULL`, [b.parent_id]);
      if (!p.rowCount) return res.status(400).json({ error: 'parent_not_found' });
      if (p.rows[0].depth >= 10) return res.status(400).json({ error: 'max_depth' });
      depth = p.rows[0].depth + 1; parentPath = p.rows[0].materialized_path;
    }
    const r = await pool.query(
      `INSERT INTO service_categories (parent_id, name, name_ua, name_en, slug, description, icon, photo_url,
        category_type, depth, sort_order, status, meta_title, meta_description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'services'),$10,COALESCE($11,0),COALESCE($12,'active'),$13,$14)
       RETURNING *`,
      [b.parent_id || null, b.name, b.name_ua || null, b.name_en || null, slugify(b.slug || b.name), b.description || null,
       b.icon || null, b.photo_url || null, b.category_type, depth, b.sort_order, b.status, b.meta_title || null, b.meta_description || null]);
    const cat = r.rows[0];
    const path = parentPath ? `${parentPath}.${cat.id}` : String(cat.id);
    await pool.query(`UPDATE service_categories SET materialized_path=$1 WHERE id=$2`, [path, cat.id]);
    cat.materialized_path = path;
    await logAction({ user: req.user, action: 'category.create', entity: 'service_category', entity_id: cat.id, meta: { name: b.name } });
    res.json({ ok: true, category: cat });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ─────────────── PATCH /reorder — пакетная сортировка (ДО /:id!) ─────────────── */
router.patch('/reorder', WRITE, async (req, res) => {
  try {
    const items = (req.body || {}).items || [];
    for (const it of items) {
      if (it.id != null && it.sort_order != null) await pool.query(`UPDATE service_categories SET sort_order=$1, updated_at=NOW() WHERE id=$2`, [it.sort_order, it.id]);
    }
    res.json({ ok: true, updated: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ─────────────── PATCH /:id — обновить (каскадное переименование) ─────────────── */
router.patch('/:id', WRITE, async (req, res) => {
  try {
    const id = req.params.id;
    const cur = await pool.query(`SELECT * FROM service_categories WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'not_found' });
    const old = cur.rows[0];
    const b = req.body || {};

    // смена родителя — отдельной логикой пересчёта поддерева
    if (b.parent_id !== undefined && Number(b.parent_id || 0) !== Number(old.parent_id || 0)) {
      await moveCategory(id, b.parent_id || null, b.sort_order);
    }

    const sets = []; const params = [];
    const setCol = (c, v) => { params.push(v); sets.push(`${c}=$${params.length}`); };
    for (const f of ['name_ua', 'name_en', 'description', 'icon', 'photo_url', 'category_type', 'sort_order', 'status', 'meta_title', 'meta_description']) {
      if (b[f] !== undefined) setCol(f, b[f]);
    }
    if (b.slug !== undefined) setCol('slug', slugify(b.slug));

    let renamed = 0;
    if (b.name !== undefined && b.name !== old.name) {
      const dup = await pool.query(`SELECT 1 FROM service_categories WHERE LOWER(name)=LOWER($1) AND id<>$2 AND deleted_at IS NULL`, [b.name, id]);
      if (dup.rowCount) return res.status(409).json({ error: 'name_exists' });
      setCol('name', b.name);
      // каскад: услуги, привязанные по старому имени → новое имя
      const rn = await pool.query(`UPDATE services SET category=$1, updated_at=NOW() WHERE category=$2 AND deleted_at IS NULL`, [b.name, old.name]);
      renamed = rn.rowCount;
    }
    if (sets.length) {
      sets.push('updated_at=NOW()'); params.push(id);
      await pool.query(`UPDATE service_categories SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
    }
    const out = await pool.query(`SELECT * FROM service_categories WHERE id=$1`, [id]);
    await logAction({ user: req.user, action: 'category.update', entity: 'service_category', entity_id: id, meta: { fields: Object.keys(b), renamed_services: renamed } });
    res.json({ ok: true, category: out.rows[0], renamed_services: renamed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Пересчёт materialized_path/depth для категории и всего поддерева
async function moveCategory(id, newParentId, newSortOrder) {
  const cur = (await pool.query(`SELECT * FROM service_categories WHERE id=$1`, [id])).rows[0];
  if (!cur) throw new Error('not_found');
  let newDepth = 0, newParentPath = null;
  if (newParentId) {
    const p = (await pool.query(`SELECT depth,materialized_path FROM service_categories WHERE id=$1 AND deleted_at IS NULL`, [newParentId])).rows[0];
    if (!p) throw new Error('parent_not_found');
    // защита от перемещения в собственного потомка
    if (p.materialized_path === cur.materialized_path || p.materialized_path.startsWith(cur.materialized_path + '.'))
      throw new Error('cannot_move_into_descendant');
    newDepth = p.depth + 1; newParentPath = p.materialized_path;
  }
  const oldPath = cur.materialized_path;
  const newPath = newParentPath ? `${newParentPath}.${id}` : String(id);
  const depthDelta = newDepth - cur.depth;
  // сам узел
  await pool.query(`UPDATE service_categories SET parent_id=$1, depth=$2, materialized_path=$3, sort_order=COALESCE($4,sort_order), updated_at=NOW() WHERE id=$5`,
    [newParentId || null, newDepth, newPath, newSortOrder, id]);
  // поддерево: заменяем префикс пути и сдвигаем depth
  await pool.query(
    `UPDATE service_categories
        SET materialized_path = $1 || substring(materialized_path from char_length($2)+1),
            depth = depth + $3, updated_at=NOW()
      WHERE materialized_path LIKE $2 || '.%'`,
    [newPath, oldPath, depthDelta]);
}

/* ─────────────── POST /:id/move ─────────────── */
router.post('/:id/move', WRITE, async (req, res) => {
  try {
    const b = req.body || {};
    await moveCategory(req.params.id, b.new_parent_id || null, b.new_sort_order);
    await logAction({ user: req.user, action: 'category.move', entity: 'service_category', entity_id: req.params.id, meta: b });
    res.json({ ok: true });
  } catch (e) {
    const code = ['cannot_move_into_descendant', 'parent_not_found', 'max_depth'].includes(e.message) ? 400 : 500;
    res.status(code).json({ error: e.message });
  }
});

/* ─────────────── DELETE /:id — soft, с проверками ─────────────── */
router.delete('/:id', WRITE, async (req, res) => {
  try {
    const id = req.params.id;
    const cur = await pool.query(`SELECT * FROM service_categories WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'not_found' });
    const ch = await pool.query(`SELECT COUNT(*)::int c FROM service_categories WHERE parent_id=$1 AND deleted_at IS NULL`, [id]);
    if (ch.rows[0].c > 0) return res.status(409).json({ error: 'has_children', count: ch.rows[0].c });
    const svc = await pool.query(`SELECT COUNT(*)::int c FROM services WHERE category=$1 AND deleted_at IS NULL`, [cur.rows[0].name]);
    if (svc.rows[0].c > 0) return res.status(409).json({ error: 'has_services', count: svc.rows[0].c });
    await pool.query(`UPDATE service_categories SET deleted_at=NOW(), status='hidden', updated_at=NOW() WHERE id=$1`, [id]);
    await logAction({ user: req.user, action: 'category.delete', entity: 'service_category', entity_id: id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
