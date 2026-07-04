/* ═══════════════════════════════════════════════════════════════
   Імпорт складу через накладні та прайси.

   POST /api/stock-import/parse   — файл (multipart, поле file: xlsx/csv/txt) АБО {text}
                                    → розібрані рядки + топ-3 збіги зі складу для кожного
   POST /api/stock-import/apply   — {kind:'invoice'|'pricelist', filename, items:[...]}
        invoice:   item.variant_id → прихід qty (+stock_movements, reason='invoice')
                   item.create=true → створити товар+варіант і одразу прихід
        pricelist: створює товар+варіант (залишок 0), існуючі (variant_id) пропускає
        Все в одній транзакції; документ цілком лягає в stock_import_docs (аудит).
   GET  /api/stock-import/docs    — останні 20 документів
   ═══════════════════════════════════════════════════════════════ */
const express = require('express');
const multer = require('multer');
const { getPool, applyTenant } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const imp = require('../lib/stock-import');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

router.post('/parse', requirePerm('stock.write'), upload.single('file'), async (req, res) => {
  try {
    let rows, rawText = '', fname = req.file ? req.file.originalname : null, ocrDate = null, viaOcr = false, ocrMeta = null;
    if (req.file) {
      // Фото/скріншот/PDF → OCR через Gemini vision (вимога: формат не має значення).
      const buf = req.file.buffer;
      const magic = buf.slice(0, 4).toString('hex');
      const isImage = /^(ffd8|8950|4749|424d)/.test(magic) || /^image\//.test(req.file.mimetype || '') ||
        /\.(jpe?g|png|gif|bmp|heic|heif|webp)$/i.test(fname || '');
      const isPdf = magic.startsWith('2550') || /\.pdf$/i.test(fname || '');
      if (isImage || isPdf) {
        const { ocrInvoice } = require('../lib/invoice-ocr');
        const mime = isPdf ? 'application/pdf'
          : (/^image\//.test(req.file.mimetype || '') ? req.file.mimetype
            : (magic.startsWith('8950') ? 'image/png' : 'image/jpeg'));
        try {
          const ocr = await ocrInvoice(buf, mime);
          rows = ocr.items; ocrDate = ocr.doc_date; viaOcr = true;
          ocrMeta = { doc_number: ocr.doc_number, supplier: ocr.supplier, total_sum: ocr.total_sum };
          console.log(`[stock-import] OCR ${ocr.model}: ${rows.length} рядків, дата ${ocrDate || '—'}, №${ocr.doc_number || '—'}, підсумок ${ocr.total_sum ?? '—'}`);
        } catch (e) {
          return res.status(400).json({ error: 'ocr-failed', message: e.message });
        }
      } else {
        rows = imp.parseUpload(req.file.originalname, buf);
      }
      if (!viaOcr && !/\.(xlsx|xls)$/i.test(fname || '')) {
        rawText = buf.toString('utf8');
        // друга лінія захисту: бінарник під виглядом .txt → багато нечитабельних символів
        const sample = rawText.slice(0, 2000);
        let junk = 0;
        for (let ci = 0; ci < sample.length; ci++) {
          const cc = sample.charCodeAt(ci);
          if (cc === 0xFFFD || cc < 9 || (cc > 13 && cc < 32)) junk++;
        }
        if (sample.length > 50 && junk / sample.length > 0.05) {
          return res.status(400).json({ error: 'binary-file',
            message: 'Файл не схожий на текст (можливо, це фото чи архів). Надішліть Excel/CSV або вставте текст накладної.' });
        }
      }
    } else if (req.body && req.body.text) { rows = imp.parseText(req.body.text); rawText = req.body.text; }
    else return res.status(400).json({ error: 'no-input', message: 'Дайте файл або текст' });
    if (!rows.length) return res.json({ ok: true, items: [], message: 'Не знайшов жодного рядка з товаром' });
    if (rows.length > 500) rows = rows.slice(0, 500);
    const items = await imp.matchRows(getPool(), rows);
    // дата накладної: OCR бачив сам документ → його дата головна; інакше з тексту/імені файлу
    const doc_date = ocrDate || imp.extractDocDate(rawText, fname);
    res.json({ ok: true, items, filename: fname, doc_date, via_ocr: viaOcr || undefined, ocr: ocrMeta || undefined });
  } catch (e) {
    console.error('[stock-import/parse]', e.message);
    res.status(500).json({ error: 'parse-failed', message: 'Не вдалося розібрати документ: ' + e.message });
  }
});

