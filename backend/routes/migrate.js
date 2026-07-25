/* ═══════════════════════════════════════════════════════
   Майстер міграції з іншої CRM — «перенос за кілька кліків».

   GET  /api/migrate/presets            — список джерел і сутностей
   POST /api/migrate/analyze   { csv, entity? }
        → визначає сутність (клієнти/послуги/майстри), сопоставляє
          стовпці, повертає превʼю перших рядків. НІЧОГО НЕ ПИШЕ.
   POST /api/migrate/commit    { csv, entity, mapping? }
        → переносить з дедупом, повертає построчний звіт.

   Будь-яка CRM експортує у CSV/Excel → цей файл приймається,
   стовпці визначаються автоматично за словником синонімів.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const { normalizePhoneDb } = require('../lib/phone');
const M = require('../lib/migration-presets');
const XLSX = require('../lib/xlsx-lite');

router.use(requirePerm('clients.write'));

const MAX_PREVIEW = 8;

// ── Список джерел і підтримуваних сутностей ──
router.get('/presets', (req, res) => {
  res.json({
    ok: true,
    sources: M.SOURCE_PRESETS,
    entities: Object.fromEntries(
      Object.entries(M.ENTITIES).map(([id, e]) => [id, { label: e.label, fields: Object.keys(e.fields), key: e.key }])
    ),
  });
});

// Превратить тело запроса (CSV-текст или xlsx в base64) в { headerRow, dataRows }
// или бросить понятную ошибку. Excel .xlsx розпізнається автоматично — клієнту
// не треба «Зберегти як CSV».
function parseRows(body) {
  // 1) Excel .xlsx у base64 (поле xlsx_base64) або data-URL
  const b64 = body && (body.xlsx_base64 || body.xlsx);
  if (b64 && typeof b64 === 'string') {
    const clean = b64.replace(/^data:[^,]*,/, ''); // зрізати data:...;base64,
    let buf;
    try { buf = Buffer.from(clean, 'base64'); }
    catch { const e = new Error('Не вдалось декодувати файл Excel.'); e.code = 'bad-xlsx'; throw e; }
    if (!XLSX.isXlsx(buf)) { const e = new Error('Файл не схожий на .xlsx. Підійде також CSV.'); e.code = 'bad-xlsx'; throw e; }
    let rows;
    try { rows = XLSX.parseXlsx(buf); }
    catch (err) { const e = new Error('Не вдалось прочитати книгу Excel: ' + err.message); e.code = 'bad-xlsx'; throw e; }
    if (rows.length < 2) { const e = new Error('У файлі Excel потрібен заголовок і хоча б один рядок даних.'); e.code = 'empty'; throw e; }
    return { headerRow: rows[0], dataRows: rows.slice(1) };
  }
  // 2) CSV-текст (поле csv або text)
  const csv = body && (body.csv != null ? body.csv : body.text);
  if (!csv || typeof csv !== 'string') {
    const err = new Error('Передайте { csv: "<текст>" } або { xlsx_base64: "<...>" }. Ліміт тіла ~12MB.'); err.code = 'no-csv'; throw err;
  }
  const rows = M.parseCsv(csv);
  if (rows.length < 2) { const err = new Error('Потрібен заголовок і хоча б один рядок даних.'); err.code = 'empty'; throw err; }
  return { headerRow: rows[0], dataRows: rows.slice(1) };
}

// ── Аналіз: що це і як ляже, без запису ──
router.post('/analyze', (req, res) => {
  try {
    const { headerRow, dataRows } = parseRows(req.body);
    const entity = (req.body && req.body.entity) || M.detectEntity(headerRow);
    if (!entity || !M.ENTITIES[entity]) {
      return res.status(422).json({ ok: false, error: 'unknown-entity',
        hint: 'Не вдалось визначити що це за дані. Оберіть тип вручну (клієнти/послуги/майстри).',
        headers: headerRow });
    }
    const colMap = M.buildColMap(entity, headerRow);
    const recognized = colMap.map((f, i) => ({ column: headerRow[i], field: f })).filter(x => x.field);
    const ignored = headerRow.filter((_, i) => !colMap[i]);
    const hasKey = M.ENTITIES[entity].key.some(k => colMap.includes(k));

    // Превʼю: перші строки в нормалізованому вигляді
    const preview = dataRows.slice(0, MAX_PREVIEW).map(cells => {
      const rec = {};
      colMap.forEach((f, i) => { if (f) rec[f] = (cells[i] != null ? String(cells[i]).trim() : ''); });
      return rec;
    });

    res.json({
      ok: true, entity, entity_label: M.ENTITIES[entity].label,
      total_rows: dataRows.length, has_key: hasKey,
      recognized, ignored, preview,
      // для ручного перемаппінгу в UI: всі заголовки, поточна карта і доступні поля
      headers: headerRow, col_map: colMap,
      fields: Object.keys(M.ENTITIES[entity].fields),
      key_fields: M.ENTITIES[entity].key,
      ready: hasKey,
      warn: hasKey ? null : `Не знайдено ключову колонку (${M.ENTITIES[entity].key.join(' або ')}). Перенос неможливий без неї.`,
    });
  } catch (e) {
    res.status(['no-csv','empty','bad-xlsx'].includes(e.code) ? 400 : 500).json({ ok: false, error: e.code || 'analyze-failed', hint: e.message });
  }
});

// ── Імпортери по сутностям ──
async function importClients(pool, colMap, dataRows, user, ip) {
  const rep = { total: dataRows.length, imported: 0, updated: 0, skipped: 0, errors: [] };
  for (let r = 0; r < dataRows.length; r++) {
    const cells = dataRows[r]; const rec = {};
    colMap.forEach((f, i) => { if (f) rec[f] = (cells[i] != null ? String(cells[i]).trim() : ''); });
    const phone = normalizePhoneDb(rec.phone);
    const name = (rec.name || '').trim();
    if (!phone && !name) { rep.skipped++; continue; }
    try {
      if (!phone) {
        await pool.query(`INSERT INTO clients (phone, name, email, birthday, source, notes) VALUES (NULL,$1,$2,$3,$4,$5)`,
          [name, rec.email || null, M.toDateOrNull(rec.birthday), rec.source || 'migrate', rec.notes || null]);
        rep.imported++; continue;
      }
      const q = await pool.query(
        `INSERT INTO clients (phone, name, email, birthday, source, notes) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, phone) DO UPDATE SET
           name=COALESCE(NULLIF(clients.name,''),EXCLUDED.name),
           email=COALESCE(clients.email,EXCLUDED.email),
           birthday=COALESCE(clients.birthday,EXCLUDED.birthday),
           notes=COALESCE(NULLIF(clients.notes,''),EXCLUDED.notes),
           updated_at=NOW()
         RETURNING (xmax=0) AS inserted`,
        [phone, name || null, rec.email || null, M.toDateOrNull(rec.birthday), rec.source || 'migrate', rec.notes || null]);
      if (q.rows[0] && q.rows[0].inserted) rep.imported++; else rep.updated++;
    } catch (e) { rep.errors.push({ line: r + 2, error: e.code || e.message }); }
  }
  return rep;
}

async function importServices(pool, colMap, dataRows) {
  const rep = { total: dataRows.length, imported: 0, updated: 0, skipped: 0, errors: [] };
  for (let r = 0; r < dataRows.length; r++) {
    const cells = dataRows[r]; const rec = {};
    colMap.forEach((f, i) => { if (f) rec[f] = (cells[i] != null ? String(cells[i]).trim() : ''); });
    const name = (rec.name || '').trim();
    if (!name) { rep.skipped++; continue; }
    const price = M.toNumberOrNull(rec.price);
    const dur = M.toNumberOrNull(rec.duration_min);
    try {
      // Дедуп по (tenant_id, name): якщо така послуга вже є — оновлюємо порожні поля.
      const ex = await pool.query(`SELECT id FROM services WHERE lower(name)=lower($1) AND deleted_at IS NULL LIMIT 1`, [name]);
      if (ex.rows[0]) {
        await pool.query(
          `UPDATE services SET
             category=COALESCE(NULLIF(category,''),$2),
             price=COALESCE(price,$3), duration_min=COALESCE(duration_min,$4),
             description=COALESCE(NULLIF(description,''),$5), updated_at=NOW()
           WHERE id=$1`,
          [ex.rows[0].id, rec.category || null, price, dur != null ? Math.round(dur) : null, rec.description || null]);
        rep.updated++;
      } else {
        await pool.query(
          `INSERT INTO services (name, category, price, duration_min, description, active)
           VALUES ($1,$2,$3,$4,$5,true)`,
          [name, rec.category || null, price, dur != null ? Math.round(dur) : null, rec.description || null]);
        rep.imported++;
      }
    } catch (e) { rep.errors.push({ line: r + 2, error: e.code || e.message }); }
  }
  return rep;
}

async function importMasters(pool, colMap, dataRows) {
  const rep = { total: dataRows.length, imported: 0, updated: 0, skipped: 0, errors: [] };
  for (let r = 0; r < dataRows.length; r++) {
    const cells = dataRows[r]; const rec = {};
    colMap.forEach((f, i) => { if (f) rec[f] = (cells[i] != null ? String(cells[i]).trim() : ''); });
    const name = (rec.name || '').trim();
    if (!name) { rep.skipped++; continue; }
    const phone = normalizePhoneDb(rec.phone);
    try {
      const ex = await pool.query(`SELECT id FROM masters WHERE lower(name)=lower($1) LIMIT 1`, [name]);
      if (ex.rows[0]) {
        await pool.query(
          `UPDATE masters SET phone=COALESCE(phone,$2), email=COALESCE(email,$3),
             specialty=COALESCE(NULLIF(specialty,''),$4), surname=COALESCE(NULLIF(surname,''),$5)
           WHERE id=$1`,
          [ex.rows[0].id, phone || null, rec.email || null, rec.specialty || null, rec.surname || null]);
        rep.updated++;
      } else {
        await pool.query(
          `INSERT INTO masters (name, phone, email, specialty, surname, active) VALUES ($1,$2,$3,$4,$5,true)`,
          [name, phone || null, rec.email || null, rec.specialty || null, rec.surname || null]);
        rep.imported++;
      }
    } catch (e) { rep.errors.push({ line: r + 2, error: e.code || e.message }); }
  }
  return rep;
}

/* ── Імпорт ІСТОРІЇ ВІЗИТІВ — серце «айфона в світі інтеграцій» (Бос 25.07) ────
   Після нього нова CRM виглядає так, ніби салон завжди вів її: у клієнтів зʼявляється
   перший візит, історія, суми — і вся аналітика (норми повернення, RFM, апсейл)
   починає працювати на повній глибині. Правила:
   • клієнт шукається за телефоном, потім за імʼям; не знайдений — СТВОРЮЄТЬСЯ
     (телефон може бути відсутній у вивантаженні — це нормально для історії)
   • майстер зіставляється за іменем (без ролей/дужок, порядок слів неважливий);
     не знайдений — візит іде без майстра, імʼя зберігається в нотатці
   • дублікат = той самий клієнт + той самий момент часу → пропуск (ідемпотентно)
   • усе позначається import_batch → один клік «відкотити пакет»
   • після імпорту — повний перерахунок лічильників клієнтів (first_visit_at і далі) */
