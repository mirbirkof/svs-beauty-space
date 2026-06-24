/* routes/branding.js — SAS-08 Branding. Монтується як /api/branding.
   Бренд-ассети, brand guidelines (цифровий brand book), шаблони.

   Tenant API (потребує brand.* права / saas.read / saas.write):
     GET    /assets               — список ассетів (filter: type, tags, page)
     POST   /assets               — додати ассет (URL + метадані)
     PUT    /assets/:id           — оновити ассет (нова версія)
     DELETE /assets/:id           — видалити ассет

     GET    /guidelines           — поточний brand book
     PUT    /guidelines           — оновити brand book
     PATCH  /guidelines/reset     — скинути до дефолтних значень

     GET    /templates            — список шаблонів (filter: type, category, lang)
     GET    /templates/:id        — один шаблон
     PUT    /templates/:id        — оновити шаблон тенанта
     POST   /templates/:id/duplicate — скопіювати шаблон
     POST   /templates/:id/preview   — preview з підстановкою змінних

   Superadmin API (brand.templates.global):
     GET    /admin/templates      — глобальні шаблони
     POST   /admin/templates      — створити глобальний шаблон
     PUT    /admin/templates/:id  — оновити глобальний шаблон
     DELETE /admin/templates/:id  — видалити глобальний шаблон

   Public (без авторизації, тільки whitelist полів):
     GET    /public/:slug         — публічна картка бренду тенанта за slug
*/
'use strict';
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const router = express.Router();
const pool = getPool();

// ── helpers ─────────────────────────────────────────────────────────────────

/** Відповідь про помилку: не виводимо деталі у production. */
const fail = (res, e, code) => {
  console.error('[branding]', e);
  const isProd = process.env.NODE_ENV === 'production';
  const msg = (!isProd || /not-found|required|invalid|forbidden/.test(e.message || ''))
    ? e.message : 'Internal server error';
  res.status(code || (/not-found/.test(e.message) ? 404 : 500)).json({ error: msg });
};

/** Валідатор hex-кольору (#RGB або #RRGGBB). */
const isHex = (v) => typeof v === 'string' && /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(v);

/** Валідатор URL (http/https, max 500 симв). */
const isUrl = (v) => {
  if (!v) return true; // дозволяємо null/undefined
  if (typeof v !== 'string' || v.length > 500) return false;
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
};

/** Парсить масив тегів із рядка або масиву. */
const parseTags = (raw) => {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  return arr.map((t) => String(t).trim().toLowerCase().slice(0, 50)).filter(Boolean);
};

const ASSET_TYPES = ['logo_primary','logo_alt','logo_mono','logo_reversed',
                     'icon','favicon','font','photo','illustration','watermark'];
const TEMPLATE_TYPES = ['email','sms','push','business_card','flyer','social_post',
                        'certificate','gift_card','receipt'];
const TONE_TYPES = ['formal','friendly','playful','professional'];
const LANGS = ['uk','ru','en'];

// Публічний whitelist полів brand book (для /public/:slug)
const PUBLIC_BRAND_FIELDS = ['app_name','logo_url','logo_dark_url','favicon_url',
  'color_palette','typography','tone_of_voice','style_guide_slug'];

// ── PUBLIC ───────────────────────────────────────────────────────────────────
// Без requirePerm — тільки читання, лише whitelist полів

/**
 * GET /api/branding/public/:slug
 * Публічна картка бренду тенанта по style_guide_slug.
 * Відповідь: app_name, логотипи, кольори, типографіка, tone.
 */