router.post('/apply', requirePerm('stock.write'), async (req, res) => {
  const { kind, filename, items, doc_date, force } = req.body || {};
  if (!['invoice', 'pricelist'].includes(kind)) return res.status(400).json({ error: 'bad-kind' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'no-items' });
  if (items.length > 500) return res.status(400).json({ error: 'too-many-items' });

  const pool = getPool();

  // ── ДАТА НАКЛАДНОЇ — обовʼязкова і контрольована (вимога: завжди!) ──
  let docDate = null;
  if (kind === 'invoice') {
    docDate = String(doc_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(docDate))
      return res.status(400).json({ error: 'doc-date-required', message: 'Вкажіть дату накладної (обовʼязково)' });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
    if (docDate > today)
      return res.status(400).json({ error: 'doc-date-future', message: `Дата накладної ${docDate} у майбутньому — перевірте документ` });
    // захист від повторного проведення тієї ж накладної (та сама дата + файл/без файлу)
    if (!force) {
      const dup = await pool.query(
        `SELECT id, created_at FROM stock_import_docs
          WHERE kind='invoice' AND doc_date=$1 AND COALESCE(filename,'')=COALESCE($2,'')
          ORDER BY id DESC LIMIT 1`, [docDate, filename || null]);
      if (dup.rows[0])
        return res.status(409).json({ error: 'duplicate-doc', doc_id: dup.rows[0].id,
          message: `Накладна з датою ${docDate}${filename ? ` (${filename})` : ''} вже проводилась (док №${dup.rows[0].id}). Провести ще раз?` });
    }
  }

  const client = await pool.connect();
  const result = { received: 0, created: 0, skipped: 0, lines: [] };
  try {
    await client.query('BEGIN');
    await applyTenant(client);
    let docId = null;
    for (const it of items) {
      const qty = Number(it.qty);
      const name = String(it.name || '').trim().slice(0, 200);

      if (kind === 'invoice') {
        if (!Number.isFinite(qty) || qty <= 0) { result.skipped++; result.lines.push({ name, status: 'skip', why: 'кількість' }); continue; }
        let variantId = it.variant_id ? Number(it.variant_id) : null;
        if (!variantId && it.create) {
          variantId = await createItem(client, name, it.price);
          if (!variantId) { result.skipped++; result.lines.push({ name, status: 'skip', why: 'створення' }); continue; }
          result.created++;
        }
        if (!variantId) { result.skipped++; result.lines.push({ name, status: 'skip', why: 'нема збігу' }); continue; }
        // товар «за грам/мл» (unit_ml > 1): кількість у накладній — ПЛЯШКИ/УПАКОВКИ,
        // а склад ведеться в мл/г → приход = qty × unit_ml. Інакше +5 замість +5000 мл.
        const vinfo = await client.query(`SELECT unit_ml::float AS unit_ml FROM product_variants WHERE id=$1`, [variantId]);
        if (!vinfo.rows[0]) { result.skipped++; result.lines.push({ name, status: 'skip', why: 'варіант зник' }); continue; }
        const unitMl = Number(vinfo.rows[0].unit_ml) || 0;
        const asUnits = it.unit === 'ml' ? false : unitMl > 1; // накладна в штуках за замовч.; unit:'ml' — явно в мл
        const delta = asUnits ? qty * unitMl : qty;
        await client.query(
          `UPDATE product_variants SET stock_qty = COALESCE(stock_qty,0) + $2 WHERE id = $1`,
          [variantId, delta]);
        await client.query(
          `INSERT INTO stock_movements (variant_id, delta, reason, notes) VALUES ($1,$2,'invoice',$3)`,
          [variantId, delta,
           `Накладна ${docDate}: ${name}${asUnits ? ` (${qty} уп × ${unitMl} мл)` : ''}`.slice(0, 200)]);
        if (it.price && Number(it.price) > 0) {
          // закупівельна ціна: якщо прихід у мл — перерахувати ціну упаковки на одиницю обліку
          const wholesale = asUnits ? Number(it.price) : Number(it.price);
          await client.query(`UPDATE product_variants SET wholesale = $2 WHERE id = $1`, [variantId, wholesale]);
        }
        result.received++;
        result.lines.push({ name, status: 'ok', qty, delta, converted: asUnits ? `${qty} уп × ${unitMl} мл` : null, variant_id: variantId });
      } else { // pricelist — тільки номенклатура
        if (it.variant_id) { result.skipped++; result.lines.push({ name, status: 'skip', why: 'вже є' }); continue; }
        const variantId = await createItem(client, name, it.price);
        if (!variantId) { result.skipped++; result.lines.push({ name, status: 'skip', why: 'створення' }); continue; }
        result.created++;
        result.lines.push({ name, status: 'created', variant_id: variantId });
      }
    }
    const doc = await client.query(
      `INSERT INTO stock_import_docs (kind, filename, items, totals, created_by, doc_date)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [kind, filename || null, JSON.stringify(result.lines),
       JSON.stringify({ received: result.received, created: result.created, skipped: result.skipped }),
       (req.user && (req.user.name || req.user.login)) || 'admin', docDate]);
    docId = doc.rows[0].id;
    await client.query('COMMIT');
    res.json({ ok: true, doc_id: docId, ...result });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[stock-import/apply]', e.message);
    res.status(500).json({ error: 'apply-failed', message: e.message });
  } finally { client.release(); }
});

// створення товару+варіанта з рядка прайсу/накладної
async function createItem(client, name, price) {
  const brand = imp.detectBrand(name);
  const category = imp.detectCategory(name);
  let base = imp.slugify(name), id = base;
  for (let i = 2; i < 30; i++) {
    const dup = await client.query(`SELECT 1 FROM products WHERE id = $1`, [id]);
    if (!dup.rows[0]) break;
    id = `${base}-${i}`;
  }
  // бренд обовʼязковий у products → «Інше» для нерозпізнаних
  if (!brand) {
    await client.query(`INSERT INTO brands (id, name) VALUES ('inshe','Інше') ON CONFLICT (id) DO NOTHING`);
  }
  await client.query(
    `INSERT INTO products (id, name, brand_id, category_id, active, min_stock) VALUES ($1,$2,$3,$4,true,2)`,
    [id, name, brand || 'inshe', category]);
  const pr = price && Number(price) > 0 ? Number(price) : 0; // price NOT NULL: без ціни = 0, поправлять у картці
  const v = await client.query(
    `INSERT INTO product_variants (product_id, volume, price, wholesale, sku, stock_qty, active)
     VALUES ($1,'стандарт',$2,$3,$4,0,true) RETURNING id`,
    [id, pr, pr || null, `${id}::стандарт`]);
  return v.rows[0]?.id || null;
}

router.get('/docs', requirePerm(), async (req, res) => {
  try {
    const r = await getPool().query(
      `SELECT id, kind, filename, totals, created_by, created_at, doc_date
         FROM stock_import_docs ORDER BY id DESC LIMIT 20`);
    res.json({ ok: true, items: r.rows });
  } catch (e) { res.status(500).json({ error: 'internal' }); }
});

module.exports = router;
