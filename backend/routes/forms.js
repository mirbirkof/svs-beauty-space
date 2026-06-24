/* ═══════════════════════════════════════════════════════
   MGT-08 — Конструктор форм (Forms Builder)
   Подключается как /api/forms (mount: shop-api.js → app.use('/api/forms', ...))

   Покрывает спеку tz_modules/v2/mgt_08_forms.md:
   - 08.01 Конструктор: CRUD форм + полей (form_fields), типы полей по спеке,
     секции, multi-page (pages_config), дублирование формы/поля, reorder, черновик;
   - 08.02 Условная логика: conditional_rules на поле, операторы eq/ne/contains/
     gt/lt/empty/not_empty, действия show/hide/require, лимит 50 правил/форму;
   - 08.03 Публикация: publish/close, slug, публичная ссылка, QR (URL), iframe-код,
     access_type (public/link_only/authenticated), дедлайн, лимит заполнений,
     антиспам (one_per_email/phone), страница "форма закрыта";
   - 08.04 Submissions: приём ответов (публично по slug + из админки), валидация
     (required/min/max/minLength/maxLength/pattern/file_types) с учётом условной
     логики, привязка к client_id/appointment_id, статусы new/reviewed/processed/
     archived, "избранное", soft-delete, детальный просмотр, экспорт CSV/XLSX,
     on_submit_actions (create_client / notify / webhook → event-bus);
   - 08.05 Аналитика: просмотры (form_views), конверсия, среднее время, источники,
     устройства, динамика по дням, распределение ответов для select/radio,
     средний рейтинг для rating/scale.

   Шаблоны: GET /templates, POST /templates/:id/use (клон системного шаблона).

   Права: forms.read / forms.write (миграция 088).
   Публичные эндпоинты (/public/*) — без авторизации.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

let emit = () => {};
try { ({ emit } = require('../lib/event-bus')); } catch (_) { /* event-bus optional */ }

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const one = (sql, p = []) => q(sql, p).then(r => r[0] || null);
const dbErr = (e) => process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;

// Полный набор типов полей по спеке + back-compat алиасы (text→short_text, ...).
const FIELD_TYPES = [
  'short_text', 'long_text', 'number', 'email', 'phone', 'date', 'time', 'datetime',
  'select', 'multi_select', 'radio', 'checkbox', 'file_upload', 'signature',
  'rating', 'scale', 'divider', 'heading', 'paragraph',
];
const TYPE_ALIAS = { text: 'short_text', textarea: 'long_text', file: 'file_upload' };
const CHOICE_TYPES = ['select', 'multi_select', 'radio', 'checkbox'];
const normType = (t) => {
  const v = TYPE_ALIAS[t] || t;
  return FIELD_TYPES.includes(v) ? v : 'short_text';
};

// нормализация JSONB-схемы полей (хранится в forms.fields, back-compat с конструктором).
function normFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.map((f, i) => {
    const type = normType(f.type);
    const out = {
      key: String(f.key || f.field_key || `field_${i + 1}`),
      label: String(f.label || f.key || `Поле ${i + 1}`),
      type,
      required: !!(f.required ?? f.is_required),
    };
    if (Array.isArray(f.options)) out.options = f.options;
    if (f.placeholder) out.placeholder = String(f.placeholder);
    if (f.help_text) out.help_text = String(f.help_text);
    if (f.validation && typeof f.validation === 'object') out.validation = f.validation;
    if (Array.isArray(f.conditional_rules)) out.conditional_rules = f.conditional_rules;
    if (f.default_value !== undefined) out.default_value = f.default_value;
    return out;
  });
}

// Получить опции в виде массива {value,label}.
function optionValues(options) {
  if (!Array.isArray(options)) return [];
  return options.map(o => (o && typeof o === 'object') ? String(o.value ?? o.label ?? '') : String(o));
}

// ── Условная логика: оценить, видимо ли поле при данных ответах ──
// rule: {field_key, op, value, action}. action=show → поле видно если правило истинно;
// hide → скрыто если истинно; require → required-флаг включается если истинно.
const OPS = {
  eq:        (a, b) => String(a ?? '') === String(b ?? ''),
  ne:        (a, b) => String(a ?? '') !== String(b ?? ''),
  contains:  (a, b) => String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()),
  not_contains: (a, b) => !String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()),
  gt:        (a, b) => Number(a) > Number(b),
  lt:        (a, b) => Number(a) < Number(b),
  empty:     (a)    => a === undefined || a === null || String(a).trim() === '',
  not_empty: (a)    => !(a === undefined || a === null || String(a).trim() === ''),
};
function evalRules(field, data) {
  const rules = Array.isArray(field.conditional_rules) ? field.conditional_rules : [];
  let visible = true, required = !!(field.required ?? field.is_required);
  for (const r of rules) {
    const op = OPS[r.op]; if (!op) continue;
    const truthy = op(data[r.field_key], r.value);
    if (r.action === 'show') visible = visible && truthy;
    else if (r.action === 'hide') { if (truthy) visible = false; }
    else if (r.action === 'require') { if (truthy) required = true; }
  }
  return { visible, required };
}

