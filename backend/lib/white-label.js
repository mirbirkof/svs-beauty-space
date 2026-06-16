/* lib/white-label.js — SAS-02 White Label / SAS-08 Branding.
   Движок тем: theme_variables (JSON camelCase) → CSS custom properties.
   Конфиг на тенанта, preview/publish/rollback с историей (до 10 версий),
   библиотека пресетов, powered-by gating по тарифу. Без CDN/ключей —
   CSS генерируется на лету, логотип хранится URL'ом. */
const { getPool } = require('../db-pg');

const DEFAULT_VARS = {
  colorPrimary: '#8B5CF6', colorSecondary: '#EC4899', colorAccent: '#F472B6',
  colorBg: '#FFFFFF', colorText: '#111827',
  fontHeading: 'Inter', fontBody: 'Inter', borderRadius: '12px',
};
const FREE_TIERS = ['free', 'starter', 'trial'];
const MAX_HISTORY = 10;

// camelCase → --kebab-case CSS-переменная.
function cssVarName(key) {
  return '--' + key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
}

// Безопасное значение CSS (отсекаем }, ; — защита от инъекции в таблицу стилей).
function safeVal(v) {
  return String(v).replace(/[{};<>]/g, '').trim().slice(0, 200);
}

// Сгенерировать CSS из переменных (+ опц. dark-блок + custom_css).
function compileCSS({ variables = {}, darkVariables = null, customCss = '' } = {}) {
  const vars = { ...DEFAULT_VARS, ...(variables || {}) };
  const toBlock = obj => Object.entries(obj)
    .map(([k, v]) => `  ${cssVarName(k)}: ${safeVal(v)};`).join('\n');
  let css = `:root {\n${toBlock(vars)}\n}\n`;
  if (darkVariables && Object.keys(darkVariables).length) {
    css += `@media (prefers-color-scheme: dark) {\n  :root {\n${toBlock(darkVariables).replace(/^/gm, '  ')}\n  }\n}\n`;
    css += `[data-theme="dark"] {\n${toBlock(darkVariables)}\n}\n`;
  }
  if (customCss && customCss.trim()) css += `\n/* custom */\n${customCss}\n`;
  return css;
}

// Получить (создать дефолтный) конфиг текущего тенанта.
async function getConfig() {
  const pool = getPool();
  let row = (await pool.query(`SELECT * FROM white_label_configs WHERE tenant_id=current_tenant_id() LIMIT 1`)).rows[0];
  if (!row) {
    row = (await pool.query(
      `INSERT INTO white_label_configs (tenant_id) VALUES (current_tenant_id())
       ON CONFLICT (tenant_id) DO UPDATE SET updated_at=NOW() RETURNING *`)).rows[0];
  }
  return row;
}

// Тариф тенанта (для powered-by gating).
async function tenantTier() {
  const lic = (await getPool().query(
    `SELECT plan_code FROM tenant_licenses WHERE tenant_id=current_tenant_id() LIMIT 1`)).rows[0];
  return (lic && lic.plan_code ? String(lic.plan_code) : 'free').toLowerCase();
}

// Можно ли скрыть «Powered by SVS CRM» (Professional+ и выше).
async function canHidePoweredBy() {
  const tier = await tenantTier();
  return !FREE_TIERS.includes(tier);
}

// Обновить конфиг (черновик/настройки). theme_variables идут в preview_variables (sandbox).
async function updateConfig(patch = {}) {
  const pool = getPool();
  await getConfig(); // гарантируем строку
  const cols = [], vals = []; let i = 1;
  const direct = ['app_name', 'logo_url', 'logo_dark_url', 'favicon_url',
    'email_from_name', 'email_from_address', 'email_reply_to',
    'telegram_bot_name', 'telegram_bot_avatar', 'custom_copyright', 'theme_preset_slug', 'custom_css'];
  for (const k of direct) if (patch[k] !== undefined) { cols.push(`${k}=$${i++}`); vals.push(patch[k]); }
  for (const k of ['dark_mode_variables', 'navigation_config']) {
    if (patch[k] !== undefined) { cols.push(`${k}=$${i++}`); vals.push(JSON.stringify(patch[k])); }
  }
  // theme_variables правим как preview (публикуется отдельно)
  if (patch.theme_variables !== undefined) { cols.push(`preview_variables=$${i++}`); vals.push(JSON.stringify(patch.theme_variables)); }
  // show_powered_by — только если тариф позволяет скрыть
  if (patch.show_powered_by !== undefined) {
    const show = patch.show_powered_by === false ? (await canHidePoweredBy() ? false : true) : true;
    cols.push(`show_powered_by=$${i++}`); vals.push(show);
  }
  if (!cols.length) return getConfig();
  cols.push('updated_at=NOW()');
  await pool.query(`UPDATE white_label_configs SET ${cols.join(', ')} WHERE tenant_id=current_tenant_id()`, vals);
  return getConfig();
}

// Применить пресет → его переменные становятся preview (потом publish).
async function applyPreset(slug) {
  const pool = getPool();
  const p = (await pool.query(`SELECT * FROM theme_presets WHERE slug=$1 AND is_active=true`, [slug])).rows[0];
  if (!p) throw new Error('preset-not-found');
  await getConfig();
  await pool.query(
    `UPDATE white_label_configs SET theme_preset_slug=$1, preview_variables=$2, dark_mode_variables=COALESCE($3, dark_mode_variables), updated_at=NOW()
     WHERE tenant_id=current_tenant_id()`,
    [slug, JSON.stringify(p.variables), p.dark_variables ? JSON.stringify(p.dark_variables) : null]);
  return getConfig();
}

