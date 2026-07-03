/* ═══════════════════════════════════════════════════════════════
   Імпорт складу: накладні (прихід) і прайси (номенклатура).

   parseUpload(filename, buffer|text) → [{name, qty, price}]
     - .xlsx/.xls — через SheetJS
     - .csv/.txt/вставлений текст — авторозпізнавання роздільника
     - евристика колонок: назва = найдовша текстова, кількість = «мале» число,
       ціна = число з копійками / найбільше. Все можна поправити в предпросмотрі.

   matchRows(pool, rows) → кожному рядку топ-3 кандидати зі складу
     (точний SKU/штрихкод → повний збіг токенів назва+варіант → частковий).
   ═══════════════════════════════════════════════════════════════ */
const XLSX = require('xlsx');

// ── нормалізація тексту для матчингу ──
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/['’ʼ`"«»]/g, '')
    .replace(/[^а-яёіїєґa-z0-9.,% ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function tokens(s) {
  return norm(s).split(' ').filter(t => t.length >= 2 && !/^(та|і|для|з|із|на|the|and)$/.test(t));
}

// ── парсинг числа («1 234,50» → 1234.5) ──
function num(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

const HEADER_RE = /назв|наимен|товар|продукц|артикул|sku|кільк|кол-?в|qty|шт|ціна|цена|price|сума|сумм|№|n\b/i;

// рядок клітинок → {name, qty, price} | null
function rowToItem(cells) {
  const texts = [], nums = [];
  cells.forEach((c, i) => {
    const n = num(c);
    if (n != null) nums.push({ i, n });
    else if (String(c || '').trim().length > 1) texts.push({ i, s: String(c).trim() });
  });
  if (!texts.length) return null;
  // назва = найдовший текст
  const name = texts.sort((a, b) => b.s.length - a.s.length)[0].s;
  if (name.length < 3) return null;
  let qty = null, price = null;
  const candidates = nums.filter(x => x.n > 0);
  if (candidates.length === 1) qty = candidates[0].n;
  else if (candidates.length >= 2) {
    // кількість — ціле «мале»; ціна — з копійками або найбільша
    const withFrac = candidates.filter(x => x.n % 1 !== 0);
    const ints = candidates.filter(x => x.n % 1 === 0);
    if (withFrac.length && ints.length) { price = withFrac[withFrac.length - 1].n; qty = ints[0].n; }
    else {
      const sorted = [...candidates].sort((a, b) => a.n - b.n);
      qty = sorted[0].n; price = sorted[sorted.length - 1].n;
      if (qty === price) price = null;
    }
  }
  return { name, qty, price };
}

function parseText(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    // роздільник: таб → ; → 2+ пробіли → одиночна кома поза числами
    let cells;
    if (line.includes('\t')) cells = line.split('\t');
    else if (line.includes(';')) cells = line.split(';');
    else if (/\s{2,}/.test(line)) cells = line.split(/\s{2,}/);
    else {
      // «Назва 3 450.00» — числа в кінці рядка
      const m = line.match(/^(.*?)((?:\s+\d+(?:[.,]\d+)?)+)\s*$/);
      cells = m ? [m[1], ...m[2].trim().split(/\s+/)] : [line];
    }
    cells = cells.map(c => c.trim()).filter(c => c !== '');
    if (!cells.length) continue;
    // шапка таблиці — пропускаємо (текст-колонки схожі на заголовки, чисел нема)
    if (cells.every(c => num(c) == null) && HEADER_RE.test(cells.join(' ')) && cells.join(' ').length < 80) continue;
    const item = rowToItem(cells);
    if (item) out.push(item);
  }
  return out;
}

function parseXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const out = [];
  for (const cells of rows) {
    const arr = cells.map(c => String(c ?? '').trim()).filter(c => c !== '');
    if (!arr.length) continue;
    if (arr.every(c => num(c) == null) && HEADER_RE.test(arr.join(' ')) && arr.join(' ').length < 80) continue;
    const item = rowToItem(arr);
    if (item) out.push(item);
  }
  return out;
}

function parseUpload(filename, bufferOrText) {
  const fn = String(filename || '').toLowerCase();
  if (Buffer.isBuffer(bufferOrText) && /\.(xlsx|xls)$/.test(fn)) return parseXlsx(bufferOrText);
  const text = Buffer.isBuffer(bufferOrText) ? bufferOrText.toString('utf8') : String(bufferOrText || '');
  return parseText(text);
}

// ── матчинг рядка до складу ──
// Повертає до 3 кандидатів [{variant_id, label, stock_qty, score}]
async function matchRows(pool, rows) {
  // весь довідник у памʼять (сотні позицій — дешевше одного запиту на рядок)
  const cat = await pool.query(
    `SELECT pv.id AS variant_id, pv.sku, pv.barcode, pv.volume, pv.stock_qty::float AS stock_qty,
            pv.price::float AS price, p.name AS product_name
       FROM product_variants pv JOIN products p ON p.id = pv.product_id
      WHERE pv.active IS NOT FALSE`);
  const index = cat.rows.map(v => ({
    ...v,
    label: `${v.product_name}${v.volume && v.volume !== 'стандарт' ? ' · ' + v.volume : ''}`,
    toks: new Set(tokens(v.product_name + ' ' + (v.volume || ''))),
    normLabel: norm(v.product_name + ' ' + (v.volume || '')),
  }));

  return rows.map(row => {
    const rowNorm = norm(row.name);
    const rowToks = tokens(row.name);
    // 1) точний sku/штрихкод
    const exact = index.find(v => (v.sku && rowNorm.includes(norm(v.sku))) || (v.barcode && rowNorm.includes(norm(v.barcode))));
    let scored;
    if (exact) scored = [{ v: exact, score: 1 }];
    else {
      scored = index.map(v => {
        let hit = 0;
        for (const t of rowToks) {
          if (v.toks.has(t)) { hit++; continue; }
          // частковий збіг токена (фарба/фарбник, тон 8.1 ↔ 8.1)
          for (const vt of v.toks) if (vt.startsWith(t) || t.startsWith(vt)) { hit += 0.7; break; }
        }
        const score = rowToks.length ? hit / rowToks.length : 0;
        return { v, score };
      }).filter(x => x.score >= 0.55)
        .sort((a, b) => b.score - a.score || (a.v.normLabel.length - b.v.normLabel.length))
        .slice(0, 3);
    }
    return {
      name: row.name, qty: row.qty, price: row.price,
      matches: scored.map(x => ({
        variant_id: x.v.variant_id, label: x.v.label,
        stock_qty: x.v.stock_qty, price: x.v.price,
        score: Math.round(x.score * 100) / 100,
      })),
    };
  });
}

// ── slug для нових товарів (як існуючі id: rw-farba-...) ──
const TRANSLIT = { а:'a',б:'b',в:'v',г:'g',ґ:'g',д:'d',е:'e',є:'ye',ж:'zh',з:'z',и:'y',і:'i',ї:'yi',й:'j',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ь:'',ю:'yu',я:'ya',ё:'e',ы:'y',э:'e',ъ:'' };
function slugify(name) {
  const s = String(name).toLowerCase().split('').map(c => TRANSLIT[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42);
  return s || 'tovar';
}

// бренд/категорія з назви
function detectBrand(name) {
  const n = norm(name);
  if (n.includes('raywell')) return 'raywell';
  if (n.includes('invidia')) return 'invidia';
  if (n.includes('envie')) return 'envie';
  if (n.includes('extremo')) return 'extremo';
  return null;
}
const CAT_MAP = [
  [/фарб|краск|барвник|color plex|vitamin color/i, 'coloring'],
  [/окис|oxid|активатор/i, 'oxidant'],
  [/пігмент|pigment/i, 'pigment'],
  [/шампун/i, 'shampoo'], [/маск/i, 'mask'], [/кондиціонер|кондицион/i, 'conditioner'],
  [/сироватк|serum/i, 'serum'], [/олі[яї]|масло|oil/i, 'oil'], [/крем/i, 'cream'],
  [/кератин/i, 'keratin'], [/знебарв|осветл|blond/i, 'bleach'], [/лосьйон|лосьон/i, 'lotion'],
];
function detectCategory(name) {
  for (const [re, id] of CAT_MAP) if (re.test(name)) return id;
  return null;
}

module.exports = { parseUpload, parseText, matchRows, slugify, detectBrand, detectCategory, norm };