// валидация ответа против схемы → массив ошибок (учитывает условную логику).
function validate(fields, data) {
  const errors = [];
  for (const f of fields) {
    const { visible, required } = evalRules(f, data);
    if (!visible) continue;                       // скрытые поля не валидируем
    let v = data[f.key ?? f.field_key];
    const type = normType(f.type);
    const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ||
                  (Array.isArray(v) && v.length === 0);
    if (required && empty) { errors.push({ key: f.key, error: 'required' }); continue; }
    if (empty) continue;
    const val = f.validation || {};
    if (type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))) errors.push({ key: f.key, error: 'invalid_email' });
    if (type === 'number' && isNaN(Number(v))) errors.push({ key: f.key, error: 'invalid_number' });
    if (val.min != null && Number(v) < Number(val.min)) errors.push({ key: f.key, error: 'min', min: val.min });
    if (val.max != null && Number(v) > Number(val.max)) errors.push({ key: f.key, error: 'max', max: val.max });
    if (val.minLength != null && String(v).length < val.minLength) errors.push({ key: f.key, error: 'min_length' });
    if (val.maxLength != null && String(v).length > val.maxLength) errors.push({ key: f.key, error: 'max_length' });
    if (val.pattern) { try { if (!new RegExp(val.pattern).test(String(v))) errors.push({ key: f.key, error: 'pattern' }); } catch (_) {} }
    if (CHOICE_TYPES.includes(type) && Array.isArray(f.options) && f.options.length) {
      const allowed = optionValues(f.options);
      const vals = Array.isArray(v) ? v : [v];
      for (const x of vals) if (!allowed.includes(String(x))) { errors.push({ key: f.key, error: 'invalid_option' }); break; }
    }
  }
  return errors;
}

// Определить тип устройства по user-agent.
function deviceFrom(ua) {
  const s = String(ua || '').toLowerCase();
  if (/ipad|tablet|playbook|silk/.test(s)) return 'tablet';
  if (/mobi|android|iphone|ipod/.test(s)) return 'mobile';
  return 'desktop';
}

