/* routes/kb.js — MGT-03 База знань (внутрішня Wiki салону).
   Категорії-дерево, статті (Markdown) з версіонуванням і відкатом, повнотекстовий пошук (Postgres FTS),
   обовʼязкове читання з обліком прочитань, фідбек (корисно/ні), закріплені/популярні/останні.
   Прагматика під один салон. Доступ: GET=kb.read, мутації=kb.write. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

const STATUSES = ['draft', 'review', 'published', 'archived'];

// Підтвердження прочитання і фідбек доступні читачам (kb.read), решта мутацій — kb.write
const READ_LEVEL_POST = /\/articles\/\d+\/(read|feedback)$/;
router.use((req, res, next) => {
  const perm = (req.method === 'GET' || READ_LEVEL_POST.test(req.path)) ? 'kb.read' : 'kb.write';
  return requirePerm(perm)(req, res, next);
});

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9а-яіїєґё]+/giu, '-')
    .replace(/^-+|-+$/g, '').slice(0, 200) || ('article-' + Date.now());
}
function normTags(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(t => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}
function excerptOf(content, given) {
  if (given) return String(given).slice(0, 500);
  return String(content || '').replace(/[#*_>`\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 280);
}
// Авто-зміст по Markdown-заголовках
function tocOf(content) {
  const toc = [];
  for (const line of String(content || '').split('\n')) {
    const m = line.match(/^(#{1,4})\s+(.+)$/);
    if (m) toc.push({ level: m[1].length, text: m[2].trim(), anchor: slugify(m[2]) });
  }
  return toc;
}
async function uniqueSlug(base, excludeId) {
  let slug = base, i = 1;
  while (true) {
    const ex = await q(`SELECT id FROM kb_articles WHERE tenant_id=current_tenant_id() AND slug=$1 AND ($2::bigint IS NULL OR id<>$2)`, [slug, excludeId || null]);
    if (!ex.length) return slug;
    slug = base + '-' + (++i);
  }
}

// ════ КАТЕГОРІЇ ════
router.get('/categories', async (req, res) => {
  try {
    const rows = await q(
      `SELECT c.*, (SELECT COUNT(*) FROM kb_articles a WHERE a.category_id=c.id AND a.tenant_id=current_tenant_id() AND a.status='published')::int articles_count
       FROM kb_categories c WHERE c.tenant_id=current_tenant_id() ORDER BY c.sort_order, c.name`);
    // будуємо дерево
    const byId = {}; rows.forEach(c => { c.children = []; byId[c.id] = c; });
    const tree = [];
    rows.forEach(c => { if (c.parent_id && byId[c.parent_id]) byId[c.parent_id].children.push(c); else tree.push(c); });
    res.json({ ok: true, categories: tree, flat: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/categories', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ ok: false, error: 'name required' });
    const ins = await q(
      `INSERT INTO kb_categories (parent_id, name, slug, description, icon, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.parent_id || null, b.name, slugify(b.slug || b.name), b.description || null, b.icon || null, b.sort_order || 0]);
    res.json({ ok: true, category: ins[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.put('/categories/:id(\\d+)', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], p = [];
    const set = (c, v) => { p.push(v); sets.push(`${c} = $${p.length}`); };
    if (b.name !== undefined) set('name', b.name);
    if (b.slug !== undefined) set('slug', slugify(b.slug));
    if (b.description !== undefined) set('description', b.description);
    if (b.icon !== undefined) set('icon', b.icon);
    if (b.sort_order !== undefined) set('sort_order', b.sort_order);
    if (b.parent_id !== undefined) set('parent_id', b.parent_id || null);
    if (b.active !== undefined) set('active', !!b.active);
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nothing to update' });
    sets.push('updated_at=NOW()'); p.push(req.params.id);
    const upd = await q(`UPDATE kb_categories SET ${sets.join(', ')} WHERE id=$${p.length} AND tenant_id=current_tenant_id() RETURNING *`, p);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, category: upd[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.delete('/categories/:id(\\d+)', async (req, res) => {
  try {
    const del = await q(`DELETE FROM kb_categories WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [req.params.id]);
    if (!del.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════ СТАТТІ ════
// GET /articles ?category_id=&tag=&status=&q=&pinned=1&mandatory=1&author_id=&limit=&offset=
router.get('/articles', async (req, res) => {
  try {
    const w = ['tenant_id = current_tenant_id()']; const p = [];
    const add = (cond, val) => { p.push(val); w.push(cond.replace('?', '$' + p.length)); };
    if (req.query.category_id) add('category_id = ?', Number(req.query.category_id));
    if (req.query.status) add('status = ?', req.query.status);
    else w.push("status <> 'archived'");
    if (req.query.author_id) add('author_id = ?', Number(req.query.author_id));
    if (req.query.tag) add('tags @> ARRAY[?]::text[]', String(req.query.tag).toLowerCase());
    if (req.query.pinned === '1') w.push('is_pinned = true');
    if (req.query.mandatory === '1') w.push('is_mandatory = true');
    let rank = '';
    if (req.query.q) {
      p.push(req.query.q);
      w.push(`search_tsv @@ plainto_tsquery('simple', $${p.length})`);
      rank = `, ts_rank(search_tsv, plainto_tsquery('simple', $${p.length})) rank`;
    }
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const offset = Number(req.query.offset) || 0;
    p.push(limit); const li = p.length; p.push(offset); const oi = p.length;
    const order = req.query.q ? 'rank DESC, is_pinned DESC' : 'is_pinned DESC, updated_at DESC';
    const rows = await q(
      `SELECT id, category_id, author_name, title, slug, excerpt, status, version, is_pinned,
        is_mandatory, tags, views_count, helpful_count, not_helpful_count, published_at, updated_at${rank}
       FROM kb_articles WHERE ${w.join(' AND ')} ORDER BY ${order} LIMIT $${li} OFFSET $${oi}`, p);
    res.json({ ok: true, articles: rows, count: rows.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Останні оновлення / популярні
router.get('/recent', async (req, res) => {
  try {
    const rows = await q(`SELECT id,title,slug,author_name,updated_at,category_id FROM kb_articles WHERE tenant_id=current_tenant_id() AND status='published' ORDER BY updated_at DESC LIMIT 10`);
    res.json({ ok: true, articles: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/popular', async (req, res) => {
  try {
    const rows = await q(`SELECT id,title,slug,views_count,category_id FROM kb_articles WHERE tenant_id=current_tenant_id() AND status='published' ORDER BY views_count DESC LIMIT 10`);
    res.json({ ok: true, articles: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Мої непрочитані обовʼязкові
router.get('/my/unread', async (req, res) => {
  try {
    const uid = req.user?.id || null;
    const rows = await q(
      `SELECT a.id,a.title,a.slug,a.category_id FROM kb_articles a
       WHERE a.tenant_id=current_tenant_id() AND a.status='published' AND a.is_mandatory=true
        AND NOT EXISTS (SELECT 1 FROM kb_article_reads r WHERE r.article_id=a.id AND r.tenant_id=current_tenant_id() AND r.employee_id=$1 AND r.confirmed=true)
       ORDER BY a.updated_at DESC`, [uid]);
    res.json({ ok: true, unread: rows, count: rows.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Картка статті (інкремент переглядів + зміст)
router.get('/articles/:id(\\d+)', async (req, res) => {
  try {
    const upd = await q(`UPDATE kb_articles SET views_count=views_count+1 WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING *`, [req.params.id]);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found' });
    const a = upd[0];
    let category = null;
    if (a.category_id) category = (await q(`SELECT id,name,slug,parent_id FROM kb_categories WHERE id=$1 AND tenant_id=current_tenant_id()`, [a.category_id]))[0] || null;
    res.json({ ok: true, article: a, toc: tocOf(a.content), category });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/articles', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ ok: false, error: 'title required' });
    const status = STATUSES.includes(b.status) ? b.status : 'draft';
    const slug = await uniqueSlug(slugify(b.slug || b.title));
    const ins = await q(
      `INSERT INTO kb_articles (category_id, author_id, author_name, title, slug, content, excerpt,
         status, is_pinned, is_mandatory, access_roles, tags, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $8='published' THEN NOW() ELSE NULL END) RETURNING *`,
      [b.category_id || null, req.user?.id || null, req.user?.display_name || null, b.title, slug,
       b.content || '', excerptOf(b.content, b.excerpt), status, !!b.is_pinned, !!b.is_mandatory,
       b.access_roles ? JSON.stringify(b.access_roles) : null, normTags(b.tags)]);
    logAction({ user: req.user, action: 'kb.article.create', entity: 'kb_article', entity_id: ins[0].id, ip: req.ip, meta: { title: b.title, status } }).catch(() => {});
    res.json({ ok: true, article: ins[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Оновлення (зміна content/title → нова версія в історії)
router.put('/articles/:id(\\d+)', async (req, res) => {
  try {
    const b = req.body || {};
    const cur = (await q(`SELECT * FROM kb_articles WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!cur) return res.status(404).json({ ok: false, error: 'not found' });
    const contentChanged = (b.content !== undefined && b.content !== cur.content) || (b.title !== undefined && b.title !== cur.title);
    // Зберігаємо попередню версію перед зміною контенту
    if (contentChanged) {
      await q(`INSERT INTO kb_versions (article_id, version_number, title, content, change_summary, author_name)
               VALUES ($1,$2,$3,$4,$5,$6)`,
        [cur.id, cur.version, cur.title, cur.content, b.change_summary || null, cur.author_name]);
    }
    const sets = [], p = [];
    const set = (c, v) => { p.push(v); sets.push(`${c} = $${p.length}`); };
    if (b.title !== undefined) set('title', b.title);
    if (b.content !== undefined) { set('content', b.content); set('excerpt', excerptOf(b.content, b.excerpt)); }
    else if (b.excerpt !== undefined) set('excerpt', excerptOf(cur.content, b.excerpt));
    if (b.category_id !== undefined) set('category_id', b.category_id || null);
    if (b.is_pinned !== undefined) set('is_pinned', !!b.is_pinned);
    if (b.is_mandatory !== undefined) set('is_mandatory', !!b.is_mandatory);
    if (b.access_roles !== undefined) set('access_roles', b.access_roles ? JSON.stringify(b.access_roles) : null);
    if (b.tags !== undefined) set('tags', normTags(b.tags));
    if (b.slug !== undefined) set('slug', await uniqueSlug(slugify(b.slug), cur.id));
    if (contentChanged) set('version', cur.version + 1);
    if (b.status !== undefined && STATUSES.includes(b.status)) {
      set('status', b.status);
      if (b.status === 'published' && !cur.published_at) set('published_at', new Date());
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nothing to update' });
    sets.push('updated_at=NOW()'); p.push(req.params.id);
    const upd = await q(`UPDATE kb_articles SET ${sets.join(', ')} WHERE id=$${p.length} AND tenant_id=current_tenant_id() RETURNING *`, p);
    logAction({ user: req.user, action: 'kb.article.update', entity: 'kb_article', entity_id: cur.id, ip: req.ip, meta: { version: contentChanged ? cur.version + 1 : cur.version } }).catch(() => {});
    res.json({ ok: true, article: upd[0], new_version: contentChanged });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/articles/:id(\\d+)/status', async (req, res) => {
  try {
    const status = req.body?.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ ok: false, error: 'bad status' });
    const upd = await q(
      `UPDATE kb_articles SET status=$1, published_at = CASE WHEN $1='published' AND published_at IS NULL THEN NOW() ELSE published_at END, updated_at=NOW()
       WHERE id=$2 AND tenant_id=current_tenant_id() RETURNING *`, [status, req.params.id]);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, article: upd[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/articles/:id(\\d+)', async (req, res) => {
  try {
    const del = await q(`DELETE FROM kb_articles WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [req.params.id]);
    if (!del.length) return res.status(404).json({ ok: false, error: 'not found' });
    logAction({ user: req.user, action: 'kb.article.delete', entity: 'kb_article', entity_id: Number(req.params.id), ip: req.ip, meta: {} }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════ ВЕРСІЇ ════
router.get('/articles/:id(\\d+)/versions', async (req, res) => {
  try {
    const rows = await q(`SELECT id,version_number,title,change_summary,author_name,created_at FROM kb_versions WHERE article_id=$1 AND tenant_id=current_tenant_id() ORDER BY version_number DESC`, [req.params.id]);
    res.json({ ok: true, versions: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/versions/:vid(\\d+)', async (req, res) => {
  try {
    const v = (await q(`SELECT * FROM kb_versions WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.vid]))[0];
    if (!v) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, version: v });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Відкат до версії (зберігає поточну в історію, ставить контент зі старої)
router.post('/articles/:id(\\d+)/revert/:vid(\\d+)', async (req, res) => {
  try {
    const cur = (await q(`SELECT * FROM kb_articles WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!cur) return res.status(404).json({ ok: false, error: 'article not found' });
    const v = (await q(`SELECT * FROM kb_versions WHERE id=$1 AND article_id=$2 AND tenant_id=current_tenant_id()`, [req.params.vid, req.params.id]))[0];
    if (!v) return res.status(404).json({ ok: false, error: 'version not found' });
    await q(`INSERT INTO kb_versions (article_id, version_number, title, content, change_summary, author_name)
             VALUES ($1,$2,$3,$4,$5,$6)`,
      [cur.id, cur.version, cur.title, cur.content, 'before revert to v' + v.version_number, cur.author_name]);
    const upd = await q(
      `UPDATE kb_articles SET title=$1, content=$2, excerpt=$3, version=version+1, updated_at=NOW()
       WHERE id=$4 AND tenant_id=current_tenant_id() RETURNING *`,
      [v.title, v.content, excerptOf(v.content), req.params.id]);
    logAction({ user: req.user, action: 'kb.article.revert', entity: 'kb_article', entity_id: cur.id, ip: req.ip, meta: { to_version: v.version_number } }).catch(() => {});
    res.json({ ok: true, article: upd[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════ ОБОВʼЯЗКОВЕ ЧИТАННЯ ════
router.post('/articles/:id(\\d+)/read', async (req, res) => {
  try {
    const a = (await q(`SELECT id FROM kb_articles WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!a) return res.status(404).json({ ok: false, error: 'not found' });
    const confirmed = req.body?.confirmed !== false;
    const ins = await q(
      `INSERT INTO kb_article_reads (article_id, employee_id, employee_name, confirmed)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (article_id, employee_id) DO UPDATE SET confirmed=EXCLUDED.confirmed, read_at=NOW()
       RETURNING *`,
      [req.params.id, req.user?.id || null, req.user?.display_name || null, confirmed]);
    res.json({ ok: true, read: ins[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/articles/:id(\\d+)/reads', async (req, res) => {
  try {
    const rows = await q(`SELECT employee_id, employee_name, confirmed, read_at FROM kb_article_reads WHERE article_id=$1 AND tenant_id=current_tenant_id() ORDER BY read_at DESC`, [req.params.id]);
    res.json({ ok: true, reads: rows, count: rows.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════ ФІДБЕК ════
router.post('/articles/:id(\\d+)/feedback', async (req, res) => {
  try {
    const helpful = req.body?.helpful;
    const col = helpful === true ? 'helpful_count' : helpful === false ? 'not_helpful_count' : null;
    if (!col) return res.status(400).json({ ok: false, error: 'helpful boolean required' });
    const upd = await q(`UPDATE kb_articles SET ${col}=${col}+1 WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING helpful_count, not_helpful_count`, [req.params.id]);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, ...upd[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
