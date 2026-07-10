/* ═══════════════════════════════════════════════════════
   SVS Beauty World — Export (M25)
   GET /api/export/orders.csv        (admin) — заказы
   GET /api/export/clients.csv       (admin) — клиенты
   GET /api/export/products.csv      (admin) — товары + остатки
   GET /api/export/appointments.csv  (admin) — визиты/записи
   GDPR (право на переносимость данных, ст.16 ЗУ "Про захист персональних даних"):
   GET /api/export/gdpr/client/:id        — полный JSON-дамп всех данных клиента
   GET /api/export/gdpr/client/:id.csv    — сводка клиента в CSV

   M25+ расширенный экспорт (additive, ?format=csv|json):
   GET /api/export/appointments      — записи/визиты      (clients.read)
   GET /api/export/orders            — продажи/заказы     (reports.read)
   GET /api/export/order-items       — позиции заказов    (reports.read)
   GET /api/export/cash-operations   — движение денег     (reports.finance)
   GET /api/export/inventory         — склад/остатки      (stock.read)
   GET /api/export/stock-movements   — движение товара    (stock.read)
   GET /api/export/consumption       — расход материалов  (stock.read)
   GET /api/export/payroll           — зарплаты мастеров  (reports.finance)
   Все фильтруются по тенанту (pool.query → app.tenant_id RLS) и
   требуют export.read (глобально) + гранулярное право (выше). ?from=&to=.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

router.use(requirePerm('export.read'));

// Аудит (QA): 14 async-хендлерів без try/catch — Express 4 не ловить reject
// async-функції, запит висів вічно (напр. ?from=abc → помилка PG → тиша).
// Санація КОРЕНЕМ: обгортаємо router.get так, що будь-який async-хендлер
// автоматично отримує .catch → next(err) → штатний error-middleware (500 JSON).
const _get = router.get.bind(router);
router.get = (path, ...handlers) => _get(path, ...handlers.map(h =>
  typeof h === 'function'
    ? (req, res, next) => { Promise.resolve(h(req, res, next)).catch(next); }
    : h));

function toCsv(rows, columns) {
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[,"\n]/.test(s) ? `"${s}"` : s;
  };
  const header = columns.map(c => c.label).join(',');
  const body = rows.map(r => columns.map(c => escape(r[c.key])).join(',')).join('\n');
  return '\ufeff' + header + '\n' + body;
}

router.get('/orders.csv', async (req, res) => {
  const pool = getPool();
  const r = await pool.query(`
    SELECT o.id, o.created_at, c.phone, c.name AS client_name,
           o.total, o.status, o.payment_method, o.delivery_type, o.notes
    FROM orders o LEFT JOIN clients c ON c.id = o.client_id
    ORDER BY o.id DESC LIMIT 5000`);
  const csv = toCsv(r.rows, [
    { key: 'id', label: 'ID' },
    { key: 'created_at', label: 'Дата' },
    { key: 'phone', label: 'Телефон' },
    { key: 'client_name', label: 'Клієнт' },
    { key: 'total', label: 'Сума' },
    { key: 'status', label: 'Статус' },
    { key: 'payment_method', label: 'Оплата' },
    { key: 'delivery_type', label: 'Доставка' },
    { key: 'notes', label: 'Примітки' },
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${Date.now()}.csv"`);
  res.send(csv);
});

router.get('/clients.csv', async (req, res) => {
  const pool = getPool();
  const r = await pool.query(`
    SELECT c.id, c.phone, c.name, c.email,
           to_char(c.birthday, 'DD.MM.YYYY') AS birthday, c.source, c.notes,
           c.loyalty_points, c.total_spent, c.created_at,
           (SELECT COUNT(*) FROM orders WHERE client_id = c.id) AS orders_count
    FROM clients c WHERE c.deleted_at IS NULL ORDER BY c.id DESC LIMIT 10000`);
  // Заголовки збігаються із синонімами імпорту (routes/import.js) —
  // цей файл можна без втрат завантажити в інший салон.
  const csv = toCsv(r.rows, [
    { key: 'id', label: 'ID' },
    { key: 'phone', label: 'Телефон' },
    { key: 'name', label: "Ім'я" },
    { key: 'email', label: 'Email' },
    { key: 'birthday', label: 'День народження' },
    { key: 'source', label: 'Джерело' },
    { key: 'notes', label: 'Нотатки' },
    { key: 'orders_count', label: 'Замовлень' },
    { key: 'total_spent', label: 'Витрачено' },
    { key: 'loyalty_points', label: 'Бонуси' },
    { key: 'created_at', label: 'Реєстрація' },
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="clients-${Date.now()}.csv"`);
  res.send(csv);
});

router.get('/products.csv', async (req, res) => {
  const pool = getPool();
  const r = await pool.query(`
    SELECT p.id, p.name, p.brand_id, p.category_id,
           pv.volume, pv.price, pv.wholesale, pv.stock_qty, pv.sku
    FROM products p
    LEFT JOIN product_variants pv ON pv.product_id = p.id
    WHERE p.active = TRUE
    ORDER BY p.name, pv.price`);
  const csv = toCsv(r.rows, [
    { key: 'id', label: 'ID товару' },
    { key: 'name', label: 'Назва' },
    { key: 'brand_id', label: 'Бренд' },
    { key: 'category_id', label: 'Категорія' },
    { key: 'volume', label: 'Обʼєм' },
    { key: 'price', label: 'Ціна' },
    { key: 'wholesale', label: 'Опт' },
    { key: 'stock_qty', label: 'Залишок' },
    { key: 'sku', label: 'SKU' },
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="products-${Date.now()}.csv"`);
  res.send(csv);
});

router.get('/appointments.csv', async (req, res) => {
  const pool = getPool();
  const { from, to } = req.query;
  const cond = [];
  const args = [];
  if (from) { args.push(from); cond.push(`a.starts_at >= $${args.length}`); }
  if (to)   { args.push(to);   cond.push(`a.starts_at <= $${args.length}`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const r = await pool.query(`
    SELECT a.id, a.starts_at, a.status,
           COALESCE(c.name, a.client_name) AS client_name,
           COALESCE(c.phone, '')          AS phone,
           COALESCE(m.name, '')           AS master_name,
           COALESCE(s.name, a.services_text) AS service_name,
           a.price, a.payment_method, a.source,
           CASE WHEN a.beautypro_id IS NOT NULL THEN 'BeautyPro' ELSE 'Власна' END AS origin
    FROM appointments a
    LEFT JOIN clients  c ON c.id = a.client_id
    LEFT JOIN masters  m ON m.id = a.master_id
    LEFT JOIN services s ON s.id = a.service_id
    ${where}
    ORDER BY a.starts_at DESC LIMIT 20000`, args);
  const csv = toCsv(r.rows, [
    { key: 'id', label: 'ID' },
    { key: 'starts_at', label: 'Дата/час' },
    { key: 'client_name', label: 'Клієнт' },
    { key: 'phone', label: 'Телефон' },
    { key: 'master_name', label: 'Майстер' },
    { key: 'service_name', label: 'Послуга' },
    { key: 'price', label: 'Ціна' },
    { key: 'payment_method', label: 'Оплата' },
    { key: 'status', label: 'Статус' },
    { key: 'source', label: 'Джерело' },
    { key: 'origin', label: 'Походження' },
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="appointments-${Date.now()}.csv"`);
  res.send(csv);
});

// ── GDPR: полный дамп всех данных одного клиента ──────────
async function collectClientData(pool, id) {
  const client = (await pool.query('SELECT * FROM clients WHERE id=$1', [id])).rows[0];
  if (!client) return null;
  const [appointments, orders, loyalty, cash] = await Promise.all([
    pool.query(`SELECT a.id, a.starts_at, a.status, a.price, a.payment_method,
                       COALESCE(m.name,'') AS master, COALESCE(s.name,a.services_text) AS service
                FROM appointments a
                LEFT JOIN masters m ON m.id=a.master_id
                LEFT JOIN services s ON s.id=a.service_id
                WHERE a.client_id=$1 ORDER BY a.starts_at DESC`, [id]),
    pool.query('SELECT id, created_at, total, status, payment_method, delivery_type FROM orders WHERE client_id=$1 ORDER BY id DESC', [id]),
    pool.query('SELECT id, delta, reason, ref_type, created_at FROM loyalty_ledger WHERE client_id=$1 ORDER BY id DESC', [id]),
    pool.query('SELECT id, type, amount, method, description, created_at FROM cash_operations WHERE ref_type=\'client\' AND ref_id=$1 ORDER BY id DESC', [id]),
  ]);
  return {
    client,
    appointments: appointments.rows,
    orders: orders.rows,
    loyalty_ledger: loyalty.rows,
    cash_operations: cash.rows,
  };
}

router.get('/gdpr/client/:id(\\d+).csv', async (req, res) => {
  const pool = getPool();
  const data = await collectClientData(pool, req.params.id);
  if (!data) return res.status(404).json({ error: 'client_not_found' });
  await logAction({ user: req.user, action: 'export.gdpr_csv', entity: 'client', entity_id: req.params.id, ip: req.ip });
  const c = data.client;
  const lines = [];
  lines.push('РОЗДІЛ,Поле,Значення');
  const esc = (v) => { const s = v==null?'':String(v).replace(/"/g,'""'); return /[,"\n]/.test(s)?`"${s}"`:s; };
  for (const [k, v] of Object.entries(c)) lines.push(`Профіль,${esc(k)},${esc(v)}`);
  lines.push('');
  lines.push('ВІЗИТИ');
  lines.push('Дата,Майстер,Послуга,Ціна,Статус');
  data.appointments.forEach(a => lines.push([a.starts_at, a.master, a.service, a.price, a.status].map(esc).join(',')));
  lines.push('');
  lines.push('ЗАМОВЛЕННЯ');
  lines.push('Дата,Сума,Статус,Оплата');
  data.orders.forEach(o => lines.push([o.created_at, o.total, o.status, o.payment_method].map(esc).join(',')));
  lines.push('');
  lines.push('БОНУСИ');
  lines.push('Дата,Зміна,Причина');
  data.loyalty_ledger.forEach(l => lines.push([l.created_at, l.delta, l.reason].map(esc).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gdpr-client-${req.params.id}.csv"`);
  res.send('\ufeff' + lines.join('\n'));
});

router.get('/gdpr/client/:id(\\d+)', async (req, res) => {
  const pool = getPool();
  const data = await collectClientData(pool, req.params.id);
  if (!data) return res.status(404).json({ error: 'client_not_found' });
  await logAction({ user: req.user, action: 'export.gdpr_json', entity: 'client', entity_id: req.params.id, ip: req.ip });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gdpr-client-${req.params.id}.json"`);
  res.send(JSON.stringify({ exported_at: new Date().toISOString(), ...data }, null, 2));
});

/* ═══════════════════════════════════════════════════════
   M25+ — расширенный экспорт (additive).
   Универсальные эндпоинты с выбором формата ?format=csv|json.
   Изоляция тенанта: все запросы идут через pool.query, который
   db-pg.js оборачивает в транзакцию с app.tenant_id (RLS),
   пока запрос внутри HTTP-контекста тенанта (lib/tenant).
   Права: глобально router.use(requirePerm('export.read')) +
   гранулярный requirePerm на чтение конкретной сущности.
   ═══════════════════════════════════════════════════════ */