router.get('/public/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    if (!slug) return res.status(400).json({ error: 'slug-required' });

    // Читаємо brand_guidelines + white_label_configs для app_name та логотипів
    const r = await pool.query(
      `SELECT
          bg.color_palette,
          bg.typography,
          bg.tone_of_voice,
          bg.style_guide_slug,
          wl.app_name,
          wl.logo_url,
          wl.logo_dark_url,
          wl.favicon_url
       FROM brand_guidelines bg
       LEFT JOIN white_label_configs wl ON wl.tenant_id = bg.tenant_id
       WHERE bg.style_guide_slug = $1
         AND bg.consistency_score IS NOT DISTINCT FROM bg.consistency_score`, // завжди true, щоб не блокувати
      [slug]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });

    // Додатково: основні ассети
    const assets = await pool.query(
      `SELECT asset_type, original_url, thumbnail_url, small_url, name
         FROM brand_assets
        WHERE tenant_id = (
              SELECT tenant_id FROM brand_guidelines WHERE style_guide_slug = $1 LIMIT 1
              )
          AND is_active = TRUE
          AND asset_type IN ('logo_primary','logo_alt','favicon','icon')`,
      [slug]
    );

    res.json({ brand: r.rows[0], assets: assets.rows });
  } catch (e) { fail(res, e); }
});

// ── GUARD: решта ендпоінтів потребують авторизації ──────────────────────────
router.use(requirePerm('saas.read'));

// ════════════════════════════════════════════════════════════════════════════
// BRAND ASSETS
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/branding/assets
 * Query: ?type=logo_primary&tags=main,square&page=1&limit=50
 */
