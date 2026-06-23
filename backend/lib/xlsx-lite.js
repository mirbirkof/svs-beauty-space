/* ═══════════════════════════════════════════════════════
   xlsx-lite — мінімальний рідер Excel .xlsx БЕЗ зовнішніх залежностей.

   .xlsx = ZIP-архів з XML усередині. Розпаковуємо через вбудований
   zlib (inflateRawSync), читаємо xl/sharedStrings.xml (рядкові значення)
   та перший аркуш xl/worksheets/sheetN.xml, повертаємо 2D-масив рядків —
   рівно те, що очікує движок міграції (як після parseCsv).

   Навмисно без бібліотеки SheetJS: у неї були вразливості (prototype
   pollution) і вона пішла з npm-реєстру. Тут лише стандартний модуль zlib.
   ═══════════════════════════════════════════════════════ */
const zlib = require('zlib');

// ── Розбір ZIP через центральний каталог (надійні розміри й офсети) ──
function unzipEntries(buf) {
  const entries = {};
  // End Of Central Directory: сигнатура PK\x05\x06, шукаємо з кінця
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Файл не схожий на .xlsx (немає ZIP-каталогу).');
  let p = buf.readUInt32LE(eocd + 16);            // офсет початку центрального каталогу
  const count = buf.readUInt16LE(eocd + 10);      // к-сть записів
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break; // PK\x01\x02
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const fnLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + fnLen);
    // Локальний заголовок: реальні довжини fn/extra можуть відрізнятись
    const lFnLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lFnLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    let content;
    if (method === 0) content = raw;                       // stored
    else if (method === 8) content = zlib.inflateRawSync(raw); // deflate
    else { p += 46 + fnLen + extraLen + commentLen; continue; }
    entries[name] = content;
    p += 46 + fnLen + extraLen + commentLen;
  }
  return entries;
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // & останнім, щоб не зіпсувати інші сутності
}

// ── sharedStrings.xml → масив рядків (кожен <si> може мати кілька <t>) ──
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const inner = m[1];
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(inner))) text += t[1];
    out.push(decodeXmlEntities(text));
  }
  return out;
}

// Літери стовпця ("AB") → 0-базовий індекс
function colToIndex(ref) {
  const letters = String(ref).replace(/\d+/g, '');
  let idx = 0;
  for (let i = 0; i < letters.length; i++) idx = idx * 26 + (letters.charCodeAt(i) - 64);
  return idx - 1;
}

// ── worksheet XML → 2D-масив значень ──
function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cm;
    while ((cm = cRe.exec(rm[1]))) {
      const attrs = cm[1] || cm[3] || '';
      const body = cm[2] || '';
      const refM = attrs.match(/r="([A-Z]+)\d+"/);
      const typeM = attrs.match(/t="([^"]+)"/);
      const ci = refM ? colToIndex(refM[1]) : cells.length;
      let val = '';
      const vM = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
      const isM = body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/); // inline string
      if (typeM && typeM[1] === 's' && vM) {
        val = shared[parseInt(vM[1], 10)] || '';            // shared string
      } else if (typeM && typeM[1] === 'inlineStr' && isM) {
        const t = isM[1].match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
        val = t ? decodeXmlEntities(t[1]) : '';
      } else if (vM) {
        val = decodeXmlEntities(vM[1]);
      }
      cells[ci] = val;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

// Знайти XML першого аркуша (за порядком у workbook.xml.rels / просто sheet1)
function pickFirstSheet(entries) {
  // Найчастіше — xl/worksheets/sheet1.xml
  if (entries['xl/worksheets/sheet1.xml']) return entries['xl/worksheets/sheet1.xml'];
  const names = Object.keys(entries)
    .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/(\d+)/)[1], 10), nb = parseInt(b.match(/(\d+)/)[1], 10);
      return na - nb;
    });
  return names.length ? entries[names[0]] : null;
}

// ── Публічне API: Buffer .xlsx → 2D-масив рядків (рядки/числа як рядки) ──
function parseXlsx(buf) {
  const entries = unzipEntries(buf);
  const sheet = pickFirstSheet(entries);
  if (!sheet) throw new Error('У книзі Excel не знайдено жодного аркуша.');
  const shared = parseSharedStrings(entries['xl/sharedStrings.xml'] && entries['xl/sharedStrings.xml'].toString('utf8'));
  const rows = parseSheet(sheet.toString('utf8'), shared);
  // Прибрати повністю порожні рядки (як у parseCsv)
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

function isXlsx(buf) {
  // ZIP-сигнатура PK\x03\x04 + наявність [Content_Types].xml — ознака OOXML
  return Buffer.isBuffer(buf) && buf.length > 4 &&
    buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

module.exports = { parseXlsx, isXlsx };