// Опубликовать preview → theme_variables, +версия, снапшот в историю, обрезка до 10.
async function publish({ changeReason = null, userId = null } = {}) {
  const pool = getPool();
  const c = await getConfig();
  const newVars = c.preview_variables || c.theme_variables || {};
  const newVer = (c.version || 1) + 1;
  // снапшот текущей опубликованной версии перед перезаписью
  await pool.query(
    `INSERT INTO white_label_history (tenant_id, version, variables_snapshot, config_snapshot, changed_by, change_reason)
     VALUES (current_tenant_id(), $1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, version) DO NOTHING`,
    [newVer, JSON.stringify(newVars),
     JSON.stringify({ app_name: c.app_name, logo_url: c.logo_url, show_powered_by: c.show_powered_by,
       custom_css: c.custom_css, theme_preset_slug: c.theme_preset_slug }),
     userId, changeReason]);
  await pool.query(
    `UPDATE white_label_configs SET theme_variables=$1, preview_variables=NULL, version=$2, published_at=NOW(), updated_at=NOW()
     WHERE tenant_id=current_tenant_id()`,
    [JSON.stringify(newVars), newVer]);
  // обрезаем историю до MAX_HISTORY последних
  await pool.query(
    `DELETE FROM white_label_history WHERE tenant_id=current_tenant_id()
       AND version NOT IN (SELECT version FROM white_label_history WHERE tenant_id=current_tenant_id() ORDER BY version DESC LIMIT $1)`,
    [MAX_HISTORY]);
  return getConfig();
}

// Откат к версии из истории.
async function rollback(version) {
  const pool = getPool();
  const h = (await pool.query(
    `SELECT * FROM white_label_history WHERE tenant_id=current_tenant_id() AND version=$1`, [version])).rows[0];
  if (!h) throw new Error('version-not-found');
  await pool.query(
    `UPDATE white_label_configs SET theme_variables=$1, preview_variables=NULL, updated_at=NOW()
     WHERE tenant_id=current_tenant_id()`,
    [JSON.stringify(h.variables_snapshot)]);
  return getConfig();
}

async function history(limit = 20) {
  const r = await getPool().query(
    `SELECT version, change_reason, changed_by, created_at FROM white_label_history
      WHERE tenant_id=current_tenant_id() ORDER BY version DESC LIMIT $1`, [Math.min(limit, 50)]);
  return r.rows;
}

// Preview CSS (использует preview_variables если есть, иначе опубликованные).
function previewCSS(c) {
  return compileCSS({
    variables: c.preview_variables || c.theme_variables,
    darkVariables: c.dark_mode_variables, customCss: c.custom_css,
  });
}

// Опубликованный CSS темы (для клиентских интерфейсов/виджета).
function publishedCSS(c) {
  return compileCSS({
    variables: c.theme_variables, darkVariables: c.dark_mode_variables, customCss: c.custom_css,
  });
}

// Публичная карточка бренда (для виджета/PWA).
async function brand() {
  const c = await getConfig();
  const hideAllowed = await canHidePoweredBy();
  return {
    app_name: c.app_name, logo_url: c.logo_url, logo_dark_url: c.logo_dark_url,
    favicon_url: c.favicon_url,
    show_powered_by: hideAllowed ? c.show_powered_by : true,
    custom_copyright: c.custom_copyright,
    theme_variables: { ...DEFAULT_VARS, ...(c.theme_variables || {}) },
  };
}

async function listPresets(category = null) {
  const pool = getPool();
  const r = category
    ? await pool.query(`SELECT * FROM theme_presets WHERE is_active=true AND category=$1 ORDER BY sort_order`, [category])
    : await pool.query(`SELECT * FROM theme_presets WHERE is_active=true ORDER BY sort_order`);
  return r.rows;
}

async function upsertPreset(b = {}) {
  if (!b.slug || !b.name || !b.variables) throw new Error('slug-name-variables-required');
  const r = await getPool().query(
    `INSERT INTO theme_presets (name, slug, description, thumbnail_url, variables, dark_variables, category, is_premium, sort_order, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,true))
     ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description,
       thumbnail_url=EXCLUDED.thumbnail_url, variables=EXCLUDED.variables, dark_variables=EXCLUDED.dark_variables,
       category=EXCLUDED.category, is_premium=EXCLUDED.is_premium, sort_order=EXCLUDED.sort_order,
       is_active=EXCLUDED.is_active, updated_at=NOW() RETURNING *`,
    [b.name, b.slug, b.description || null, b.thumbnail_url || null,
     JSON.stringify(b.variables), b.dark_variables ? JSON.stringify(b.dark_variables) : null,
     b.category || 'general', !!b.is_premium, b.sort_order || 0, b.is_active]);
  return r.rows[0];
}

module.exports = {
  compileCSS, cssVarName, getConfig, updateConfig, applyPreset, publish, rollback,
  history, previewCSS, publishedCSS, brand, listPresets, upsertPreset,
  canHidePoweredBy, DEFAULT_VARS,
};