router.get('/assets', async (req, res) => {
  try {
    const { type, tags, page = '1', limit: lim = '50' } = req.query;
    const offset = (Math.max(1, parseInt(page, 10)) - 1) * Math.min(100, parseInt(lim, 10));
    const pageSize = Math.min(100, parseInt(lim, 10));

    const params = [];
    const conditions = ['is_active = TRUE'];

    if (type) {
      if (!ASSET_TYPES.includes(type)) return res.status(400).json({ error: 'invalid-asset-type' });
      params.push(type);
      conditions.push(`asset_type = $${params.length}`);
    }
    if (tags) {
      const tagArr = parseTags(tags);
      if (tagArr.length) {
        params.push(tagArr);
        conditions.push(`tags && $${params.length}::varchar[]`);
      }
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(pageSize, offset);

    const r = await pool.query(
      `SELECT id, asset_type, name, original_url, thumbnail_url, small_url, medium_url,
              large_url, mime_type, file_size_bytes, width, height, version, tags, metadata,
              is_active, created_at, updated_at
         FROM brand_assets
        ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ ok: true, assets: r.rows, count: r.rows.length, page: parseInt(page, 10) });
  } catch (e) { fail(res, e); }
});

/**
 * POST /api/branding/assets
 * Body: { asset_type, name, original_url, thumbnail_url?, small_url?, medium_url?,
 *          large_url?, mime_type, file_size_bytes?, width?, height?, tags?, metadata? }
 */
router.post('/assets', requirePerm('saas.write'), async (req, res) => {
  try {
    const {
      asset_type, name, original_url, thumbnail_url, small_url, medium_url, large_url,
      mime_type, file_size_bytes = 0, width, height, tags, metadata
    } = req.body || {};

    if (!asset_type || !ASSET_TYPES.includes(asset_type))
      return res.status(400).json({ error: 'invalid-asset-type', allowed: ASSET_TYPES });
    if (!name || String(name).length > 255)
      return res.status(400).json({ error: 'name-required-max-255' });
    if (!original_url || !isUrl(original_url))
      return res.status(400).json({ error: 'invalid-original-url' });
    if (!mime_type || String(mime_type).length > 50)
      return res.status(400).json({ error: 'mime-type-required' });
    for (const [field, val] of [['thumbnail_url', thumbnail_url], ['small_url', small_url],
         ['medium_url', medium_url], ['large_url', large_url]]) {
      if (val && !isUrl(val)) return res.status(400).json({ error: `invalid-${field}` });
    }

    const tagArr = parseTags(tags);
    const meta = (metadata && typeof metadata === 'object') ? metadata : {};

    const r = await pool.query(
      `INSERT INTO brand_assets
         (asset_type, name, original_url, thumbnail_url, small_url, medium_url, large_url,
          mime_type, file_size_bytes, width, height, tags, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [asset_type, String(name).trim(), original_url,
       thumbnail_url || null, small_url || null, medium_url || null, large_url || null,
       mime_type, parseInt(file_size_bytes, 10) || 0,
       width ? parseInt(width, 10) : null, height ? parseInt(height, 10) : null,
       tagArr, JSON.stringify(meta)]
    );
    await logAction({ user: req.user, action: 'brand.asset.create', entity: 'brand_assets',
      entity_id: r.rows[0].id, ip: req.ip, meta: { asset_type, name } });
    res.status(201).json({ ok: true, asset: r.rows[0] });
  } catch (e) { fail(res, e); }
});

/**
 * PUT /api/branding/assets/:id
 * Оновлює ассет (збільшує version). Можна замінити URL або метадані.
 */
router.put('/assets/:id', requirePerm('saas.write'), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, original_url, thumbnail_url, small_url, medium_url, large_url,
      mime_type, file_size_bytes, width, height, tags, metadata
    } = req.body || {};

    if (original_url && !isUrl(original_url))
      return res.status(400).json({ error: 'invalid-original-url' });
    for (const [field, val] of [['thumbnail_url', thumbnail_url], ['small_url', small_url],
         ['medium_url', medium_url], ['large_url', large_url]]) {
      if (val && !isUrl(val)) return res.status(400).json({ error: `invalid-${field}` });
    }

    const sets = ['version = version + 1', 'updated_at = NOW()'];
    const params = [];
    const push = (v) => { params.push(v); return `$${params.length}`; };

    if (name)           sets.push(`name = ${push(String(name).trim().slice(0, 255))}`);
    if (original_url)   sets.push(`original_url = ${push(original_url)}`);
    if (thumbnail_url)  sets.push(`thumbnail_url = ${push(thumbnail_url)}`);
    if (small_url)      sets.push(`small_url = ${push(small_url)}`);
    if (medium_url)     sets.push(`medium_url = ${push(medium_url)}`);
    if (large_url)      sets.push(`large_url = ${push(large_url)}`);
    if (mime_type)      sets.push(`mime_type = ${push(String(mime_type).slice(0, 50))}`);
    if (file_size_bytes != null) sets.push(`file_size_bytes = ${push(parseInt(file_size_bytes, 10) || 0)}`);
    if (width != null)  sets.push(`width = ${push(parseInt(width, 10))}`);
    if (height != null) sets.push(`height = ${push(parseInt(height, 10))}`);
    if (tags)           sets.push(`tags = ${push(parseTags(tags))}`);
    if (metadata && typeof metadata === 'object') sets.push(`metadata = ${push(JSON.stringify(metadata))}`);

    params.push(id);
    const r = await pool.query(
      `UPDATE brand_assets SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'asset-not-found' });
    await logAction({ user: req.user, action: 'brand.asset.update', entity: 'brand_assets',
      entity_id: id, ip: req.ip });
    res.json({ ok: true, asset: r.rows[0] });
  } catch (e) { fail(res, e); }
});

/**
 * DELETE /api/branding/assets/:id
 * М'яке видалення (is_active = false).
 */
router.delete('/assets/:id', requirePerm('saas.write'), async (req, res) => {
  try {
    const { id } = req.params;
    const r = await pool.query(
      `UPDATE brand_assets SET is_active = FALSE, updated_at = NOW()
        WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'asset-not-found' });
    await logAction({ user: req.user, action: 'brand.asset.delete', entity: 'brand_assets',
      entity_id: id, ip: req.ip });
    res.status(204).end();
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// BRAND GUIDELINES
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/branding/guidelines
 * Повертає brand book тенанта. Якщо ще не існує — порожній об'єкт.
 */
router.get('/guidelines', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, tenant_id, color_palette, typography, tone_of_voice, logo_rules,
              custom_guidelines, guideline_pdf_url, style_guide_slug, consistency_score,
              created_at, updated_at
         FROM brand_guidelines
        LIMIT 1`
    );
    res.json({ ok: true, guidelines: r.rows[0] || null });
  } catch (e) { fail(res, e); }
});

/**
 * PUT /api/branding/guidelines
 * Upsert brand book. Валідація: кольори hex, tone, довжини.
 * Body: { color_palette?, typography?, tone_of_voice?, logo_rules?,
 *          custom_guidelines?, guideline_pdf_url?, style_guide_slug? }
 */
router.put('/guidelines', requirePerm('saas.write'), async (req, res) => {
  try {
    const {
      color_palette, typography, tone_of_voice, logo_rules,
      custom_guidelines, guideline_pdf_url, style_guide_slug
    } = req.body || {};

    // Валідація кольорів
    if (color_palette && typeof color_palette === 'object') {
      for (const [key, val] of Object.entries(color_palette)) {
        if (val && !isHex(val))
          return res.status(400).json({ error: `invalid-color-${key}`, message: 'Очікується #RGB або #RRGGBB' });
      }
    }
    if (tone_of_voice && !TONE_TYPES.includes(tone_of_voice))
      return res.status(400).json({ error: 'invalid-tone', allowed: TONE_TYPES });
    if (guideline_pdf_url && !isUrl(guideline_pdf_url))
      return res.status(400).json({ error: 'invalid-guideline-pdf-url' });
    if (style_guide_slug && (typeof style_guide_slug !== 'string' || style_guide_slug.length > 100))
      return res.status(400).json({ error: 'style-guide-slug-too-long' });
    if (custom_guidelines && String(custom_guidelines).length > 50000)
      return res.status(400).json({ error: 'custom-guidelines-too-long' });

    // UPSERT
    const r = await pool.query(
      `INSERT INTO brand_guidelines
         (color_palette, typography, tone_of_voice, logo_rules,
          custom_guidelines, guideline_pdf_url, style_guide_slug)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id) DO UPDATE SET
         color_palette       = COALESCE($1, brand_guidelines.color_palette),
         typography          = COALESCE($2, brand_guidelines.typography),
         tone_of_voice       = COALESCE($3, brand_guidelines.tone_of_voice),
         logo_rules          = COALESCE($4, brand_guidelines.logo_rules),
         custom_guidelines   = COALESCE($5, brand_guidelines.custom_guidelines),
         guideline_pdf_url   = COALESCE($6, brand_guidelines.guideline_pdf_url),
         style_guide_slug    = COALESCE($7, brand_guidelines.style_guide_slug),
         updated_at          = NOW()
       RETURNING *`,
      [
        color_palette ? JSON.stringify(color_palette) : null,
        typography    ? JSON.stringify(typography)    : null,
        tone_of_voice || null,
        logo_rules    ? JSON.stringify(logo_rules)    : null,
        custom_guidelines  ? String(custom_guidelines)  : null,
        guideline_pdf_url  || null,
        style_guide_slug   ? String(style_guide_slug).trim().toLowerCase() : null,
      ]
    );
    await logAction({ user: req.user, action: 'brand.guidelines.update', entity: 'brand_guidelines',
      entity_id: r.rows[0].id, ip: req.ip });
    res.json({ ok: true, guidelines: r.rows[0] });
  } catch (e) { fail(res, e); }
});

/**
 * PATCH /api/branding/guidelines/reset
 * Скидає brand guidelines до дефолтних значень.
 */
router.patch('/guidelines/reset', requirePerm('saas.write'), async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE brand_guidelines
          SET color_palette     = '{}',
              typography        = '{}',
              tone_of_voice     = 'friendly',
              logo_rules        = '{}',
              custom_guidelines = NULL,
              guideline_pdf_url = NULL,
              consistency_score = NULL,
              updated_at        = NOW()
        RETURNING *`
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'guidelines-not-found' });
    await logAction({ user: req.user, action: 'brand.guidelines.reset', entity: 'brand_guidelines',
      entity_id: r.rows[0].id, ip: req.ip });
    res.json({ ok: true, guidelines: r.rows[0] });
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// BRAND TEMPLATES (tenant-scoped)
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/branding/templates
 * Query: ?type=email&category=appointment&lang=uk&page=1
 */