const V = require('../lib/visits-import');

function parseAnyDate(sRaw) {
  const s0 = String(sRaw || '').trim();
  // дд.мм.рр(рр) [гг:хв]
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:[\sT]+(\d{1,2}):(\d{2}))?/.exec(s0);
  if (m) {
    const yyyy = m[3].length === 2 ? '20' + m[3] : m[3];
    return { date: `${yyyy}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`,
             time: m[4] != null ? `${m[4].padStart(2, '0')}:${m[5]}` : '12:00' };
  }
  // yyyy-mm-dd [hh:mm]
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[\sT]+(\d{1,2}):(\d{2}))?/.exec(s0);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] != null ? `${m[4].padStart(2, '0')}:${m[5]}` : '12:00' };
  return null;
}

async function importVisits(pool, colMap, dataRows, user, ip) {
  const rep = { total: dataRows.length, imported: 0, updated: 0, skipped: 0, errors: [] };
  const now = new Date();
  const batch = `migrate_${now.toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
  rep.batch = batch;

  // майстри: стійкий ключ (імʼя без ролей, слова відсортовані)
  const masters = (await pool.query(`SELECT id, name FROM masters`)).rows;
  const masterByKey = new Map();
  for (const m of masters) { const k = V.masterKey(m.name); if (k) masterByKey.set(k, m.id); }

  // клієнти: за телефоном і за нормалізованим імʼям
  const clients = (await pool.query(`SELECT id, phone, name FROM clients WHERE deleted_at IS NULL`)).rows;
  const byPhone = new Map(), byName = new Map();
  const nname = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const c of clients) {
    if (c.phone) byPhone.set(String(c.phone), c.id);
    const k = nname(c.name); if (k && !byName.has(k)) byName.set(k, c.id);
  }
  // ліміт плану max_clients: імпорт історії створює нових клієнтів і не сміє
  // обходити тариф (той самий блокер F2, що в /api/import/clients)
  let clientCap = Infinity;
  try {
    const planLimit = await require('../lib/plan-limits').getPlanLimit('max_clients');
    if (planLimit != null) clientCap = Math.max(0, planLimit - clients.length);
  } catch (_) { /* fail-open */ }

  for (let r = 0; r < dataRows.length; r++) {
    const cells = dataRows[r]; const rec = {};
    colMap.forEach((f, i) => { if (f) rec[f] = (cells[i] != null ? String(cells[i]).trim() : ''); });
    try {
      const dt = parseAnyDate(rec.date);
      const clientName = (rec.client || '').trim();
      if (!dt) { rep.skipped++; continue; }               // рядок без дати — не візит
      if (!clientName && !rec.phone) { rep.skipped++; continue; }

      // статус: порожній у вивантаженні історії = «відбувся»
      const status = rec.status ? (V.mapStatus(rec.status) || 'done') : 'done';
      const price = M.toNumberOrNull(rec.price);
      const durMin = Math.max(15, Math.min(600, Number(String(rec.duration || '').replace(/[^0-9]/g, '')) || 60));

      // клієнт: телефон → імʼя → створити
      const phone = rec.phone ? normalizePhoneDb(rec.phone) : null;
      let clientId = (phone && byPhone.get(phone)) || byName.get(nname(clientName)) || null;
      if (!clientId) {
        if (clientCap <= 0) { rep.errors.push({ line: r + 2, error: 'plan-limit: max_clients вичерпано' }); continue; }
        const ins = await pool.query(
          `INSERT INTO clients (phone, name, source, notes) VALUES ($1, $2, 'migrate', $3) RETURNING id`,
          [phone, clientName || null, 'створено імпортом історії візитів']);
        clientId = ins.rows[0].id; clientCap--;
        if (phone) byPhone.set(phone, clientId);
        if (clientName) byName.set(nname(clientName), clientId);
      }

      const masterId = masterByKey.get(V.masterKey(rec.master)) || null;

      // дубль: той самий клієнт у той самий момент (ідемпотентність повторного файлу)
      const dupe = await pool.query(
        `SELECT 1 FROM appointments
          WHERE client_id = $1
            AND starts_at = (($2 || ' ' || $3)::timestamp AT TIME ZONE 'Europe/Kyiv') LIMIT 1`,
        [clientId, dt.date, dt.time]);
      if (dupe.rows[0]) { rep.skipped++; continue; }

      await pool.query(
        `INSERT INTO appointments
           (client_id, master_id, starts_at, ends_at, status, price, real_amount,
            services_text, client_name, source, import_batch, notes)
         VALUES ($1, $2,
                 (($3 || ' ' || $4)::timestamp AT TIME ZONE 'Europe/Kyiv'),
                 (($3 || ' ' || $4)::timestamp AT TIME ZONE 'Europe/Kyiv') + ($5 || ' minutes')::interval,
                 $6, $7, $8, $9, $10, 'migrate', $11, $12)`,
        [clientId, masterId, dt.date, dt.time, String(durMin),
         status, price, status === 'done' ? price : null,
         rec.service || null, clientName || null, batch,
         masterId ? null : (rec.master ? `Майстер з імпорту: ${rec.master}` : null)]);
      rep.imported++;
    } catch (e) { rep.errors.push({ line: r + 2, error: e.code || e.message }); }
  }

  // «ніби завжди вели цю CRM»: first_visit_at, total_spent, total_visits — з першоджерела
  try {
    const n = await require('../lib/client-stats').recalcClientStats(null);
    rep.recalced_clients = n;
  } catch (e) { rep.errors.push({ line: 0, error: 'recalc: ' + e.message }); }
  return rep;
}

/* ── Імпорт ТОВАРІВ І ЗАЛИШКІВ (стартовий склад при переїзді) ──────────────────
   Правила безпеки: існуючий товар (за назвою або SKU) НЕ чіпаємо — живий склад
   важливіший за файл. Новий — створюється з початковим залишком, рух 'migrate-opening'
   пише книгу складу з нуля (інвентаризація «з коробки»). */
async function importProducts(pool, colMap, dataRows, user, ip) {
  const rep = { total: dataRows.length, imported: 0, updated: 0, skipped: 0, errors: [] };
  const existing = (await pool.query(
    `SELECT lower(trim(p.name)) AS n, lower(trim(COALESCE(pv.sku,''))) AS sku
       FROM products p LEFT JOIN product_variants pv ON pv.product_id = p.id`)).rows;
  const byName = new Set(existing.map(x => x.n));
  const bySku = new Set(existing.map(x => x.sku).filter(Boolean));
  for (let r = 0; r < dataRows.length; r++) {
    const cells = dataRows[r]; const rec = {};
    colMap.forEach((f, i) => { if (f) rec[f] = (cells[i] != null ? String(cells[i]).trim() : ''); });
    const name = (rec.name || '').trim();
    if (!name) { rep.skipped++; continue; }
    const sku = (rec.sku || '').trim() || null;
    if (byName.has(name.toLowerCase()) || (sku && bySku.has(sku.toLowerCase()))) { rep.skipped++; continue; }
    try {
      const qty = M.toNumberOrNull(rec.qty) || 0;
      // products.id — текстовий slug (та сама схема, що у stock-import)
      const { slugify } = require('../lib/stock-import');
      let pid = slugify(name) || ('imp-' + r);
      for (let i = 2; i < 30; i++) {
        const dup = await pool.query(`SELECT 1 FROM products WHERE id = $1`, [pid]);
        if (!dup.rows[0]) break;
        pid = `${slugify(name)}-${i}`;
      }
      const prod = await pool.query(
        `INSERT INTO products (id, name, active, description) VALUES ($1, $2, TRUE, $3) RETURNING id`,
        [pid, name, rec.category ? `Категорія з імпорту: ${rec.category}` : null]);
      // price у variants — NOT NULL: без ціни у файлі ставимо 0 (адмін виставить у складі)
      const variant = await pool.query(
        `INSERT INTO product_variants (product_id, volume, price, wholesale, sku, stock_qty, active)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id`,
        [prod.rows[0].id, rec.volume || rec.unit || null,
         M.toNumberOrNull(rec.price) ?? 0, M.toNumberOrNull(rec.wholesale), sku, qty]);
      if (qty > 0) {
        await pool.query(
          `INSERT INTO stock_movements (variant_id, delta, reason, notes)
           VALUES ($1, $2, 'migrate-opening', 'початковий залишок з міграції')`,
          [variant.rows[0].id, qty]);
      }
      byName.add(name.toLowerCase()); if (sku) bySku.add(sku.toLowerCase());
      rep.imported++;
    } catch (e) { rep.errors.push({ line: r + 2, error: e.code || e.message }); }
  }
  return rep;
}

const IMPORTERS = { clients: importClients, services: importServices, masters: importMasters, visits: importVisits, products: importProducts };

// ── Застосувати перенос ──
router.post('/commit', async (req, res) => {
  try {
    const { headerRow, dataRows } = parseRows(req.body);
    const entity = (req.body && req.body.entity) || M.detectEntity(headerRow);
    if (!entity || !IMPORTERS[entity]) return res.status(422).json({ ok: false, error: 'unknown-entity' });
    // Ручний перемаппінг (25.07): якщо авто-розпізнавання помилилось, UI шле mapping —
    // масив імен полів по колонках (null/'' = ігнорувати колонку). Валідуємо по словнику.
    let colMap;
    const manual = req.body && Array.isArray(req.body.mapping) ? req.body.mapping : null;
    if (manual) {
      const allowed = new Set(Object.keys(M.ENTITIES[entity].fields));
      colMap = headerRow.map((_, i) => (manual[i] && allowed.has(manual[i]) ? manual[i] : null));
    } else {
      colMap = M.buildColMap(entity, headerRow);
    }
    if (!M.ENTITIES[entity].key.some(k => colMap.includes(k))) {
      return res.status(400).json({ ok: false, error: 'no-key-column',
        hint: `Потрібна колонка: ${M.ENTITIES[entity].key.join(' або ')}.` });
    }
    const pool = getPool();
    const rep = await IMPORTERS[entity](pool, colMap, dataRows, req.user, req.ip);
    logAction({ user: req.user, action: 'migrate.commit', entity, entity_id: null, ip: req.ip,
      meta: { total: rep.total, imported: rep.imported, updated: rep.updated, skipped: rep.skipped, errors: rep.errors.length } }).catch(() => {});
    res.json({ ok: true, entity, ...rep, errors: rep.errors.slice(0, 50) });
  } catch (e) {
    res.status(['no-csv','empty','bad-xlsx'].includes(e.code) ? 400 : 500).json({ ok: false, error: e.code || 'commit-failed', hint: e.message });
  }
});

// ── Відкат пакета імпорту візитів: одна кнопка «передумав» ────────────────────
// Видаляються ЛИШЕ рядки цього пакета з source='migrate' — живі дані недоторкані.
router.post('/rollback', async (req, res) => {
  try {
    const batch = String(req.body?.batch || '').trim();
    if (!/^migrate_[0-9-]+$/.test(batch)) return res.status(400).json({ ok: false, error: 'bad-batch' });
    const pool = getPool();
    const del = await pool.query(
      `DELETE FROM appointments WHERE import_batch = $1 AND source = 'migrate' RETURNING id`, [batch]);
    const n = await require('../lib/client-stats').recalcClientStats(null).catch(() => 0);
    logAction({ user: req.user, action: 'migrate.rollback', entity: 'appointments', entity_id: null, ip: req.ip,
      meta: { batch, removed: del.rowCount } }).catch(() => {});
    res.json({ ok: true, batch, removed: del.rowCount, recalced_clients: n });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
