/* ═══════════════════════════════════════════════════════
   MKT-04 — Сегментация: HTTP API
   Подключается как /api/segments
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const seg = require('../lib/segments');

// Справочник полей и операторов для конструктора
router.get('/schema', requirePerm('reports.read'), (req, res) => {
  res.json({
    fields: Object.keys(seg.FIELDS).map(k => ({ key: k, type: seg.FIELDS[k].type })),
    operators: seg.OPS,
    presets: Object.entries(seg.PRESETS).map(([key, v]) => ({ key, name: v.name })),
  });
});

// Предустановленные сегменты с живым подсчётом
router.get('/presets', requirePerm('reports.read'), async (req, res) => {
  try {
    const out = [];
    for (const [key, v] of Object.entries(seg.PRESETS)) {
      const count = await seg.countSegment({ type: 'preset', preset_key: key });
      out.push({ key, name: v.name, count });
    }
    res.json({ items: out });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Превью произвольных правил: сколько клиентов попадёт
router.post('/preview', requirePerm('reports.read'), async (req, res) => {
  try {
    const count = await seg.previewRules(req.body?.rules || {});
    const total = (await getPool().query(`SELECT count(*)::int c FROM clients`)).rows[0].c;
    res.json({ ok: true, count, total });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Список сохранённых сегментов
router.get('/', requirePerm('reports.read'), async (req, res) => {
  try {
    const r = await getPool().query(`SELECT * FROM segments ORDER BY created_at DESC`);
    res.json({ items: r.rows, count: r.rowCount });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Члены сегмента (по id или preset:key)
router.get('/:id/members', requirePerm('reports.read'), async (req, res) => {
  try {
    const segment = await loadSegment(req.params.id);
    if (!segment) return res.status(404).json({ error: 'not-found' });
    const members = await seg.membersOf(segment, { limit: Math.min(parseInt(req.query.limit, 10) || 1000, 5000) });
    res.json({ items: members, count: members.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Создать сегмент
router.post('/', requirePerm('promo.write'), async (req, res) => {
  try {
    const { name, description, type = 'dynamic', preset_key, rules } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name-required' });
    if (type === 'dynamic') { try { seg.compileRules(rules || {}); } catch (e) { return res.status(400).json({ error: 'bad-rules:' + e.message }); } }
    const r = await getPool().query(
      `INSERT INTO segments(name, description, type, preset_key, rules, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, description || null, type, preset_key || null, JSON.stringify(rules || {}), req.user?.id || null]);
    res.json({ ok: true, segment: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Обновить / пересчитать кэш количества
router.patch('/:id', requirePerm('promo.write'), async (req, res) => {
  try {
    const pool = getPool();
    const { name, description, rules } = req.body || {};
    if (rules) { try { seg.compileRules(rules); } catch (e) { return res.status(400).json({ error: 'bad-rules:' + e.message }); } }
    const sets = [], args = [];
    if (name != null) { args.push(name); sets.push(`name=$${args.length}`); }
    if (description != null) { args.push(description); sets.push(`description=$${args.length}`); }
    if (rules != null) { args.push(JSON.stringify(rules)); sets.push(`rules=$${args.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing-to-update' });
    args.push(req.params.id);
    const r = await pool.query(`UPDATE segments SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${args.length} RETURNING *`, args);
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, segment: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Пересчитать member_count
router.post('/:id/recalc', requirePerm('promo.write'), async (req, res) => {
  try {
    const segment = await loadSegment(req.params.id);
    if (!segment) return res.status(404).json({ error: 'not-found' });
    const count = await seg.countSegment(segment);
    if (segment.id) await getPool().query(`UPDATE segments SET member_count=$1, recalc_at=NOW() WHERE id=$2`, [count, segment.id]);
    res.json({ ok: true, count });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', requirePerm('promo.write'), async (req, res) => {
  try {
    const r = await getPool().query(`DELETE FROM segments WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Управление статическими сегментами
router.post('/:id/members', requirePerm('promo.write'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.client_ids) ? req.body.client_ids : [];
    if (!ids.length) return res.status(400).json({ error: 'client_ids-required' });
    const pool = getPool();
    // пакетная вставка одним запросом (было N+1: по запросу на каждого клиента)
    const cleanIds = ids.map(Number).filter(Number.isInteger);
    await pool.query(
      `INSERT INTO segment_members(segment_id, client_id)
       SELECT $1, x FROM unnest($2::int[]) AS x
       ON CONFLICT DO NOTHING`,
      [req.params.id, cleanIds]
    );
    res.json({ ok: true, added: cleanIds.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

async function loadSegment(idOrPreset) {
  if (String(idOrPreset).startsWith('preset:')) {
    const key = String(idOrPreset).slice(7);
    return seg.PRESETS[key] ? { type: 'preset', preset_key: key } : null;
  }
  const r = await getPool().query(`SELECT * FROM segments WHERE id=$1`, [idOrPreset]);
  return r.rows[0] || null;
}

module.exports = router;
module.exports.loadSegment = loadSegment;