router.get('/templates', async (req, res) => {
  try {
    const { type, category, lang, page = '1' } = req.query;
    const offset = (Math.max(1, parseInt(page, 10)) - 1) * 50;

    const params = [];
    const conditions = ['is_active = TRUE'];
    const push = (v) => { params.push(v); return `$${params.length}`; };

    if (type) {
      if (!TEMPLATE_TYPES.includes(type)) return res.status(400).json({ error: 'invalid-template-type' });
      conditions.push(`template_type = ${push(type)}`);
    }
    if (category) conditions.push(`category = ${push(String(category).slice(0, 30))}`);
    if (lang) {
      if (!LANGS.includes(lang)) return res.status(400).json({ error: 'invalid-lang', allowed: LANGS });
      conditions.push(`language = ${push(lang)}`);
    }

    const where = 'WHERE ' + conditions.join(' AND ');
    params.push(50, offset);

    const r = await pool.query(
      `SELECT id, tenant_id, template_type, name, slug, subject, body_text,
              variables, language, category, thumbnail_url, is_default, is_active, version,
              created_at, updated_at
         FROM brand_templates
        ${where}
        ORDER BY is_default DESC, created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ ok: true, templates: r.rows, count: r.rows.length });
  } catch (e) { fail(res, e); }
});

/**
 * GET /api/branding/templates/:id
 */
router.get('/templates/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM brand_templates WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'template-not-found' });
    res.json({ ok: true, template: r.rows[0] });
  } catch (e) { fail(res, e); }
});

/**
 * PUT /api/branding/templates/:id
 * Оновлює шаблон. Зберігає лише тенантові шаблони (глобальні — через admin API).
 * Body: { name?, subject?, body_html?, body_mjml?, body_text?, variables?,
 *          design_config?, thumbnail_url? }
 */
router.put('/templates/:id', requirePerm('saas.write'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, subject, body_html, body_mjml, body_text,
            variables, design_config, thumbnail_url } = req.body || {};

    // Перевіряємо що шаблон належить цьому тенанту (tenant_id NOT NULL)
    const check = await pool.query(
      `SELECT id, tenant_id FROM brand_templates WHERE id = $1`, [id]
    );
    if (!check.rows[0]) return res.status(404).json({ error: 'template-not-found' });
    if (!check.rows[0].tenant_id)
      return res.status(403).json({ error: 'forbidden', message: 'Глобальні шаблони редагуються через /admin/templates' });

    if (thumbnail_url && !isUrl(thumbnail_url))
      return res.status(400).json({ error: 'invalid-thumbnail-url' });
    if (subject && String(subject).length > 255)
      return res.status(400).json({ error: 'subject-too-long' });

    const sets = ['version = version + 1', 'updated_at = NOW()'];
    const params = [];
    const push = (v) => { params.push(v); return `$${params.length}`; };

    if (name)         sets.push(`name = ${push(String(name).trim().slice(0, 100))}`);
    if (subject)      sets.push(`subject = ${push(String(subject).slice(0, 255))}`);
    if (body_html != null)  sets.push(`body_html = ${push(body_html)}`);
    if (body_mjml != null)  sets.push(`body_mjml = ${push(body_mjml)}`);
    if (body_text != null)  sets.push(`body_text = ${push(body_text)}`);
    if (variables)    sets.push(`variables = ${push(JSON.stringify(variables))}`);
    if (design_config) sets.push(`design_config = ${push(JSON.stringify(design_config))}`);
    if (thumbnail_url) sets.push(`thumbnail_url = ${push(thumbnail_url)}`);

    params.push(id);
    const r = await pool.query(
      `UPDATE brand_templates SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    await logAction({ user: req.user, action: 'brand.template.update', entity: 'brand_templates',
      entity_id: id, ip: req.ip });
    res.json({ ok: true, template: r.rows[0] });
  } catch (e) { fail(res, e); }
});

/**
 * POST /api/branding/templates/:id/duplicate
 * Копіює шаблон (глобальний або тенантовий) як новий тенантовий.
 */
router.post('/templates/:id/duplicate', requirePerm('saas.write'), async (req, res) => {
  try {
    const { id } = req.params;
    const src = await pool.query(`SELECT * FROM brand_templates WHERE id = $1`, [id]);
    if (!src.rows[0]) return res.status(404).json({ error: 'template-not-found' });
    const s = src.rows[0];
    const newSlug = `${s.slug}-copy-${Date.now()}`.slice(0, 100);

    const r = await pool.query(
      `INSERT INTO brand_templates
         (template_type, name, slug, subject, body_html, body_mjml, body_text,
          variables, language, category, design_config, thumbnail_url, is_default, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,FALSE,1)
       RETURNING *`,
      [s.template_type, `${s.name} (копія)`, newSlug, s.subject,
       s.body_html, s.body_mjml, s.body_text,
       JSON.stringify(s.variables), s.language, s.category,
       JSON.stringify(s.design_config), s.thumbnail_url]
    );
    await logAction({ user: req.user, action: 'brand.template.duplicate', entity: 'brand_templates',
      entity_id: r.rows[0].id, ip: req.ip, meta: { source_id: id } });
    res.status(201).json({ ok: true, template: r.rows[0] });
  } catch (e) { fail(res, e); }
});

/**
 * POST /api/branding/templates/:id/preview
 * Підставляє змінні у шаблон, повертає рендерений HTML + text.
 * Body: { variables: { "client.name": "Ірина", ... } }
 */
router.post('/templates/:id/preview', async (req, res) => {
  try {
    const { id } = req.params;
    const vars = (req.body && typeof req.body.variables === 'object') ? req.body.variables : {};

    const r = await pool.query(
      `SELECT body_html, body_text, subject FROM brand_templates WHERE id = $1`, [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'template-not-found' });
    const { body_html, body_text, subject } = r.rows[0];

    // Простий Mustache-сумісний рендер: {{key}} → значення
    const render = (tpl) => {
      if (!tpl) return tpl;
      return String(tpl).replace(/\{\{([\w.]+)\}\}/g, (_, key) => {
        const val = key.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), vars);
        return val != null ? String(val) : `{{${key}}}`;
      });
    };

    res.json({
      ok: true,
      html:    render(body_html),
      text:    render(body_text),
      subject: render(subject),
    });
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════════════════════
// SUPERADMIN — глобальні шаблони
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/branding/admin/templates
 * Глобальні шаблони (tenant_id IS NULL).
 */
router.get('/admin/templates', requirePerm('superadmin'), async (req, res) => {
  try {
    const { type, lang } = req.query;
    const params = [];
    const conds = ['tenant_id IS NULL'];
    if (type) { params.push(type); conds.push(`template_type = $${params.length}`); }
    if (lang)  { params.push(lang);  conds.push(`language = $${params.length}`); }
    const r = await pool.query(
      `SELECT * FROM brand_templates WHERE ${conds.join(' AND ')} ORDER BY template_type, name`,
      params
    );
    res.json({ ok: true, templates: r.rows });
  } catch (e) { fail(res, e); }
});

/**
 * POST /api/branding/admin/templates
 * Створити глобальний шаблон (superadmin).
 */
router.post('/admin/templates', requirePerm('superadmin'), async (req, res) => {
  try {
    const { template_type, name, slug, subject, body_html, body_mjml, body_text,
            variables = [], language = 'uk', category, design_config = {}, thumbnail_url,
            is_default = false } = req.body || {};

    if (!template_type || !TEMPLATE_TYPES.includes(template_type))
      return res.status(400).json({ error: 'invalid-template-type', allowed: TEMPLATE_TYPES });
    if (!name || String(name).length > 100)
      return res.status(400).json({ error: 'name-required-max-100' });
    if (!slug || String(slug).length > 100)
      return res.status(400).json({ error: 'slug-required-max-100' });
    if (!LANGS.includes(language))
      return res.status(400).json({ error: 'invalid-lang', allowed: LANGS });
    if (thumbnail_url && !isUrl(thumbnail_url))
      return res.status(400).json({ error: 'invalid-thumbnail-url' });

    const r = await pool.query(
      `INSERT INTO brand_templates
         (tenant_id, template_type, name, slug, subject, body_html, body_mjml, body_text,
          variables, language, category, design_config, thumbnail_url, is_default)
       VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [template_type, String(name).trim(), String(slug).trim().toLowerCase(),
       subject || null, body_html || null, body_mjml || null, body_text || null,
       JSON.stringify(variables), language, category || null,
       JSON.stringify(design_config), thumbnail_url || null, Boolean(is_default)]
    );
    await logAction({ user: req.user, action: 'brand.template.global.create', entity: 'brand_templates',
      entity_id: r.rows[0].id, ip: req.ip });
    res.status(201).json({ ok: true, template: r.rows[0] });
  } catch (e) { fail(res, e); }
});

/**
 * PUT /api/branding/admin/templates/:id
 */
router.put('/admin/templates/:id', requirePerm('superadmin'), async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query(`SELECT id, tenant_id FROM brand_templates WHERE id = $1`, [id]);
    if (!check.rows[0]) return res.status(404).json({ error: 'template-not-found' });
    if (check.rows[0].tenant_id !== null)
      return res.status(403).json({ error: 'not-global-template' });

    const { name, subject, body_html, body_mjml, body_text,
            variables, design_config, thumbnail_url, is_default } = req.body || {};

    if (thumbnail_url && !isUrl(thumbnail_url))
      return res.status(400).json({ error: 'invalid-thumbnail-url' });

    const sets = ['version = version + 1', 'updated_at = NOW()'];
    const params = [];
    const push = (v) => { params.push(v); return `$${params.length}`; };

    if (name)         sets.push(`name = ${push(String(name).trim().slice(0, 100))}`);
    if (subject)      sets.push(`subject = ${push(String(subject).slice(0, 255))}`);
    if (body_html != null)  sets.push(`body_html = ${push(body_html)}`);
    if (body_mjml != null)  sets.push(`body_mjml = ${push(body_mjml)}`);
    if (body_text != null)  sets.push(`body_text = ${push(body_text)}`);
    if (variables)    sets.push(`variables = ${push(JSON.stringify(variables))}`);
    if (design_config) sets.push(`design_config = ${push(JSON.stringify(design_config))}`);
    if (thumbnail_url) sets.push(`thumbnail_url = ${push(thumbnail_url)}`);
    if (is_default != null) sets.push(`is_default = ${push(Boolean(is_default))}`);

    params.push(id);
    const r = await pool.query(
      `UPDATE brand_templates SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    await logAction({ user: req.user, action: 'brand.template.global.update', entity: 'brand_templates',
      entity_id: id, ip: req.ip });
    res.json({ ok: true, template: r.rows[0] });
  } catch (e) { fail(res, e); }
});

/**
 * DELETE /api/branding/admin/templates/:id
 */
router.delete('/admin/templates/:id', requirePerm('superadmin'), async (req, res) => {
  try {
    const { id } = req.params;
    const r = await pool.query(
      `DELETE FROM brand_templates WHERE id = $1 AND tenant_id IS NULL RETURNING id`, [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'template-not-found-or-not-global' });
    await logAction({ user: req.user, action: 'brand.template.global.delete', entity: 'brand_templates',
      entity_id: id, ip: req.ip });
    res.status(204).end();
  } catch (e) { fail(res, e); }
});

module.exports = router;