// CSV из массива объектов.
function toCsv(rows, headers) {
  const esc = (x) => {
    if (x === null || x === undefined) return '';
    const s = typeof x === 'object' ? JSON.stringify(x) : String(x);
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = headers.map(h => esc(h.label ?? h.key)).join(',');
  const body = rows.map(r => headers.map(h => esc(r[h.key])).join(',')).join('\n');
  return '\uFEFF' + head + '\n' + body;            // BOM для Excel-кириллицы
}

// Минимальный XLSX (Office Open XML) из строк/заголовков — без внешних зависимостей.
function toXlsx(rows, headers) {
  const xmlEsc = (s) => String(s ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  const colRef = (n) => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; };
  const cell = (c, r, v) => {
    const ref = colRef(c) + (r + 1);
    if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  };
  const rowsXml = [];
  rowsXml.push(`<row r="1">${headers.map((h, c) => cell(c, 0, h.label ?? h.key)).join('')}</row>`);
  rows.forEach((row, ri) => {
    rowsXml.push(`<row r="${ri + 2}">${headers.map((h, c) => cell(c, ri + 1, row[h.key] && typeof row[h.key] === 'object' ? JSON.stringify(row[h.key]) : row[h.key])).join('')}</row>`);
  });
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml.join('')}</sheetData></worksheet>`;
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Submissions" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  return zipStore([
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: wb },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

// ZIP без сжатия (store) — достаточно для XLSX-контейнера, без зависимостей.
function zipStore(files) {
  const enc = (s) => Buffer.from(s, 'utf8');
  const chunks = [], central = [];
  let offset = 0;
  const crcTable = zipStore._t || (zipStore._t = (() => {
    const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t;
  })());
  const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  for (const f of files) {
    const name = enc(f.name), data = enc(f.data), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

// Базовый URL для публичных ссылок (для QR/iframe).
function baseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// ───────────────────────────────────────────────────────────────────────────
// ── ПУБЛИЧНЫЕ ЭНДПОИНТЫ (без авторизации) — объявлены ДО requirePerm ──
// ───────────────────────────────────────────────────────────────────────────

// Проверка доступности формы для приёма ответов (дедлайн/лимит/статус).
function formOpenReason(f) {
  if (f.status === 'closed') return 'closed';
  if (f.status !== 'published') return 'not_published';
  if (f.deadline_at && new Date(f.deadline_at) < new Date()) return 'deadline';
  if (f.max_submissions != null && Number(f.submit_count) >= Number(f.max_submissions)) return 'limit_reached';
  return null;
}

// GET /api/forms/public/:slug — получить опубликованную форму + засчитать просмотр.
router.get('/public/:slug', async (req, res) => {
  try {
    const f = await one(
      `SELECT id, title, description, fields, success_message, closed_message, branding,
              pages_config, is_multi_page, access_type, status, deadline_at, max_submissions, submit_count
       FROM forms WHERE slug=$1 AND access_type <> 'authenticated' LIMIT 1`,
      [req.params.slug]
    );
    if (!f) return res.status(404).json({ error: 'not_found' });
    const reason = formOpenReason(f);
    // лог просмотра (best-effort, для воронки/аналитики)
    const source = ['qr', 'iframe', 'telegram', 'email'].includes(req.query.src) ? req.query.src : 'direct_link';
    pool.query(`UPDATE forms SET view_count = COALESCE(view_count,0)+1 WHERE id=$1`, [f.id]).catch(() => {});
    pool.query(`INSERT INTO form_views (tenant_id, form_id, source, device_type, ip) VALUES ((SELECT tenant_id FROM forms WHERE id=$1),$1,$2,$3,$4)`,
      [f.id, source, deviceFrom(req.get('user-agent')), req.ip || null]).catch(() => {});
    if (reason) return res.status(403).json({ error: 'form_closed', reason, message: f.closed_message || 'Форму закрито.' });
    res.json({
      id: f.id, title: f.title, description: f.description, fields: f.fields,
      is_multi_page: f.is_multi_page, pages_config: f.pages_config, branding: f.branding,
      success_message: f.success_message,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// POST /api/forms/public/:slug/submit — отправить ответ (без авторизации).
router.post('/public/:slug/submit', async (req, res) => {
  try {
    const f = await one(
      `SELECT * FROM forms WHERE slug=$1 AND access_type <> 'authenticated' LIMIT 1`,
      [req.params.slug]
    );
    if (!f) return res.status(404).json({ error: 'not_found' });
    const reason = formOpenReason(f);
    if (reason) return res.status(403).json({ error: 'form_closed', reason, message: f.closed_message || 'Форму закрито.' });
    const source = ['qr', 'iframe', 'telegram', 'email'].includes(req.body?.source) ? req.body.source : 'direct_link';
    return await handleSubmit(req, res, f, source);
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// ── Общая логика приёма ответа (публичный + админский) ──
async function handleSubmit(req, res, f, source) {
  const fields = Array.isArray(f.fields) ? f.fields : [];
  const data = req.body?.data || {};
  const settings = f.settings || {};

  // Валидация по схеме + условной логике.
  const errors = validate(fields, data);
  if (errors.length) return res.status(422).json({ error: 'validation_failed', errors });

  // Антиспам: уникальность по email/phone.
  if (settings.one_per_email || settings.one_per_phone) {
    const keyField = settings.one_per_email ? 'email' : 'phone';
    const val = data.email || data.phone || data[keyField];
    if (val) {
      const dup = await one(
        `SELECT 1 FROM form_submissions WHERE form_id=$1 AND deleted_at IS NULL
           AND (data->>$2)=$3 LIMIT 1`, [f.id, keyField, String(val)]);
      if (dup) return res.status(409).json({ error: 'already_submitted' });
    }
  }

  const ua = req.get('user-agent') || null;
  const sub = await one(
    `INSERT INTO form_submissions (tenant_id, form_id, client_id, data, ip, user_agent, source, device_type, duration_seconds)
     VALUES ((SELECT tenant_id FROM forms WHERE id=$1),$1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, created_at`,
    [f.id, req.body?.client_id || null, JSON.stringify(data), req.ip || null, ua,
     source, deviceFrom(ua), Number.isFinite(+req.body?.duration_seconds) ? +req.body.duration_seconds : null]
  );

  // Нормализованные значения (для фильтрации/аналитики).
  await persistFieldValues(sub.id, f.id, fields, data);

  await pool.query(`UPDATE forms SET submit_count = submit_count + 1 WHERE id=$1`, [f.id]);

  // Событие + on_submit_actions.
  try { emit('form.submission_received', { form_id: f.id, submission_id: sub.id, source }); } catch (_) {}
  await runOnSubmitActions(f, sub.id, data);

  // Достигнут лимит?
  if (f.max_submissions != null && Number(f.submit_count) + 1 >= Number(f.max_submissions)) {
    try { emit('form.limit_reached', { form_id: f.id }); } catch (_) {}
  }

  res.json({ ok: true, id: sub.id, message: f.success_message || 'Дякуємо!' });
}

// Записать нормализованные значения в form_field_values.
async function persistFieldValues(submissionId, formId, fields, data) {
  try {
    const fieldRows = await q(`SELECT id, field_key, field_type FROM form_fields WHERE form_id=$1`, [formId]);
    const byKey = Object.fromEntries(fieldRows.map(r => [r.field_key, r]));
    for (const f of fields) {
      const key = f.key ?? f.field_key;
      if (!(key in data)) continue;
      const v = data[key];
      const type = normType(f.type);
      const meta = byKey[key] || {};
      let value_text = null, value_number = null, value_date = null, value_json = null;
      if (Array.isArray(v) || (v && typeof v === 'object')) value_json = JSON.stringify(v);
      else if (type === 'number' || type === 'rating' || type === 'scale') value_number = isNaN(Number(v)) ? null : Number(v);
      else if (type === 'date') value_date = v || null;
      else value_text = v == null ? null : String(v);
      await pool.query(
        `INSERT INTO form_field_values (tenant_id, submission_id, field_id, field_key, value_text, value_number, value_date, value_json)
         VALUES ((SELECT tenant_id FROM form_submissions WHERE id=$1),$1,$2,$3,$4,$5,$6,$7)`,
        [submissionId, meta.id || null, key, value_text, value_number, value_date, value_json]
      );
    }
  } catch (e) { console.error('[forms] persistFieldValues:', e.message); }
}

// Выполнить on_submit_actions (create_client / notify / webhook).
async function runOnSubmitActions(f, submissionId, data) {
  const actions = Array.isArray(f.on_submit_actions) ? f.on_submit_actions : [];
  for (const a of actions) {
    try {
      if (a.type === 'create_client') {
        const name = data.name || data.full_name || data.client_name || null;
        const phone = data.phone || data.tel || null;
        const email = data.email || null;
        if (name || phone || email) {
          const cl = await one(
            `INSERT INTO clients (name, phone, email, source)
             VALUES ($1,$2,$3,'form')
             ON CONFLICT (phone) DO UPDATE SET name=COALESCE(clients.name, EXCLUDED.name)
             RETURNING id`, [name, phone, email]).catch(() => null);
          if (cl) {
            await pool.query(`UPDATE form_submissions SET client_id=$1 WHERE id=$2 AND client_id IS NULL`, [cl.id, submissionId]);
            try { emit('client.created_from_form', { form_id: f.id, submission_id: submissionId, client_id: cl.id }); } catch (_) {}
          }
        }
      } else if (a.type === 'notify') {
        try { emit('form.notify', { form_id: f.id, submission_id: submissionId, to: a.to || 'manager', form_title: f.title }); } catch (_) {}
      } else if (a.type === 'webhook') {
        try { emit('form.webhook', { form_id: f.id, submission_id: submissionId, url: a.url, data }); } catch (_) {}
      }
    } catch (e) { console.error('[forms] on_submit action failed:', e.message); }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// ── АВТОРИЗОВАННЫЕ ЭНДПОИНТЫ ──
// ───────────────────────────────────────────────────────────────────────────
router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'forms.read' : 'forms.write';
  return requirePerm(perm)(req, res, next);
});

// GET /api/forms/templates — список системных шаблонов.
router.get('/templates', async (req, res) => {
  try {
    const rows = await q(
      `SELECT id, title, description, template_category, jsonb_array_length(fields) AS field_count
       FROM forms WHERE is_template = true ORDER BY template_category, title`);
    res.json({ rows });
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// POST /api/forms/templates/:id/use — создать форму из шаблона (клон).
router.post('/templates/:id/use', async (req, res) => {
  try {
    const tpl = await one(`SELECT * FROM forms WHERE id=$1 AND is_template=true`, [req.params.id]);
    if (!tpl) return res.status(404).json({ error: 'template_not_found' });
    const title = req.body?.title || tpl.title;
    const row = await one(
      `INSERT INTO forms (title, description, fields, status, is_public, success_message,
                          pages_config, settings, branding, on_submit_actions, template_category, created_by)
       VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [title, tpl.description, JSON.stringify(tpl.fields || []), tpl.is_public, tpl.success_message,
       JSON.stringify(tpl.pages_config || []), JSON.stringify(tpl.settings || {}),
       JSON.stringify(tpl.branding || {}), JSON.stringify(tpl.on_submit_actions || []),
       tpl.template_category, req.user?.id || null]);
    await syncFieldsTable(row.id, row.fields);
    await logAction({ user: req.user, action: 'form.from_template', entity: 'forms', entity_id: row.id, ip: req.ip });
    try { emit('form.created', { id: row.id, from_template: tpl.id }); } catch (_) {}
    res.status(201).json(row);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'slug_taken' });
    console.error(e); res.status(500).json({ error: dbErr(e) });
  }
});

