/* routes/medical.js — SAL-10 Медичні карти клієнтів.
   Алергії, протипоказання, хронічні хвороби, ліки; тести на алергію (patch test) з перевіркою чинності;
   інформовані згоди з підписом + відкликання; історія формул фарбування (версійність, пошук);
   warnings-перевірка перед процедурою (блокери/попередження/потрібен тест/потрібна згода); аудит доступу.
   Прагматика під один салон. Доступ: GET=medical.read, мутації=medical.write, видалення картки=medical.delete. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, hasPermission, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const num = (v) => (v == null || v === '' ? null : Number(v));
const jb = (v) => (v == null ? null : JSON.stringify(v));

// послуги, що вимагають patch-test (хімічне фарбування/хімія)
const COLOR_RE = /фарб|покрас|окраш|колор|color|тонуван|airtouch|air\s*touch|шатуш|балаяж|мелірув|освітл|хімі|перманент|ботокс|кератин/i;
const SEVERE = ['severe', 'anaphylaxis'];

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'medical.read' : 'medical.write';
  return requirePerm(perm)(req, res, next);
});

function logAccess(req, cardId, clientId, action, fields) {
  q(`INSERT INTO medical_access_log (medical_card_id, client_id, accessed_by, accessed_by_name, action, fields_accessed, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [cardId || null, clientId || null, req.user?.id ?? null, req.user?.display_name || null, action, fields || null, req.ip || null]).catch(() => {});
}

// ════════════ МЕДКАРТА ════════════
router.get('/cards/warnings/:client_id(\\d+)', async (req, res) => {
  try {
    const clientId = Number(req.params.client_id);
    const card = (await q(`SELECT * FROM medical_cards WHERE client_id=$1 AND tenant_id=current_tenant_id()`, [clientId]))[0];
    const warnings = [], blockers = [];
    let needs_test = false, needs_consent = false, service_name = null, is_coloring = false;
    if (req.query.service_id) {
      const s = (await q(`SELECT name FROM services WHERE id=$1`, [Number(req.query.service_id)]))[0];
      service_name = s?.name || null;
      is_coloring = service_name ? COLOR_RE.test(service_name) : false;
    }
    if (!card) {
      if (is_coloring) { needs_test = true; warnings.push({ type: 'no_card', severity: 'info', message: 'Медкарти немає — створіть перед хімічною процедурою' }); }
      return res.json({ ok: true, has_card: false, warnings, blockers, needs_test, needs_consent });
    }
    // алергії
    for (const a of (card.allergies || [])) {
      const sev = a.severity || 'moderate';
      const msg = `Алергія: ${a.allergen}${a.notes ? ' — ' + a.notes : ''}`;
      if (SEVERE.includes(sev)) blockers.push({ type: 'allergy', severity: sev, message: msg });
      else warnings.push({ type: 'allergy', severity: sev, message: msg });
    }
    // активні протипоказання
    for (const c of (card.contraindications || [])) {
      if (c.active === false) continue;
      blockers.push({ type: 'contraindication', severity: 'high', message: `Протипоказання: ${c.condition}${c.notes ? ' — ' + c.notes : ''}` });
    }
    // потрібен тест на алергію для фарбування
    if (is_coloring) {
      const t = (await q(`SELECT id, valid_until, final_result FROM allergy_tests
        WHERE client_id=$1 AND tenant_id=current_tenant_id() AND final_result='negative'
          AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
        ORDER BY applied_at DESC LIMIT 1`, [clientId]))[0];
      if (!t) { needs_test = true; warnings.push({ type: 'patch_test', severity: 'warning', message: 'Немає чинного негативного тесту на алергію для фарбування' }); }
    }
    // картка застаріла
    if (card.status === 'needs_update' || (card.last_reviewed_at && (Date.now() - new Date(card.last_reviewed_at)) > 365 * 86400e3)) {
      warnings.push({ type: 'card_stale', severity: 'info', message: 'Медкарту не оновлювали понад 12 місяців' });
    }
    logAccess(req, card.id, clientId, 'view', ['warnings']);
    res.json({ ok: true, has_card: true, card_id: card.id, status: card.status, warnings, blockers, needs_test, needs_consent });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/cards/:client_id(\\d+)/export', async (req, res) => {
  try {
    if (!hasPermission(req.user.permissions, 'medical.delete') && !hasPermission(req.user.permissions, 'medical.export')) {
      // експорт = чутлива дія; дозволяємо admin (має medical.delete). Інакше 403
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    const clientId = Number(req.params.client_id);
    const card = (await q(`SELECT * FROM medical_cards WHERE client_id=$1 AND tenant_id=current_tenant_id()`, [clientId]))[0];
    if (!card) return res.status(404).json({ ok: false, error: 'not found' });
    const [tests, consents, formulas] = await Promise.all([
      q(`SELECT * FROM allergy_tests WHERE client_id=$1 AND tenant_id=current_tenant_id() ORDER BY applied_at DESC`, [clientId]),
      q(`SELECT * FROM procedure_consents WHERE client_id=$1 AND tenant_id=current_tenant_id() ORDER BY signed_at DESC`, [clientId]),
      q(`SELECT * FROM coloring_formulas WHERE client_id=$1 AND tenant_id=current_tenant_id() ORDER BY formula_date DESC`, [clientId]),
    ]);
    logAccess(req, card.id, clientId, 'export', ['full']);
    res.json({ ok: true, exported_at: new Date().toISOString(), card, allergy_tests: tests, consents, coloring_formulas: formulas });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/cards/:client_id(\\d+)', async (req, res) => {
  try {
    const clientId = Number(req.params.client_id);
    const card = (await q(`SELECT * FROM medical_cards WHERE client_id=$1 AND tenant_id=current_tenant_id()`, [clientId]))[0];
    if (!card) return res.status(404).json({ ok: false, error: 'not found', has_card: false });
    const [tests, consents, fcount, last] = await Promise.all([
      q(`SELECT * FROM allergy_tests WHERE client_id=$1 AND tenant_id=current_tenant_id() ORDER BY applied_at DESC LIMIT 20`, [clientId]),
      q(`SELECT * FROM procedure_consents WHERE client_id=$1 AND tenant_id=current_tenant_id() AND status='active' ORDER BY signed_at DESC`, [clientId]),
      q(`SELECT COUNT(*)::int n FROM coloring_formulas WHERE client_id=$1 AND tenant_id=current_tenant_id()`, [clientId]),
      q(`SELECT * FROM coloring_formulas WHERE client_id=$1 AND tenant_id=current_tenant_id() AND is_current=true ORDER BY formula_date DESC LIMIT 1`, [clientId]),
    ]);
    logAccess(req, card.id, clientId, 'view', ['card']);
    res.json({ ok: true, has_card: true, card, allergy_tests: tests, active_consents: consents, formulas_count: fcount[0].n, last_formula: last[0] || null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/cards', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.client_id) return res.status(400).json({ ok: false, error: 'client_id required' });
    const exists = (await q(`SELECT id FROM medical_cards WHERE client_id=$1 AND tenant_id=current_tenant_id()`, [Number(b.client_id)]))[0];
    if (exists) return res.status(409).json({ ok: false, error: 'card already exists', card_id: exists.id });
    const ins = await q(
      `INSERT INTO medical_cards (client_id, blood_type, skin_phototype, skin_type, hair_condition, allergies, contraindications,
        chronic_conditions, current_medications, emergency_contact_name, emergency_contact_phone, cosmetology_anamnesis, treatment_plan,
        home_care_notes, created_by, last_reviewed_at, reviewed_by, reviewed_by_name)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::jsonb,'[]'),COALESCE($7::jsonb,'[]'),COALESCE($8::jsonb,'[]'),COALESCE($9::jsonb,'[]'),$10,$11,$12::jsonb,$13::jsonb,$14,$15,NOW(),$15,$16) RETURNING *`,
      [Number(b.client_id), b.blood_type || null, num(b.skin_phototype), b.skin_type || null, b.hair_condition || null,
       jb(b.allergies), jb(b.contraindications), jb(b.chronic_conditions), jb(b.current_medications),
       b.emergency_contact_name || null, b.emergency_contact_phone || null, jb(b.cosmetology_anamnesis), jb(b.treatment_plan),
       b.home_care_notes || null, req.user?.id ?? null, req.user?.display_name || null]);
    logAccess(req, ins[0].id, Number(b.client_id), 'edit', ['create']);
    logAction({ user: req.user, action: 'medical.card.create', entity: 'medical_card', entity_id: ins[0].id, ip: req.ip, meta: { client_id: Number(b.client_id) } }).catch(() => {});
    res.json({ ok: true, card: ins[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.patch('/cards/:id(\\d+)', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = ['updated_at=NOW()']; const p = [];
    const set = (col, v) => { p.push(v); sets.push(`${col}=$${p.length}`); };
    const setJ = (col, v) => { p.push(jb(v) || '[]'); sets.push(`${col}=$${p.length}::jsonb`); }; // jsonb-поля
    if (b.blood_type !== undefined) set('blood_type', b.blood_type);
    if (b.skin_phototype !== undefined) set('skin_phototype', num(b.skin_phototype));
    if (b.skin_type !== undefined) set('skin_type', b.skin_type);
    if (b.hair_condition !== undefined) set('hair_condition', b.hair_condition);
    if (b.allergies !== undefined) setJ('allergies', b.allergies);
    if (b.contraindications !== undefined) setJ('contraindications', b.contraindications);
    if (b.chronic_conditions !== undefined) setJ('chronic_conditions', b.chronic_conditions);
    if (b.current_medications !== undefined) setJ('current_medications', b.current_medications);
    if (b.emergency_contact_name !== undefined) set('emergency_contact_name', b.emergency_contact_name);
    if (b.emergency_contact_phone !== undefined) set('emergency_contact_phone', b.emergency_contact_phone);
    if (b.cosmetology_anamnesis !== undefined) setJ('cosmetology_anamnesis', b.cosmetology_anamnesis);
    if (b.treatment_plan !== undefined) setJ('treatment_plan', b.treatment_plan);
    if (b.home_care_notes !== undefined) set('home_care_notes', b.home_care_notes);
    if (b.status && ['active', 'needs_update', 'archived'].includes(b.status)) set('status', b.status);
    p.push(req.params.id);
    const upd = await q(`UPDATE medical_cards SET ${sets.join(', ')} WHERE id=$${p.length} AND tenant_id=current_tenant_id() RETURNING *`, p);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found' });
    logAccess(req, upd[0].id, upd[0].client_id, 'edit', Object.keys(b));
    res.json({ ok: true, card: upd[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/cards/:id(\\d+)/review', async (req, res) => {
  try {
    const upd = await q(`UPDATE medical_cards SET last_reviewed_at=NOW(), reviewed_by=$2, reviewed_by_name=$3, status='active', updated_at=NOW()
                         WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING last_reviewed_at, reviewed_by, reviewed_by_name`,
      [req.params.id, req.user?.id ?? null, req.user?.display_name || null]);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, ...upd[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/cards/:id(\\d+)/audit-log', async (req, res) => {
  try {
    const w = ['tenant_id=current_tenant_id()', 'medical_card_id=$1']; const p = [Number(req.params.id)];
    if (req.query.action) { p.push(req.query.action); w.push('action=$' + p.length); }
    if (req.query.date_from) { p.push(req.query.date_from); w.push('created_at>=$' + p.length); }
    if (req.query.date_to) { p.push(req.query.date_to + ' 23:59:59'); w.push('created_at<=$' + p.length); }
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const items = await q(`SELECT * FROM medical_access_log WHERE ${w.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit}`, p);
    const total = (await q(`SELECT COUNT(*)::int n FROM medical_access_log WHERE ${w.join(' AND ')}`, p))[0].n;
    res.json({ ok: true, items, total });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/cards/:id(\\d+)', async (req, res) => {
  try {
    if (!hasPermission(req.user.permissions, 'medical.delete')) return res.status(403).json({ ok: false, error: 'forbidden' });
    const card = (await q(`SELECT id, client_id FROM medical_cards WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!card) return res.status(404).json({ ok: false, error: 'not found' });
    logAccess(req, card.id, card.client_id, 'delete', ['gdpr_erasure']);
    await q(`DELETE FROM medical_cards WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    logAction({ user: req.user, action: 'medical.card.delete', entity: 'medical_card', entity_id: Number(req.params.id), ip: req.ip, meta: { client_id: card.client_id } }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════════════ ТЕСТИ НА АЛЕРГІЮ ════════════
router.get('/allergy-tests/check/:client_id(\\d+)', async (req, res) => {
  try {
    const w = ['tenant_id=current_tenant_id()', 'client_id=$1', "final_result='negative'", '(valid_until IS NULL OR valid_until >= CURRENT_DATE)'];
    const p = [Number(req.params.client_id)];
    if (req.query.product_brand) { p.push(req.query.product_brand); w.push('product_brand ILIKE $' + p.length); }
    const t = (await q(`SELECT id, valid_until, final_result FROM allergy_tests WHERE ${w.join(' AND ')} ORDER BY applied_at DESC LIMIT 1`, p))[0];
    res.json({ ok: true, has_valid_test: !!t, test_id: t?.id || null, valid_until: t?.valid_until || null, result: t?.final_result || null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/allergy-tests', async (req, res) => {
  try {
    const w = ['tenant_id=current_tenant_id()']; const p = [];
    const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
    if (req.query.client_id) add('client_id = ?', Number(req.query.client_id));
    if (req.query.result) add('final_result = ?', req.query.result);
    if (req.query.expired === 'true') w.push('valid_until < CURRENT_DATE');
    else if (req.query.expired === 'false') w.push('(valid_until IS NULL OR valid_until >= CURRENT_DATE)');
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const items = await q(`SELECT * FROM allergy_tests WHERE ${w.join(' AND ')} ORDER BY applied_at DESC LIMIT ${limit} OFFSET ${offset}`, p);
    const total = (await q(`SELECT COUNT(*)::int n FROM allergy_tests WHERE ${w.join(' AND ')}`, p))[0].n;
    res.json({ ok: true, items, total });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/allergy-tests/:id(\\d+)', async (req, res) => {
  try {
    const t = (await q(`SELECT * FROM allergy_tests WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!t) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, test: t });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/allergy-tests', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.client_id || !b.product_name) return res.status(400).json({ ok: false, error: 'client_id and product_name required' });
    const card = (await q(`SELECT id FROM medical_cards WHERE client_id=$1 AND tenant_id=current_tenant_id()`, [Number(b.client_id)]))[0];
    const validMonths = Number(b.valid_months) || 12;
    const ins = await q(
      `INSERT INTO allergy_tests (client_id, medical_card_id, employee_id, employee_name, product_name, product_brand, product_id,
        application_zone, exposure_minutes, photo_before_url, notes, valid_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, (CURRENT_DATE + ($12 || ' months')::interval)::date) RETURNING *`,
      [Number(b.client_id), card?.id || null, b.employee_id || req.user?.id || null, b.employee_name || req.user?.display_name || null,
       b.product_name, b.product_brand || null, num(b.product_id), b.application_zone || 'behind_ear', Number(b.exposure_minutes) || 30,
       b.photo_before_url || null, b.notes || null, String(validMonths)]);
    logAction({ user: req.user, action: 'medical.allergy_test.create', entity: 'allergy_test', entity_id: ins[0].id, ip: req.ip, meta: { client_id: Number(b.client_id) } }).catch(() => {});
    res.json({ ok: true, test: ins[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.patch('/allergy-tests/:id(\\d+)/result', async (req, res) => {
  try {
    const b = req.body || {};
    const final = b.final_result || b.result_48h || b.result_24h || 'pending';
    const upd = await q(`UPDATE allergy_tests SET result_24h=COALESCE($2,result_24h), result_48h=COALESCE($3,result_48h),
                         final_result=$4, photo_after_url=COALESCE($5,photo_after_url), notes=COALESCE($6,notes), updated_at=NOW()
                         WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING *`,
      [req.params.id, b.result_24h || null, b.result_48h || null, final, b.photo_after_url || null, b.notes || null]);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, test: upd[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════════════ ІНФОРМОВАНІ ЗГОДИ ════════════
router.get('/consents/check/:appointment_id(\\d+)', async (req, res) => {
  try {
    const appt = (await q(`SELECT id, service_id FROM appointments WHERE id=$1`, [Number(req.params.appointment_id)]))[0];
    const c = (await q(`SELECT id, status, valid_until FROM procedure_consents
      WHERE appointment_id=$1 AND tenant_id=current_tenant_id() AND status='active'
        AND (valid_until IS NULL OR valid_until >= NOW()) ORDER BY signed_at DESC LIMIT 1`, [Number(req.params.appointment_id)]))[0];
    res.json({ ok: true, required: true, has_consent: !!c, consent_id: c?.id || null, service_id: appt?.service_id || null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/consents', async (req, res) => {
  try {
    const w = ['tenant_id=current_tenant_id()']; const p = [];
    const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
    if (req.query.client_id) add('client_id = ?', Number(req.query.client_id));
    if (req.query.service_id) add('service_id = ?', Number(req.query.service_id));
    if (req.query.status) add('status = ?', req.query.status);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const items = await q(`SELECT * FROM procedure_consents WHERE ${w.join(' AND ')} ORDER BY signed_at DESC LIMIT ${limit} OFFSET ${offset}`, p);
    const total = (await q(`SELECT COUNT(*)::int n FROM procedure_consents WHERE ${w.join(' AND ')}`, p))[0].n;
    res.json({ ok: true, items, total });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/consents/:id(\\d+)', async (req, res) => {
  try {
    const c = (await q(`SELECT * FROM procedure_consents WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!c) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, consent: c });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/consents', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.client_id || !b.procedure_name || !b.signed_by_name) return res.status(400).json({ ok: false, error: 'client_id, procedure_name, signed_by_name required' });
    const card = (await q(`SELECT id FROM medical_cards WHERE client_id=$1 AND tenant_id=current_tenant_id()`, [Number(b.client_id)]))[0];
    const type = ['single', 'course', 'permanent'].includes(b.consent_type) ? b.consent_type : 'single';
    const ins = await q(
      `INSERT INTO procedure_consents (client_id, medical_card_id, appointment_id, service_id, template_id, consent_type, procedure_name,
        risks_acknowledged, checklist, signed_by_name, signature_url, document_url, valid_until, collected_by, collected_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [Number(b.client_id), card?.id || null, num(b.appointment_id), num(b.service_id), num(b.template_id), type, b.procedure_name,
       b.risks_acknowledged === true, jb(b.checklist), b.signed_by_name, b.signature_url || b.signature_file || null, b.document_url || null,
       b.valid_until || null, req.user?.id ?? null, req.user?.display_name || null]);
    logAction({ user: req.user, action: 'medical.consent.create', entity: 'procedure_consent', entity_id: ins[0].id, ip: req.ip, meta: { client_id: Number(b.client_id), service_id: num(b.service_id) } }).catch(() => {});
    res.json({ ok: true, consent: ins[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.patch('/consents/:id(\\d+)/revoke', async (req, res) => {
  try {
    const upd = await q(`UPDATE procedure_consents SET status='revoked', revoked_at=NOW(), revoke_reason=$2, updated_at=NOW()
                         WHERE id=$1 AND tenant_id=current_tenant_id() AND status='active' RETURNING *`,
      [req.params.id, req.body?.revoke_reason || null]);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found or not active' });
    res.json({ ok: true, consent: upd[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════════════ ФОРМУЛИ ФАРБУВАННЯ ════════════
router.get('/formulas/search', async (req, res) => {
  try {
    const w = ['f.tenant_id=current_tenant_id()']; const p = [];
    const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
    if (req.query.brand) add("f.zones::text ILIKE ?", '%' + req.query.brand + '%');
    if (req.query.line) add("f.zones::text ILIKE ?", '%' + req.query.line + '%');
    if (req.query.shade) add("f.zones::text ILIKE ?", '%' + req.query.shade + '%');
    if (req.query.oxidant) add("f.zones::text ILIKE ?", '%' + req.query.oxidant + '%');
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const items = await q(`SELECT f.*, c.name AS client_name FROM coloring_formulas f
                           LEFT JOIN clients c ON c.id=f.client_id
                           WHERE ${w.join(' AND ')} ORDER BY f.formula_date DESC LIMIT ${limit}`, p);
    res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/formulas/history/:client_id(\\d+)', async (req, res) => {
  try {
    const items = await q(`SELECT f.*, c.name AS employee_name_join FROM coloring_formulas f
      LEFT JOIN clients c ON c.id=f.client_id
      WHERE f.client_id=$1 AND f.tenant_id=current_tenant_id() ORDER BY f.formula_date DESC, f.id DESC`, [Number(req.params.client_id)]);
    res.json({ ok: true, items, total: items.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/formulas', async (req, res) => {
  try {
    const w = ['tenant_id=current_tenant_id()']; const p = [];
    const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
    if (req.query.client_id) add('client_id = ?', Number(req.query.client_id));
    if (req.query.employee_id) add('employee_id = ?', Number(req.query.employee_id));
    if (req.query.date_from) add('formula_date >= ?', req.query.date_from);
    if (req.query.date_to) add('formula_date <= ?', req.query.date_to);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const items = await q(`SELECT * FROM coloring_formulas WHERE ${w.join(' AND ')} ORDER BY formula_date DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, p);
    const total = (await q(`SELECT COUNT(*)::int n FROM coloring_formulas WHERE ${w.join(' AND ')}`, p))[0].n;
    res.json({ ok: true, items, total });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/formulas/:id(\\d+)', async (req, res) => {
  try {
    const f = (await q(`SELECT * FROM coloring_formulas WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!f) return res.status(404).json({ ok: false, error: 'not found' });
    let prev = null;
    if (f.previous_formula_id) prev = (await q(`SELECT * FROM coloring_formulas WHERE id=$1 AND tenant_id=current_tenant_id()`, [f.previous_formula_id]))[0] || null;
    res.json({ ok: true, formula: f, previous_formula: prev });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/formulas', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.client_id) return res.status(400).json({ ok: false, error: 'client_id required' });
    const card = (await q(`SELECT id FROM medical_cards WHERE client_id=$1 AND tenant_id=current_tenant_id()`, [Number(b.client_id)]))[0];
    // попередня поточна формула → not current, лінкуємо
    const prev = (await q(`SELECT id FROM coloring_formulas WHERE client_id=$1 AND tenant_id=current_tenant_id() AND is_current=true ORDER BY formula_date DESC LIMIT 1`, [Number(b.client_id)]))[0];
    if (prev) await q(`UPDATE coloring_formulas SET is_current=false, updated_at=NOW() WHERE id=$1 AND tenant_id=current_tenant_id()`, [prev.id]);
    const ins = await q(
      `INSERT INTO coloring_formulas (client_id, medical_card_id, appointment_id, employee_id, employee_name, service_id, formula_date,
        zones, pre_treatment, post_treatment, total_amount_g, result_notes, result_rating, client_rating, next_visit_recommendation, photo_id, previous_formula_id, is_current)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,CURRENT_DATE),COALESCE($8,'[]'),$9,$10,$11,$12,$13,$14,$15,$16,$17,true) RETURNING *`,
      [Number(b.client_id), card?.id || null, num(b.appointment_id), b.employee_id || req.user?.id || null, b.employee_name || req.user?.display_name || null,
       num(b.service_id), b.formula_date || null, jb(b.zones), b.pre_treatment || null, b.post_treatment || null, num(b.total_amount_g),
       b.result_notes || null, num(b.result_rating), num(b.client_rating), b.next_visit_recommendation || null, num(b.photo_id), prev?.id || null]);
    logAction({ user: req.user, action: 'medical.formula.create', entity: 'coloring_formula', entity_id: ins[0].id, ip: req.ip, meta: { client_id: Number(b.client_id) } }).catch(() => {});
    res.json({ ok: true, formula: ins[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.patch('/formulas/:id(\\d+)', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = ['updated_at=NOW()']; const p = [];
    const set = (col, v) => { p.push(v); sets.push(`${col}=$${p.length}`); };
    if (b.zones !== undefined) set('zones', jb(b.zones) || '[]');
    if (b.pre_treatment !== undefined) set('pre_treatment', b.pre_treatment);
    if (b.post_treatment !== undefined) set('post_treatment', b.post_treatment);
    if (b.total_amount_g !== undefined) set('total_amount_g', num(b.total_amount_g));
    if (b.result_notes !== undefined) set('result_notes', b.result_notes);
    if (b.result_rating !== undefined) set('result_rating', num(b.result_rating));
    if (b.client_rating !== undefined) set('client_rating', num(b.client_rating));
    if (b.next_visit_recommendation !== undefined) set('next_visit_recommendation', b.next_visit_recommendation);
    if (b.photo_id !== undefined) set('photo_id', num(b.photo_id));
    p.push(req.params.id);
    const upd = await q(`UPDATE coloring_formulas SET ${sets.join(', ')} WHERE id=$${p.length} AND tenant_id=current_tenant_id() RETURNING *`, p);
    if (!upd.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, formula: upd[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
