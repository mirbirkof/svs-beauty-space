/* ═══════════════════════════════════════════════════════
   Импорт клиентов из CSV (зеркало export.js).

   POST /api/import/clients   body { csv: "<текст CSV>" }
   - Заголовок (первая строка) маппится по синонимам колонок (укр/рус/eng).
   - Телефон нормализуется к канону БД (380XXXXXXXXX) через lib/phone.
   - Дедуп: ON CONFLICT (tenant_id, phone) DO UPDATE — существующий клиент
     обновляется (имя/почта/заметки заполняются только если были пустыми).
   - tenant_id проставляется автоматически (DEFAULT current_tenant_id()).
   Возвращает построчный отчёт: imported / updated / skipped / errors.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const { normalizePhoneDb } = require('../lib/phone');

router.use(requirePerm('clients.write'));

// ── Мини-парсер CSV: учитывает кавычки, экранированные "", переводы строк внутри кавычек, BOM ──
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text || '').replace(/^\ufeff/, ''); // срезаем BOM
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* пропускаем */ }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

// Синонимы заголовков → каноничные поля
const HEADER_MAP = {
  phone: ['phone', 'телефон', 'тел', 'mobile', 'номер'],
  name: ['name', 'имя', "ім'я", 'имя клиента', 'клиент', 'клієнт', 'фио', 'фіо', 'full name'],
  email: ['email', 'почта', 'пошта', 'e-mail', 'mail'],
  birthday: ['birthday', 'birth', 'дата рождения', 'др', 'день народження', 'дн'],
  source: ['source', 'источник', 'джерело'],
  notes: ['notes', 'note', 'заметки', 'нотатки', 'коментар', 'комментарий', 'примечание'],
  tags: ['tags', 'теги', 'метки', 'мітки'],
};

function mapHeader(h) {
  const norm = String(h || '').trim().toLowerCase();
  for (const [field, syn] of Object.entries(HEADER_MAP)) {
    if (syn.includes(norm)) return field;
  }
  return null;
}

function toDateOrNull(v) {
  if (!v) return null;
  const s = String(v).trim();
  // dd.mm.yyyy / dd/mm/yyyy → yyyy-mm-dd
  const m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null; // нераспознанная дата — не ломаем импорт, просто пропускаем поле
}

router.post('/clients', async (req, res) => {
  const csv = req.body && (req.body.csv != null ? req.body.csv : req.body.text);
  if (!csv || typeof csv !== 'string') {
    return res.status(400).json({ error: 'no-csv', hint: 'Передайте { csv: "<текст>" }. Лимит тела 1MB (~5000 строк).' });
  }
  const rows = parseCsv(csv);
  if (rows.length < 2) return res.status(400).json({ error: 'empty', hint: 'Нужны заголовок и хотя бы одна строка данных.' });

  const headerRow = rows[0];
  const colMap = headerRow.map(mapHeader); // индекс колонки → поле
  if (!colMap.includes('phone') && !colMap.includes('name')) {
    return res.status(400).json({ error: 'no-key-column', hint: 'В заголовке нужна колонка «Телефон» или «Имя».' });
  }

  const pool = getPool();
  const report = { total: rows.length - 1, imported: 0, updated: 0, skipped: 0, errors: [] };

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const rec = {};
    colMap.forEach((field, idx) => { if (field) rec[field] = (cells[idx] != null ? String(cells[idx]).trim() : ''); });

    const phone = normalizePhoneDb(rec.phone);
    const name = (rec.name || '').trim();
    if (!phone && !name) { report.skipped++; continue; }
    if (!phone) {
      // Без телефона апсертить по уникальному ключу нельзя — заносим как нового без дедупа
      try {
        await pool.query(
          `INSERT INTO clients (phone, name, email, birthday, source, notes) VALUES (NULL,$1,$2,$3,$4,$5)`,
          [name, rec.email || null, toDateOrNull(rec.birthday), rec.source || 'import', rec.notes || null]);
        report.imported++;
      } catch (e) { report.errors.push({ line: r + 1, error: e.code || e.message }); }
      continue;
    }

    try {
      const q = await pool.query(
        `INSERT INTO clients (phone, name, email, birthday, source, notes)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, phone) DO UPDATE SET
           name      = COALESCE(NULLIF(clients.name,''), EXCLUDED.name),
           email     = COALESCE(clients.email, EXCLUDED.email),
           birthday  = COALESCE(clients.birthday, EXCLUDED.birthday),
           notes     = COALESCE(NULLIF(clients.notes,''), EXCLUDED.notes),
           updated_at = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [phone, name || null, rec.email || null, toDateOrNull(rec.birthday), rec.source || 'import', rec.notes || null]);
      if (q.rows[0] && q.rows[0].inserted) report.imported++; else report.updated++;
    } catch (e) {
      report.errors.push({ line: r + 1, phone, error: e.code || e.message });
    }
  }

  logAction({ user: req.user, action: 'clients.import', entity: 'clients', entity_id: null, ip: req.ip,
    meta: { total: report.total, imported: report.imported, updated: report.updated, skipped: report.skipped, errors: report.errors.length } }).catch(() => {});

  res.json({ ok: true, ...report, errors: report.errors.slice(0, 50) });
});

module.exports = router;
