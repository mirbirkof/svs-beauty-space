/* ═══════════════════════════════════════════════════════════════
   #107 — бэкфилл телефонов клиентов к канону БД '380XXXXXXXXX'.

   Нормализуем ТОЛЬКО однозначные случаи (по цифрам после чистки):
     0XXXXXXXXX  (10) → 38 + номер
     80XXXXXXXXX (11) → 3 + номер
     +380XXXXXXXXX    → без '+' (канон)
     380 XX ... с пробелами/скобками/дефисами → чистые 12 цифр
   Всё остальное (другая длина, иностранные) НЕ трогаем — только считаем.

   Безопасность:
   - СНАЧАЛА пишем бэкап (id, старый phone) в backend/_phones_backup_<дата>.json
   - конфликт UNIQUE (tenant_id, phone) → строку пропускаем и репортим,
     клиентов НЕ склеиваем
   - каждый UPDATE точечный, по id

   Запуск:  cd backend && node -r dotenv/config scripts/normalize-phones.js
   Dry-run: DRY_RUN=1 node -r dotenv/config scripts/normalize-phones.js
   ═══════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { normalizePhoneDb } = require('../lib/phone');

const DRY = process.env.DRY_RUN === '1';

// однозначный украинский формат? (те же правила, что в lib/phone.js,
// но БЕЗ агрессивного случая «9 цифр» — для бэкфилла он неоднозначен)
function canonIfUnambiguous(raw) {
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('380')) return d;
  if (d.length === 11 && d.startsWith('80')) return '3' + d;
  if (d.length === 10 && d.startsWith('0')) return '38' + d;
  return null; // неоднозначно — не трогаем
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    const rows = (await db.query(
      `SELECT id, tenant_id, phone FROM clients
        WHERE phone IS NOT NULL AND phone <> '' AND phone !~ '^380\\d{9}$'
        ORDER BY id`
    )).rows;

    const candidates = [];
    const nonstandard = [];
    for (const r of rows) {
      const canon = canonIfUnambiguous(r.phone);
      if (canon && canon !== r.phone) candidates.push({ ...r, canon });
      else if (!canon) nonstandard.push({ id: r.id, phone: r.phone });
    }

    console.log(`Всего не в каноне: ${rows.length}; однозначных к правке: ${candidates.length}; нестандартных (не трогаем): ${nonstandard.length}`);
    if (nonstandard.length) console.log('Нестандартные:', JSON.stringify(nonstandard));

    if (!candidates.length) { console.log('Править нечего.'); return; }

    // ── бэкап ДО апдейтов ──
    const stamp = new Date().toISOString().slice(0, 10);
    const backupPath = path.join(__dirname, '..', `_phones_backup_${stamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(candidates.map(c => ({ id: c.id, phone: c.phone })), null, 2));
    console.log(`Бэкап: ${backupPath} (${candidates.length} строк)`);

    let updated = 0; const conflicts = [];
    for (const c of candidates) {
      // конфликт UNIQUE (tenant_id, phone)? — пропускаем, НЕ склеиваем клиентов
      const dup = await db.query(
        `SELECT id FROM clients WHERE tenant_id = $1 AND phone = $2 AND id <> $3 LIMIT 1`,
        [c.tenant_id, c.canon, c.id]
      );
      if (dup.rows.length) {
        conflicts.push({ id: c.id, phone: c.phone, canon: c.canon, conflicts_with: dup.rows[0].id });
        continue;
      }
      if (!DRY) {
        await db.query(`UPDATE clients SET phone = $1, updated_at = NOW() WHERE id = $2`, [c.canon, c.id]);
      }
      updated++;
    }

    console.log(`${DRY ? '[DRY-RUN] было бы нормализовано' : 'Нормализовано'}: ${updated}`);
    console.log(`Пропущено из-за конфликта UNIQUE: ${conflicts.length}`);
    if (conflicts.length) console.log('Конфликты:', JSON.stringify(conflicts, null, 1));
  } finally {
    await db.end();
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