// Excel без внешних библиотек: SpreadsheetML (XML Spreadsheet 2003) — родной формат
// Excel/LibreOffice, кириллица и числа работают из коробки.
function toXls(rows, columns, sheetName) {
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cell = (v) => {
    const isNum = typeof v === 'number' || (v != null && v !== '' && !isNaN(v) && !/^0\d/.test(String(v)));
    return `<Cell><Data ss:Type="${isNum ? 'Number' : 'String'}">${esc(v)}</Data></Cell>`;
  };
  const head = `<Row>${columns.map(c => `<Cell ss:StyleID="h"><Data ss:Type="String">${esc(c.label)}</Data></Cell>`).join('')}</Row>`;
  const body = rows.map(r => `<Row>${columns.map(c => cell(r[c.key])).join('')}</Row>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="h"><Font ss:Bold="1"/></Style></Styles>
<Worksheet ss:Name="${esc((sheetName || 'Export').slice(0, 30))}"><Table>
${head}
${body}
</Table></Worksheet></Workbook>`;
}

// PDF без внешних библиотек: печатная HTML-страница — открывается, кнопка
// «Зберегти як PDF» одним кликом (или ?autoprint=1). Без 5МБ зависимостей.
function toPrintHtml(rows, columns, title) {
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
 body{font:12px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#111;margin:24px}
 h1{font-size:16px;margin:0 0 4px} .meta{color:#666;font-size:11px;margin-bottom:12px}
 table{border-collapse:collapse;width:100%} th,td{border:1px solid #ccc;padding:4px 6px;text-align:left}
 th{background:#f3f3f3} tr:nth-child(even) td{background:#fafafa}
 .noprint{margin-bottom:12px} @media print{.noprint{display:none}}
</style></head><body>
<div class="noprint"><button onclick="window.print()" style="padding:6px 14px">🖨 Друк / Зберегти як PDF</button></div>
<h1>${esc(title)}</h1><div class="meta">Сформовано ${new Date().toLocaleString('uk-UA')} · рядків: ${rows.length}</div>
<table><thead><tr>${columns.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
<tbody>${rows.map(r => `<tr>${columns.map(c => `<td>${esc(r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table>
<script>if(location.search.includes('autoprint=1'))window.print()</script>
</body></html>`;
}

// Отдать набор строк в выбранном формате. format: 'json' → JSON-массив,
// 'xls'/'excel' → Excel, 'pdf'/'print' → печатная страница (Зберегти як PDF),
// иначе CSV (с BOM, запятая-разделитель, экранирование кавычек как в toCsv).
function sendExport(res, { rows, columns, filename, format, meta }) {
  const fmt = String(format || '').toLowerCase();
  if (fmt === 'xls' || fmt === 'excel' || fmt === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}-${Date.now()}.xls"`);
    return res.send(toXls(rows, columns, meta?.entity || filename));
  }
  if (fmt === 'pdf' || fmt === 'print') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(toPrintHtml(rows, columns, meta?.entity || filename));
  }
  if (String(format).toLowerCase() === 'json') {
    // В JSON отдаём только колонки экспорта (стабильный контракт), плюс мета.
    const items = rows.map(r => {
      const o = {};
      for (const c of columns) o[c.key] = r[c.key] == null ? null : r[c.key];
      return o;
    });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
    return res.send(JSON.stringify({
      exported_at: new Date().toISOString(),
      entity: meta?.entity || filename,
      count: items.length,
      columns: columns.map(c => ({ key: c.key, label: c.label })),
      items,
    }, null, 2));
  }
  const csv = toCsv(rows, columns);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}-${Date.now()}.csv"`);
  return res.send(csv);
}

// Унифицированный фильтр по диапазону дат для эндпоинтов с ?from=&to=.
function dateRange(req, col, args) {
  const cond = [];
  if (req.query.from) { args.push(req.query.from); cond.push(`${col} >= $${args.length}`); }
  if (req.query.to)   { args.push(req.query.to);   cond.push(`${col} <= $${args.length}`); }
  return cond;
}

// ── ЗАПИСИ / ВІЗИТИ (appointments) — CSV/JSON ────────────
// (дополняет существующий /appointments.csv; этот — с выбором формата)
router.get('/appointments', requirePerm('clients.read'), async (req, res) => {
  const pool = getPool();
  const args = [];
  const cond = dateRange(req, 'a.starts_at', args);
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const r = await pool.query(`
    SELECT a.id, a.starts_at, a.status,
           COALESCE(c.name, a.client_name) AS client_name,
           COALESCE(c.phone, '')          AS phone,
           COALESCE(m.name, '')           AS master_name,
           COALESCE(s.name, a.services_text) AS service_name,
           a.price, a.payment_method, a.source,
           CASE WHEN a.beautypro_id IS NOT NULL THEN 'BeautyPro' ELSE 'Власна' END AS origin
    FROM appointments a
    LEFT JOIN clients  c ON c.id = a.client_id
    LEFT JOIN masters  m ON m.id = a.master_id
    LEFT JOIN services s ON s.id = a.service_id
    ${where}
    ORDER BY a.starts_at DESC LIMIT 20000`, args);
  sendExport(res, {
    rows: r.rows, format: req.query.format, filename: 'appointments',
    meta: { entity: 'appointments' },
    columns: [
      { key: 'id', label: 'ID' },
      { key: 'starts_at', label: 'Дата/час' },
      { key: 'client_name', label: 'Клієнт' },
      { key: 'phone', label: 'Телефон' },
      { key: 'master_name', label: 'Майстер' },
      { key: 'service_name', label: 'Послуга' },
      { key: 'price', label: 'Ціна' },
      { key: 'payment_method', label: 'Оплата' },
      { key: 'status', label: 'Статус' },
      { key: 'source', label: 'Джерело' },
      { key: 'origin', label: 'Походження' },
    ],
  });
});

// ── ПРОДАЖІ / ЗАМОВЛЕННЯ (orders) — CSV/JSON ─────────────
router.get('/orders', requirePerm('reports.read'), async (req, res) => {
  const pool = getPool();
  const args = [];
  const cond = dateRange(req, 'o.created_at', args);
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const r = await pool.query(`
    SELECT o.id, o.created_at, c.phone, c.name AS client_name,
           o.total, o.status, o.payment_method, o.delivery_type, o.notes
    FROM orders o LEFT JOIN clients c ON c.id = o.client_id
    ${where}
    ORDER BY o.id DESC LIMIT 20000`, args);
  sendExport(res, {
    rows: r.rows, format: req.query.format, filename: 'orders',
    meta: { entity: 'orders' },
    columns: [
      { key: 'id', label: 'ID' },
      { key: 'created_at', label: 'Дата' },
      { key: 'phone', label: 'Телефон' },
      { key: 'client_name', label: 'Клієнт' },
      { key: 'total', label: 'Сума' },
      { key: 'status', label: 'Статус' },
      { key: 'payment_method', label: 'Оплата' },
      { key: 'delivery_type', label: 'Доставка' },
      { key: 'notes', label: 'Примітки' },
    ],
  });
});

// ── ПОЗИЦІЇ ЗАМОВЛЕНЬ (order_items) — детализация продаж ──
router.get('/order-items', requirePerm('reports.read'), async (req, res) => {
  const pool = getPool();
  const args = [];
  const cond = dateRange(req, 'o.created_at', args);
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const r = await pool.query(`
    SELECT oi.id, oi.order_id, o.created_at, o.status AS order_status,
           oi.variant_id, oi.product_name, oi.volume, oi.qty,
           oi.unit_price, oi.line_total
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    ${where}
    ORDER BY oi.order_id DESC, oi.id LIMIT 50000`, args);
  sendExport(res, {
    rows: r.rows, format: req.query.format, filename: 'order-items',
    meta: { entity: 'order_items' },
    columns: [
      { key: 'id', label: 'ID' },
      { key: 'order_id', label: 'Замовлення' },
      { key: 'created_at', label: 'Дата' },
      { key: 'order_status', label: 'Статус замовл.' },
      { key: 'product_name', label: 'Товар' },
      { key: 'volume', label: 'Обʼєм' },
      { key: 'qty', label: 'Кількість' },
      { key: 'unit_price', label: 'Ціна' },
      { key: 'line_total', label: 'Сума позиції' },
    ],
  });
});

// ── РУХ ГРОШЕЙ (cash_operations) — CSV/JSON ──────────────
router.get('/cash-operations', requirePerm('reports.finance'), async (req, res) => {
  const pool = getPool();
  const args = [];
  const cond = dateRange(req, 'co.created_at', args);
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const r = await pool.query(`
    SELECT co.id, co.created_at,
           CASE WHEN co.type='in' THEN 'Надходження' ELSE 'Витрата' END AS direction,
           co.category, co.amount, co.method, co.description,
           co.ref_type, co.ref_id,
           COALESCE(m.name, '') AS master_name
    FROM cash_operations co
    LEFT JOIN masters m ON m.id = co.master_id
    ${where}
    ORDER BY co.created_at DESC LIMIT 50000`, args);
  sendExport(res, {
    rows: r.rows, format: req.query.format, filename: 'cash-operations',
    meta: { entity: 'cash_operations' },
    columns: [
      { key: 'id', label: 'ID' },
      { key: 'created_at', label: 'Дата' },
      { key: 'direction', label: 'Тип' },
      { key: 'category', label: 'Категорія' },
      { key: 'amount', label: 'Сума' },
      { key: 'method', label: 'Спосіб' },
      { key: 'description', label: 'Опис' },
      { key: 'ref_type', label: 'Звʼязок' },
      { key: 'ref_id', label: 'ID звʼязку' },
      { key: 'master_name', label: 'Майстер' },
    ],
  });
});

// ── СКЛАД: ЗАЛИШКИ (products + stock) — CSV/JSON ──────────
router.get('/inventory', requirePerm('stock.read'), async (req, res) => {
  const pool = getPool();
  const r = await pool.query(`
    SELECT p.id, p.name, p.brand_id, p.category_id,
           pv.id AS variant_id, pv.volume, pv.sku,
           pv.price, pv.wholesale, pv.stock_qty, pv.reserved_qty,
           (COALESCE(pv.stock_qty,0) - COALESCE(pv.reserved_qty,0)) AS available_qty
    FROM products p
    LEFT JOIN product_variants pv ON pv.product_id = p.id
    WHERE p.active = TRUE
    ORDER BY p.name, pv.price`);
  sendExport(res, {
    rows: r.rows, format: req.query.format, filename: 'inventory',
    meta: { entity: 'inventory' },
    columns: [
      { key: 'id', label: 'ID товару' },
      { key: 'name', label: 'Назва' },
      { key: 'brand_id', label: 'Бренд' },
      { key: 'category_id', label: 'Категорія' },
      { key: 'variant_id', label: 'ID варіанту' },
      { key: 'volume', label: 'Обʼєм' },
      { key: 'sku', label: 'SKU' },
      { key: 'price', label: 'Ціна' },
      { key: 'wholesale', label: 'Опт' },
      { key: 'stock_qty', label: 'Залишок' },
      { key: 'reserved_qty', label: 'Резерв' },
      { key: 'available_qty', label: 'Доступно' },
    ],
  });
});

// ── СКЛАД: РУХ ТОВАРУ (stock_movements) — CSV/JSON ───────
router.get('/stock-movements', requirePerm('stock.read'), async (req, res) => {
  const pool = getPool();
  const args = [];
  const cond = dateRange(req, 'sm.created_at', args);
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const r = await pool.query(`
    SELECT sm.id, sm.created_at, sm.product_id, p.name AS product_name,
           sm.delta, sm.reason, sm.notes
    FROM stock_movements sm
    LEFT JOIN products p ON p.id = sm.product_id
    ${where}
    ORDER BY sm.created_at DESC LIMIT 50000`, args);
  sendExport(res, {
    rows: r.rows, format: req.query.format, filename: 'stock-movements',
    meta: { entity: 'stock_movements' },
    columns: [
      { key: 'id', label: 'ID' },
      { key: 'created_at', label: 'Дата' },
      { key: 'product_id', label: 'ID товару' },
      { key: 'product_name', label: 'Товар' },
      { key: 'delta', label: 'Зміна' },
      { key: 'reason', label: 'Причина' },
      { key: 'notes', label: 'Примітки' },
    ],
  });
});

// ── СКЛАД: ВИТРАТНІ МАТЕРІАЛИ (material_consumption) ──────
router.get('/consumption', requirePerm('stock.read'), async (req, res) => {
  const pool = getPool();
  const args = [];
  const cond = dateRange(req, 'mc.consumed_at', args);
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const r = await pool.query(`
    SELECT mc.id, mc.consumed_at, mc.appointment_id, mc.master_id,
           COALESCE(m.name, '') AS master_name,
           mc.product_id, mc.product_name, mc.qty, mc.unit_cost, mc.total_cost
    FROM material_consumption mc
    LEFT JOIN masters m ON m.id = mc.master_id
    ${where}
    ORDER BY mc.consumed_at DESC LIMIT 50000`, args);
  sendExport(res, {
    rows: r.rows, format: req.query.format, filename: 'consumption',
    meta: { entity: 'material_consumption' },
    columns: [
      { key: 'id', label: 'ID' },
      { key: 'consumed_at', label: 'Дата' },
      { key: 'appointment_id', label: 'Запис' },
      { key: 'master_name', label: 'Майстер' },
      { key: 'product_name', label: 'Матеріал' },
      { key: 'qty', label: 'Кількість' },
      { key: 'unit_cost', label: 'Ціна од.' },
      { key: 'total_cost', label: 'Сума' },
    ],
  });
});

// ── ЗАРПЛАТИ (payroll_records) — CSV/JSON ────────────────
router.get('/payroll', requirePerm('reports.finance'), async (req, res) => {
  try {
  const pool = getPool();
  const args = [];
  const cond = dateRange(req, 'pr.period_start', args);
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  // master_id в payroll_records — TEXT (числа строками «20»), masters.id — INTEGER.
  // Приводим id к тексту, иначе JOIN падает «operator does not exist: integer = text»
  // и без try/catch запрос висит вечно (unhandledRejection не доходит до ответа). Фикс 02.07.
  const r = await pool.query(`
    SELECT pr.id, pr.master_id,
           COALESCE(pr.master_name, m.name, '') AS master_name,
           pr.period_start, pr.period_end,
           pr.services_count, pr.services_revenue,
           pr.bonus, pr.deduction, pr.total, pr.status
    FROM payroll_records pr
    LEFT JOIN masters m ON m.id::text = pr.master_id
    ${where}
    ORDER BY pr.period_start DESC, pr.master_id LIMIT 20000`, args);
  sendExport(res, {
    rows: r.rows, format: req.query.format, filename: 'payroll',
    meta: { entity: 'payroll_records' },
    columns: [
      { key: 'id', label: 'ID' },
      { key: 'master_name', label: 'Майстер' },
      { key: 'period_start', label: 'Період з' },
      { key: 'period_end', label: 'Період по' },
      { key: 'services_count', label: 'Послуг' },
      { key: 'services_revenue', label: 'Виручка' },
      { key: 'bonus', label: 'Бонус' },
      { key: 'deduction', label: 'Утримання' },
      { key: 'total', label: 'До виплати' },
      { key: 'status', label: 'Статус' },
    ],
  });
  } catch (e) {
    console.error('[export:payroll]', e.message);
    res.status(500).json({ error: 'Не вдалося сформувати експорт зарплат' });
  }
});

module.exports = router;