// GET /api/forms — список форм (фильтры: status, template_category).
router.get('/', async (req, res) => {
  try {
    const params = [];
    const cond = ['tenant_id = current_tenant_id()', 'deleted_at IS NULL', 'is_template = false'];
    if (req.query.status) { params.push(req.query.status); cond.push(`status = $${params.length}`); }
    if (req.query.template_category) { params.push(req.query.template_category); cond.push(`template_category = $${params.length}`); }
    const rows = await q(
      `SELECT id, title, slug, status, access_type, is_public, submit_count, view_count,
              deadline_at, max_submissions, created_at, updated_at,
              jsonb_array_length(fields) AS field_count
       FROM forms WHERE ${cond.join(' AND ')} ORDER BY updated_at DESC`, params);
    res.json({ rows });
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// GET /api/forms/:id — детали формы (с нормализованными полями).
router.get('/:id', async (req, res) => {
  try {
    const f = await one(`SELECT * FROM forms WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL`, [req.params.id]);
    if (!f) return res.status(404).json({ error: 'not_found' });
    const fields = await q(`SELECT * FROM form_fields WHERE form_id=$1 ORDER BY page_index, sort_order, id`, [f.id]);
    res.json({ ...f, normalized_fields: fields });
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// POST /api/forms — создать форму.
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ error: 'title_required' });
    const fields = normFields(b.fields);
    const row = await one(
      `INSERT INTO forms (title, slug, description, fields, status, is_public, success_message,
                          access_type, is_multi_page, pages_config, settings, branding,
                          on_submit_actions, deadline_at, max_submissions, closed_message, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [b.title, b.slug || null, b.description || null, JSON.stringify(fields),
       b.status || 'draft', !!b.is_public, b.success_message || null,
       ['public', 'link_only', 'authenticated'].includes(b.access_type) ? b.access_type : 'public',
       !!b.is_multi_page, JSON.stringify(b.pages_config || []), JSON.stringify(b.settings || {}),
       JSON.stringify(b.branding || {}), JSON.stringify(b.on_submit_actions || []),
       b.deadline_at || null, Number.isFinite(+b.max_submissions) ? +b.max_submissions : null,
       b.closed_message || null, req.user?.id || null]
    );
    await syncFieldsTable(row.id, fields);
    await logAction({ user: req.user, action: 'form.create', entity: 'forms', entity_id: row.id, ip: req.ip });
    try { emit('form.created', { id: row.id, title: row.title }); } catch (_) {}
    res.status(201).json(row);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'slug_taken' });
    console.error(e); res.status(500).json({ error: dbErr(e) });
  }
});

// PATCH /api/forms/:id — обновить форму.
router.patch('/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const allowed = {
      title: v => v, slug: v => v, description: v => v,
      fields: v => JSON.stringify(normFields(v)),
      status: v => v, is_public: v => !!v, success_message: v => v,
      access_type: v => ['public', 'link_only', 'authenticated'].includes(v) ? v : 'public',
      is_multi_page: v => !!v, pages_config: v => JSON.stringify(v || []),
      settings: v => JSON.stringify(v || {}), branding: v => JSON.stringify(v || {}),
      on_submit_actions: v => JSON.stringify(v || []), deadline_at: v => v || null,
      max_submissions: v => Number.isFinite(+v) ? +v : null, closed_message: v => v,
    };
    const sets = [], params = [];
    for (const k of Object.keys(allowed)) {
      if (b[k] !== undefined) { params.push(allowed[k](b[k])); sets.push(`${k} = $${params.length}`); }
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    params.push(req.params.id);
    const row = await one(
      `UPDATE forms SET ${sets.join(', ')}, updated_at=now()
       WHERE id=$${params.length} AND tenant_id=current_tenant_id() AND deleted_at IS NULL RETURNING *`, params);
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (b.fields !== undefined) await syncFieldsTable(row.id, normFields(b.fields));
    await logAction({ user: req.user, action: 'form.update', entity: 'forms', entity_id: row.id, ip: req.ip });
    res.json(row);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'slug_taken' });
    console.error(e); res.status(500).json({ error: dbErr(e) });
  }
});

// POST /api/forms/:id/duplicate — дублировать форму.
router.post('/:id/duplicate', async (req, res) => {
  try {
    const src = await one(`SELECT * FROM forms WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL`, [req.params.id]);
    if (!src) return res.status(404).json({ error: 'not_found' });
    const row = await one(
      `INSERT INTO forms (title, description, fields, status, is_public, success_message,
                          access_type, is_multi_page, pages_config, settings, branding,
                          on_submit_actions, max_submissions, closed_message, created_by)
       VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [`${src.title} (копія)`, src.description, JSON.stringify(src.fields || []), src.is_public,
       src.success_message, src.access_type, src.is_multi_page, JSON.stringify(src.pages_config || []),
       JSON.stringify(src.settings || {}), JSON.stringify(src.branding || {}),
       JSON.stringify(src.on_submit_actions || []), src.max_submissions, src.closed_message, req.user?.id || null]);
    await syncFieldsTable(row.id, row.fields);
    await logAction({ user: req.user, action: 'form.duplicate', entity: 'forms', entity_id: row.id, ip: req.ip });
    res.status(201).json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// POST /api/forms/:id/publish — опубликовать форму.
router.post('/:id/publish', async (req, res) => {
  try {
    const f = await one(`SELECT id, slug FROM forms WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL`, [req.params.id]);
    if (!f) return res.status(404).json({ error: 'not_found' });
    let slug = f.slug || req.body?.slug;
    if (!slug) slug = 'f-' + crypto.randomBytes(5).toString('hex');     // авто-slug
    const row = await one(
      `UPDATE forms SET status='published', slug=$1, updated_at=now()
       WHERE id=$2 AND tenant_id=current_tenant_id() RETURNING *`, [slug, f.id]);
    await logAction({ user: req.user, action: 'form.publish', entity: 'forms', entity_id: f.id, ip: req.ip });
    try { emit('form.published', { id: f.id, slug }); } catch (_) {}
    res.json({ ...row, public_url: `${baseUrl(req)}/api/forms/public/${slug}` });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'slug_taken' });
    console.error(e); res.status(500).json({ error: dbErr(e) });
  }
});

// POST /api/forms/:id/close — закрыть форму (прекратить приём ответов).
router.post('/:id/close', async (req, res) => {
  try {
    const row = await one(
      `UPDATE forms SET status='closed', closed_message=COALESCE($2,closed_message), updated_at=now()
       WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL RETURNING *`,
      [req.params.id, req.body?.closed_message || null]);
    if (!row) return res.status(404).json({ error: 'not_found' });
    await logAction({ user: req.user, action: 'form.close', entity: 'forms', entity_id: row.id, ip: req.ip });
    try { emit('form.closed', { id: row.id }); } catch (_) {}
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// GET /api/forms/:id/qr — URL QR-кода публичной формы.
router.get('/:id/qr', async (req, res) => {
  try {
    const f = await one(`SELECT slug, status FROM forms WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL`, [req.params.id]);
    if (!f) return res.status(404).json({ error: 'not_found' });
    if (!f.slug) return res.status(409).json({ error: 'not_published', message: 'Опублікуйте форму, щоб отримати QR.' });
    const url = `${baseUrl(req)}/api/forms/public/${f.slug}?src=qr`;
    res.json({ url, qr_url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}` });
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// GET /api/forms/:id/embed — iframe-код для встраивания.
router.get('/:id/embed', async (req, res) => {
  try {
    const f = await one(`SELECT slug FROM forms WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL`, [req.params.id]);
    if (!f) return res.status(404).json({ error: 'not_found' });
    if (!f.slug) return res.status(409).json({ error: 'not_published' });
    const url = `${baseUrl(req)}/api/forms/public/${f.slug}?src=iframe`;
    const code = `<iframe src="${url}" width="100%" height="800" frameborder="0" style="border:0;max-width:680px"></iframe>`;
    res.json({ url, embed_code: code });
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// ── Поля формы (form_fields) ──

// GET /api/forms/:id/fields — список полей.
router.get('/:id/fields', async (req, res) => {
  try {
    const rows = await q(
      `SELECT ff.* FROM form_fields ff JOIN forms f ON f.id=ff.form_id
       WHERE ff.form_id=$1 AND f.tenant_id=current_tenant_id()
       ORDER BY ff.page_index, ff.sort_order, ff.id`, [req.params.id]);
    res.json({ rows });
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// POST /api/forms/:id/fields — добавить поле.
router.post('/:id/fields', async (req, res) => {
  try {
    const f = await one(`SELECT id FROM forms WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL`, [req.params.id]);
    if (!f) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {};
    if (!b.label) return res.status(400).json({ error: 'label_required' });
    const key = b.field_key || b.key || ('field_' + crypto.randomBytes(3).toString('hex'));
    const row = await one(
      `INSERT INTO form_fields (form_id, page_index, section_title, field_type, field_key, label,
                                placeholder, help_text, is_required, default_value, options, validation,
                                conditional_rules, sort_order, is_hidden, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [f.id, b.page_index || 0, b.section_title || null, normType(b.field_type || b.type), key, b.label,
       b.placeholder || null, b.help_text || null, !!b.is_required, b.default_value ?? null,
       b.options ? JSON.stringify(b.options) : null, b.validation ? JSON.stringify(b.validation) : null,
       b.conditional_rules ? JSON.stringify(b.conditional_rules) : null,
       b.sort_order || 0, !!b.is_hidden, JSON.stringify(b.metadata || {})]);
    await rebuildFormFieldsJson(f.id);
    res.status(201).json(row);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'field_key_taken' });
    console.error(e); res.status(500).json({ error: dbErr(e) });
  }
});

// PUT /api/forms/:id/fields/reorder — изменить порядок полей. (до /:fieldId!)
router.put('/:id/fields/reorder', async (req, res) => {
  try {
    const order = Array.isArray(req.body?.order) ? req.body.order : [];
    if (!order.length) return res.status(400).json({ error: 'order_required' });
    for (let i = 0; i < order.length; i++) {
      await pool.query(
        `UPDATE form_fields SET sort_order=$1 WHERE id=$2 AND form_id=$3
           AND form_id IN (SELECT id FROM forms WHERE tenant_id=current_tenant_id())`,
        [i, order[i], req.params.id]);
    }
    await rebuildFormFieldsJson(req.params.id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// PUT /api/forms/:id/fields/:fieldId — обновить поле.
router.put('/:id/fields/:fieldId', async (req, res) => {
  try {
    const b = req.body || {};
    const allowed = {
      page_index: v => v, section_title: v => v, field_type: v => normType(v),
      field_key: v => v, label: v => v, placeholder: v => v, help_text: v => v,
      is_required: v => !!v, default_value: v => v,
      options: v => v == null ? null : JSON.stringify(v),
      validation: v => v == null ? null : JSON.stringify(v),
      conditional_rules: v => v == null ? null : JSON.stringify(v),
      sort_order: v => v, is_hidden: v => !!v, metadata: v => JSON.stringify(v || {}),
    };
    const sets = [], params = [];
    for (const k of Object.keys(allowed)) {
      const src = k === 'field_type' && b.type !== undefined && b.field_type === undefined ? b.type : b[k];
      if (src !== undefined) { params.push(allowed[k](src)); sets.push(`${k} = $${params.length}`); }
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    params.push(req.params.fieldId, req.params.id);
    const row = await one(
      `UPDATE form_fields SET ${sets.join(', ')}
       WHERE id=$${params.length - 1} AND form_id=$${params.length}
         AND form_id IN (SELECT id FROM forms WHERE tenant_id=current_tenant_id()) RETURNING *`, params);
    if (!row) return res.status(404).json({ error: 'not_found' });
    await rebuildFormFieldsJson(req.params.id);
    res.json(row);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'field_key_taken' });
    console.error(e); res.status(500).json({ error: dbErr(e) });
  }
});

// DELETE /api/forms/:id/fields/:fieldId — удалить поле.
router.delete('/:id/fields/:fieldId', async (req, res) => {
  try {
    const row = await one(
      `DELETE FROM form_fields WHERE id=$1 AND form_id=$2
         AND form_id IN (SELECT id FROM forms WHERE tenant_id=current_tenant_id()) RETURNING id`,
      [req.params.fieldId, req.params.id]);
    if (!row) return res.status(404).json({ error: 'not_found' });
    await rebuildFormFieldsJson(req.params.id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// ── Submissions (ответы) ──

// GET /api/forms/:id/submissions/export — экспорт (CSV/XLSX). (до /:subId!)
router.get('/:id/submissions/export', async (req, res) => {
  try {
    const f = await one(`SELECT id, title, fields FROM forms WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]);
    if (!f) return res.status(404).json({ error: 'not_found' });
    const subs = await q(
      `SELECT s.id, s.status, s.source, s.created_at, s.data, c.name AS client_name, c.phone AS client_phone
       FROM form_submissions s LEFT JOIN clients c ON c.id=s.client_id
       WHERE s.form_id=$1 AND s.tenant_id=current_tenant_id() AND s.deleted_at IS NULL
       ORDER BY s.created_at DESC`, [f.id]);
    const fieldDefs = Array.isArray(f.fields) ? f.fields : [];
    const headers = [
      { key: 'id', label: 'ID' }, { key: 'created_at', label: 'Дата' },
      { key: 'status', label: 'Статус' }, { key: 'source', label: 'Джерело' },
      { key: 'client_name', label: 'Клієнт' }, { key: 'client_phone', label: 'Телефон' },
      ...fieldDefs.map(fd => ({ key: `f_${fd.key}`, label: fd.label || fd.key })),
    ];
    const rows = subs.map(s => {
      const r = { id: s.id, created_at: s.created_at?.toISOString?.() || s.created_at, status: s.status, source: s.source, client_name: s.client_name, client_phone: s.client_phone };
      const d = s.data || {};
      for (const fd of fieldDefs) r[`f_${fd.key}`] = d[fd.key];
      return r;
    });
    const fmt = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
    const fname = `form-${f.id}-submissions-${Date.now()}`;
    if (fmt === 'xlsx') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}.xlsx"`);
      return res.send(toXlsx(rows, headers));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.csv"`);
    res.send(toCsv(rows, headers));
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// GET /api/forms/:id/submissions — список ответов (фильтры, сортировка, пагинация).
router.get('/:id/submissions', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const params = [req.params.id];
    const cond = ['s.form_id=$1', 's.tenant_id=current_tenant_id()', 's.deleted_at IS NULL'];
    if (req.query.status) { params.push(req.query.status); cond.push(`s.status=$${params.length}`); }
    if (req.query.starred === 'true') cond.push('s.is_starred = true');
    if (req.query.source) { params.push(req.query.source); cond.push(`s.source=$${params.length}`); }
    if (req.query.from) { params.push(req.query.from); cond.push(`s.created_at >= $${params.length}`); }
    if (req.query.to) { params.push(req.query.to + ' 23:59:59'); cond.push(`s.created_at <= $${params.length}`); }
    if (req.query.search) { params.push('%' + req.query.search + '%'); cond.push(`s.data::text ILIKE $${params.length}`); }
    // фильтр по значению конкретного поля: ?field_key=...&field_value=...
    if (req.query.field_key && req.query.field_value !== undefined) {
      params.push(req.query.field_key); const pk = params.length;
      params.push(String(req.query.field_value)); const pv = params.length;
      cond.push(`(s.data->>$${pk}) = $${pv}`);
    }
    const sortCol = req.query.sort === 'status' ? 's.status' : 's.created_at';
    const dir = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const rows = await q(
      `SELECT s.id, s.client_id, s.data, s.status, s.is_starred, s.source, s.device_type,
              s.duration_seconds, s.created_at, c.name AS client_name, c.phone AS client_phone
       FROM form_submissions s LEFT JOIN clients c ON c.id=s.client_id
       WHERE ${cond.join(' AND ')} ORDER BY ${sortCol} ${dir} LIMIT ${limit} OFFSET ${offset}`, params);
    const total = (await one(`SELECT count(*)::int n FROM form_submissions s WHERE ${cond.join(' AND ')}`, params)).n;
    res.json({ rows, total });
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// GET /api/forms/:id/submissions/:subId — детали одного заполнения.
router.get('/:id/submissions/:subId', async (req, res) => {
  try {
    const s = await one(
      `SELECT s.*, c.name AS client_name, c.phone AS client_phone
       FROM form_submissions s LEFT JOIN clients c ON c.id=s.client_id
       WHERE s.id=$1 AND s.form_id=$2 AND s.tenant_id=current_tenant_id() AND s.deleted_at IS NULL`,
      [req.params.subId, req.params.id]);
    if (!s) return res.status(404).json({ error: 'not_found' });
    const values = await q(`SELECT * FROM form_field_values WHERE submission_id=$1 ORDER BY id`, [s.id]);
    res.json({ ...s, values });
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// PUT /api/forms/:id/submissions/:subId — обновить статус/избранное.
router.put('/:id/submissions/:subId', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], params = [];
    if (b.status !== undefined) {
      if (!['new', 'reviewed', 'processed', 'archived'].includes(b.status)) return res.status(400).json({ error: 'invalid_status' });
      params.push(b.status); sets.push(`status=$${params.length}`);
      if (b.status === 'reviewed') { sets.push(`reviewed_at=now()`); params.push(req.user?.id || null); sets.push(`reviewed_by=$${params.length}`); }
    }
    if (b.is_starred !== undefined) { params.push(!!b.is_starred); sets.push(`is_starred=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    params.push(req.params.subId, req.params.id);
    const row = await one(
      `UPDATE form_submissions SET ${sets.join(', ')}
       WHERE id=$${params.length - 1} AND form_id=$${params.length}
         AND tenant_id=current_tenant_id() AND deleted_at IS NULL RETURNING *`, params);
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (b.status === 'reviewed') { try { emit('form.submission_reviewed', { submission_id: row.id, form_id: row.form_id }); } catch (_) {} }
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// DELETE /api/forms/:id/submissions/:subId — soft delete ответа.
router.delete('/:id/submissions/:subId', async (req, res) => {
  try {
    const row = await one(
      `UPDATE form_submissions SET deleted_at=now()
       WHERE id=$1 AND form_id=$2 AND tenant_id=current_tenant_id() AND deleted_at IS NULL RETURNING id`,
      [req.params.subId, req.params.id]);
    if (!row) return res.status(404).json({ error: 'not_found' });
    await logAction({ user: req.user, action: 'form.submission.delete', entity: 'form_submissions', entity_id: row.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// POST /api/forms/:id/submit — ответ из админки/ресепшн (авторизованный).
router.post('/:id/submit', async (req, res) => {
  try {
    const f = await one(`SELECT * FROM forms WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL`, [req.params.id]);
    if (!f) return res.status(404).json({ error: 'not_found' });
    return await handleSubmit(req, res, f, req.body?.source || 'direct_link');
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// ── Аналитика формы (08.05) ──
router.get('/:id/analytics', async (req, res) => {
  try {
    const f = await one(`SELECT id, fields, submit_count, view_count FROM forms WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL`, [req.params.id]);
    if (!f) return res.status(404).json({ error: 'not_found' });
    const from = req.query.from || '2000-01-01';
    const to = (req.query.to || '2999-12-31') + ' 23:59:59';

    const base = await one(
      `SELECT count(*)::int AS submissions,
              COALESCE(AVG(NULLIF(duration_seconds,0)),0)::numeric AS avg_duration
       FROM form_submissions WHERE form_id=$1 AND tenant_id=current_tenant_id()
         AND deleted_at IS NULL AND created_at BETWEEN $2 AND $3`, [f.id, from, to]);
    const views = (await one(
      `SELECT count(*)::int AS n FROM form_views WHERE form_id=$1 AND viewed_at BETWEEN $2 AND $3`, [f.id, from, to])).n;

    const bySource = await q(
      `SELECT COALESCE(source,'direct_link') AS source, count(*)::int AS n
       FROM form_submissions WHERE form_id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL
         AND created_at BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 2 DESC`, [f.id, from, to]);
    const byDevice = await q(
      `SELECT COALESCE(device_type,'desktop') AS device, count(*)::int AS n
       FROM form_submissions WHERE form_id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL
         AND created_at BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 2 DESC`, [f.id, from, to]);
    const byDay = await q(
      `SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') AS day, count(*)::int AS n
       FROM form_submissions WHERE form_id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL
         AND created_at BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 1`, [f.id, from, to]);

    // Распределение ответов по select/radio + средний рейтинг по rating/scale.
    const fieldDefs = Array.isArray(f.fields) ? f.fields : [];
    const distributions = {}, averages = {};
    for (const fd of fieldDefs) {
      const t = normType(fd.type);
      if (['select', 'radio'].includes(t)) {
        const dist = await q(
          `SELECT value_text AS value, count(*)::int AS n FROM form_field_values v
           JOIN form_submissions s ON s.id=v.submission_id
           WHERE v.field_key=$1 AND s.form_id=$2 AND s.deleted_at IS NULL AND v.value_text IS NOT NULL
           GROUP BY 1 ORDER BY 2 DESC`, [fd.key, f.id]);
        distributions[fd.key] = dist;
      } else if (['rating', 'scale'].includes(t)) {
        const avg = await one(
          `SELECT COALESCE(AVG(value_number),0)::numeric AS avg, count(*)::int AS n FROM form_field_values v
           JOIN form_submissions s ON s.id=v.submission_id
           WHERE v.field_key=$1 AND s.form_id=$2 AND s.deleted_at IS NULL AND v.value_number IS NOT NULL`, [fd.key, f.id]);
        averages[fd.key] = { avg: +Number(avg.avg).toFixed(2), count: avg.n };
      }
    }

    const submissions = Number(base.submissions);
    res.json({
      period: { from: req.query.from || '2000-01-01', to: req.query.to || 'now' },
      views, submissions,
      conversion_rate: views ? +(submissions / views * 100).toFixed(1) : 0,
      avg_duration_seconds: +Number(base.avg_duration).toFixed(1),
      total_views: Number(f.view_count), total_submissions: Number(f.submit_count),
      by_source: bySource, by_device: byDevice, by_day: byDay,
      distributions, averages,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// DELETE /api/forms/:id — soft delete формы.
router.delete('/:id', async (req, res) => {
  try {
    const row = await one(
      `UPDATE forms SET deleted_at=now() WHERE id=$1 AND tenant_id=current_tenant_id() AND deleted_at IS NULL RETURNING id`,
      [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not_found' });
    await logAction({ user: req.user, action: 'form.delete', entity: 'forms', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: dbErr(e) }); }
});

// ───────────────────────────────────────────────────────────────────────────
// ── Синхронизация JSONB-схемы (forms.fields) ↔ нормализованной (form_fields) ──
// ───────────────────────────────────────────────────────────────────────────

// Пересобрать form_fields из JSONB-схемы (полная замена).
async function syncFieldsTable(formId, fields) {
  try {
    await pool.query(`DELETE FROM form_fields WHERE form_id=$1`, [formId]);
    const arr = Array.isArray(fields) ? fields : [];
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];
      await pool.query(
        `INSERT INTO form_fields (form_id, page_index, section_title, field_type, field_key, label,
                                  placeholder, help_text, is_required, default_value, options, validation,
                                  conditional_rules, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (form_id, field_key) DO NOTHING`,
        [formId, f.page_index || 0, f.section_title || null, normType(f.type),
         f.key || `field_${i + 1}`, f.label || f.key || `Поле ${i + 1}`,
         f.placeholder || null, f.help_text || null, !!(f.required ?? f.is_required), f.default_value ?? null,
         f.options ? JSON.stringify(f.options) : null, f.validation ? JSON.stringify(f.validation) : null,
         f.conditional_rules ? JSON.stringify(f.conditional_rules) : null, i]);
    }
  } catch (e) { console.error('[forms] syncFieldsTable:', e.message); }
}

// Пересобрать forms.fields JSONB из нормализованной таблицы form_fields.
async function rebuildFormFieldsJson(formId) {
  try {
    const rows = await q(`SELECT * FROM form_fields WHERE form_id=$1 ORDER BY page_index, sort_order, id`, [formId]);
    const fields = rows.map(r => {
      const o = { key: r.field_key, label: r.label, type: r.field_type, required: r.is_required };
      if (r.options) o.options = r.options;
      if (r.placeholder) o.placeholder = r.placeholder;
      if (r.help_text) o.help_text = r.help_text;
      if (r.validation) o.validation = r.validation;
      if (r.conditional_rules) o.conditional_rules = r.conditional_rules;
      if (r.default_value != null) o.default_value = r.default_value;
      if (r.page_index) o.page_index = r.page_index;
      if (r.section_title) o.section_title = r.section_title;
      return o;
    });
    await pool.query(`UPDATE forms SET fields=$1, updated_at=now() WHERE id=$2`, [JSON.stringify(fields), formId]);
  } catch (e) { console.error('[forms] rebuildFormFieldsJson:', e.message); }
}

module.exports = router;
