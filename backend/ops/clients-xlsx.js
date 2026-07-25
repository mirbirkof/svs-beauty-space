#!/usr/bin/env node
/**
 * Excel-звіт по клієнтській базі:
 *  Лист 1 — Манікюр без фарбування/догляду (апсейл, останні 3 місяці)
 *  Лист 2 — Не повернулись на фарбування
 *  Лист 3 — Не повернулись на нігті
 *  Лист 4 — Зведення
 * Запуск: node ops/clients-xlsx.js [шлях.xlsx]
 */
require('dotenv').config();
const { Client } = require('pg');
const ExcelJS = require('exceljs');

const RE_COLOR = "(фарбув|фарбуан|мелірув|мілірув|тонув|airtouch|air touch|тотал блонд|вихід з чорного|контурінг|контуринг|балаяж|шатуш|окрашив|колорув)";
const RE_CARE  = "(відновлен|біовирівнюв|бовирівюв|біозавив|полірув|biomimetic|кератин|ботокс|нанопласт|ламінування волосся)";
const RE_NAIL  = "(манікюр|педикюр|нігт|гель лак|гель-лак|френч|укріплення|корекція нарощен)";
const RE_NOT_NAIL = "(вій|вії|брів|брови)";
const RE_CUT   = "(стрижк)";

const BASE = `
WITH txt AS (
  SELECT a.id, a.client_id, a.starts_at, a.status,
         coalesce(a.real_amount, a.price, 0) AS amount,
         lower(coalesce(s.name,'') || ' ' || coalesce(a.services_text,'') || ' ' ||
               coalesce((SELECT string_agg(coalesce(s2.name,''), ' ')
                         FROM appointment_services asv
                         LEFT JOIN services s2 ON s2.id = asv.service_id
                         WHERE asv.appointment_id = a.id), '')) AS blob
  FROM appointments a
  LEFT JOIN services s ON s.id = a.service_id
  WHERE a.client_id IS NOT NULL
),
v AS (
  SELECT *,
    (blob ~ '${RE_COLOR}') AS is_color,
    (blob ~ '${RE_CARE}')  AS is_care,
    (blob ~ '${RE_NAIL}' AND blob !~ '${RE_NOT_NAIL}') AS is_nail,
    (blob ~ '${RE_CUT}')   AS is_cut
  FROM txt
),
done AS (SELECT * FROM v WHERE status='done' AND starts_at <= now())
`;

// Лист 1: ходить на нігті останні 3 міс, але жодного разу не фарбувалась і не робила догляд
const Q_UPSELL = BASE + `
SELECT c.id, c.name, c.phone,
  (SELECT count(*) FROM done d WHERE d.client_id=c.id AND d.is_nail AND d.starts_at > now()-interval '3 months') nail_3m,
  (SELECT count(*) FROM done d WHERE d.client_id=c.id AND d.is_nail) nail_all,
  (SELECT max(starts_at)::date + time '12:00' FROM done d WHERE d.client_id=c.id AND d.is_nail) last_nail,
  (SELECT round(avg(amount)) FROM done d WHERE d.client_id=c.id AND d.is_nail AND amount>0) avg_nail,
  (SELECT round(sum(amount)) FROM done d WHERE d.client_id=c.id) total_spent,
  EXISTS (SELECT 1 FROM done d WHERE d.client_id=c.id AND d.is_cut) was_cut,
  EXISTS (SELECT 1 FROM v d WHERE d.client_id=c.id AND d.status='booked' AND d.starts_at>now()) has_booking
FROM clients c
WHERE c.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM done d WHERE d.client_id=c.id AND d.is_nail AND d.starts_at > now()-interval '3 months')
  AND NOT EXISTS (SELECT 1 FROM done d WHERE d.client_id=c.id AND d.is_color)
  AND NOT EXISTS (SELECT 1 FROM done d WHERE d.client_id=c.id AND d.is_care)
ORDER BY 4 DESC, 8 DESC NULLS LAST;
`;

// Лист 2: фарбувалась останні 3 міс, але жодного разу не була на нігтях
const Q_UPSELL_NAIL = BASE + `
SELECT c.id, c.name, c.phone,
  (SELECT count(*) FROM done d WHERE d.client_id=c.id AND d.is_color AND d.starts_at > now()-interval '3 months') color_3m,
  (SELECT count(*) FROM done d WHERE d.client_id=c.id AND d.is_color) color_all,
  (SELECT max(starts_at)::date + time '12:00' FROM done d WHERE d.client_id=c.id AND d.is_color) last_color,
  (SELECT round(avg(amount)) FROM done d WHERE d.client_id=c.id AND d.is_color AND amount>0) avg_color,
  (SELECT round(sum(amount)) FROM done d WHERE d.client_id=c.id) total_spent,
  EXISTS (SELECT 1 FROM done d WHERE d.client_id=c.id AND d.is_care) was_care,
  EXISTS (SELECT 1 FROM v d WHERE d.client_id=c.id AND d.status='booked' AND d.starts_at>now()) has_booking
FROM clients c
WHERE c.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM done d WHERE d.client_id=c.id AND d.is_color AND d.starts_at > now()-interval '3 months')
  AND NOT EXISTS (SELECT 1 FROM done d WHERE d.client_id=c.id AND d.is_nail)
ORDER BY 8 DESC NULLS LAST, 4 DESC;
`;

const Q_LAPSED = (kind) => BASE + `,
last_k AS (SELECT DISTINCT ON (client_id) client_id, starts_at last_at FROM done WHERE is_${kind} ORDER BY client_id, starts_at DESC)
SELECT c.id, c.name, c.phone, lk.last_at::date + time '12:00' last_at,
  (now()::date - lk.last_at::date) days,
  (SELECT count(*) FROM done d WHERE d.client_id=c.id AND d.is_${kind}) visits,
  (SELECT round(avg(amount)) FROM done d WHERE d.client_id=c.id AND d.is_${kind} AND amount>0) avg_check,
  (SELECT max(starts_at)::date + time '12:00' FROM done d WHERE d.client_id=c.id) last_any,
  EXISTS (SELECT 1 FROM v d WHERE d.client_id=c.id AND d.status='booked' AND d.starts_at>now()) has_booking
FROM last_k lk JOIN clients c ON c.id=lk.client_id
WHERE c.deleted_at IS NULL
ORDER BY 5;
`;

const NORM = { color: 52, nail: 34 }; // p75 фактичного інтервалу повернення

const HEAD = { bold: true, color: { argb: 'FFFFFFFF' } };
const FILL = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

function styleSheet(ws, widths, headerColor) {
  ws.getRow(1).font = HEAD;
  ws.getRow(1).fill = FILL(headerColor);
  ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  ws.getRow(1).height = 28;
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: widths.length } };
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const upsell = (await c.query(Q_UPSELL)).rows;
  const upsellNail = (await c.query(Q_UPSELL_NAIL)).rows;
  const color = (await c.query(Q_LAPSED('color'))).rows;
  const nail = (await c.query(Q_LAPSED('nail'))).rows;
  await c.end();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CRM SVS Beauty Space';
  const today = new Date().toISOString().slice(0, 10);

  // --- Лист 1: апсейл
  const s1 = wb.addWorksheet('Манікюр без фарбування');
  s1.columns = [
    { header: 'Клієнт', key: 'name' }, { header: 'Телефон', key: 'phone' },
    { header: 'Візитів на нігті за 3 міс', key: 'n3' }, { header: 'Візитів на нігті всього', key: 'na' },
    { header: 'Останній візит', key: 'last' }, { header: 'Серед. чек, грн', key: 'avg' },
    { header: 'Витратила всього, грн', key: 'tot' }, { header: 'Стриглась у нас', key: 'cut' },
    { header: 'Є майбутній запис', key: 'bk' }, { header: 'Пріоритет', key: 'prio' },
  ];
  upsell.forEach(r => {
    const prio = r.was_cut ? 'A — вже стрижеться, легкий апсейл'
      : Number(r.nail_3m) >= 3 ? 'B — постійна на нігтях'
      : 'C — рідкісна';
    s1.addRow({
      name: r.name || 'без імені', phone: r.phone || '', n3: Number(r.nail_3m), na: Number(r.nail_all),
      last: r.last_nail, avg: Number(r.avg_nail || 0), tot: Number(r.total_spent || 0),
      cut: r.was_cut ? 'так' : 'ні', bk: r.has_booking ? 'так' : 'ні', prio,
    });
  });
  styleSheet(s1, [24, 16, 12, 12, 14, 13, 15, 13, 13, 32], 'FF7A4E9B');
  s1.getColumn(5).numFmt = 'dd.mm.yyyy';
  s1.eachRow((row, i) => { if (i > 1 && row.getCell(8).value === 'так') row.getCell(10).font = { bold: true, color: { argb: 'FF1E7B34' } }; });

  // --- Лист 2: фарбується, але не ходить на нігті
  const s2 = wb.addWorksheet('Фарбування без манікюру');
  s2.columns = [
    { header: 'Клієнт', key: 'name' }, { header: 'Телефон', key: 'phone' },
    { header: 'Фарбувань за 3 міс', key: 'c3' }, { header: 'Фарбувань всього', key: 'ca' },
    { header: 'Останнє фарбування', key: 'last' }, { header: 'Серед. чек, грн', key: 'avg' },
    { header: 'Витратила всього, грн', key: 'tot' }, { header: 'Робила догляд волосся', key: 'care' },
    { header: 'Є майбутній запис', key: 'bk' }, { header: 'Пріоритет', key: 'prio' },
  ];
  upsellNail.forEach(r => {
    const prio = Number(r.color_3m) >= 2 ? 'A — регулярна, найлегший апсейл'
      : Number(r.avg_color || 0) >= 1500 ? 'B — дорогий чек, платоспроможна'
      : 'C — разова';
    s2.addRow({
      name: r.name || 'без імені', phone: r.phone || '', c3: Number(r.color_3m), ca: Number(r.color_all),
      last: r.last_color, avg: Number(r.avg_color || 0), tot: Number(r.total_spent || 0),
      care: r.was_care ? 'так' : 'ні', bk: r.has_booking ? 'так' : 'ні', prio,
    });
  });
  styleSheet(s2, [24, 16, 12, 12, 15, 13, 15, 15, 13, 32], 'FF2E7D6B');
  s2.getColumn(5).numFmt = 'dd.mm.yyyy';
  s2.eachRow((row, i) => { if (i > 1 && String(row.getCell(10).value)[0] === 'A') row.getCell(10).font = { bold: true, color: { argb: 'FF1E7B34' } }; });

  // --- Листи 3-4: не повернулись
  const mkLapsed = (title, rows, kind, colorHex) => {
    const ws = wb.addWorksheet(title);
    ws.columns = [
      { header: 'Клієнт', key: 'name' }, { header: 'Телефон', key: 'phone' },
      { header: 'Останній візит', key: 'last' }, { header: 'Днів тому', key: 'days' },
      { header: 'Візитів на послугу', key: 'v' }, { header: 'Серед. чек, грн', key: 'avg' },
      { header: 'Приходила на інше після', key: 'other' }, { header: 'Статус', key: 'st' },
    ];
    rows.filter(r => !r.has_booking && r.days >= NORM[kind]).forEach(r => {
      const cameAfter = String(r.last_any) !== String(r.last_at);
      const st = cameAfter ? 'ходить, але не на цю послугу'
        : r.days > 90 ? 'втрачена' : 'прострочка — можна повернути';
      ws.addRow({
        name: r.name || 'без імені', phone: r.phone || '', last: r.last_at, days: r.days,
        v: Number(r.visits), avg: Number(r.avg_check || 0), other: cameAfter ? r.last_any : '', st,
      });
    });
    styleSheet(ws, [24, 16, 14, 11, 14, 14, 20, 30], colorHex);
    ws.getColumn(3).numFmt = 'dd.mm.yyyy';
    ws.getColumn(7).numFmt = 'dd.mm.yyyy';
    ws.eachRow((row, i) => {
      if (i === 1) return;
      const st = row.getCell(8).value;
      if (st === 'втрачена') row.getCell(8).font = { color: { argb: 'FFB00020' } };
      if (String(st).startsWith('прострочка')) row.getCell(8).font = { bold: true, color: { argb: 'FFB36B00' } };
    });
    return ws;
  };
  mkLapsed('Не повернулись — фарбування', color, 'color', 'FF9B4E4E');
  mkLapsed('Не повернулись — нігті', nail, 'nail', 'FF4E6B9B');

  // --- Лист 4: зведення
  const s4 = wb.addWorksheet('Зведення');
  s4.columns = [{ header: 'Показник', key: 'k' }, { header: 'Значення', key: 'v' }];
  const lapsedC = color.filter(r => !r.has_booking && r.days >= NORM.color);
  const lapsedN = nail.filter(r => !r.has_booking && r.days >= NORM.nail);
  const money = (arr) => arr.reduce((s, r) => s + Number(r.avg_check || 0), 0);
  const rowsSum = [
    ['Дата звіту', today],
    ['Норма повернення на фарбування (медіана), днів', 37],
    ['Норма повернення на нігті (медіана), днів', 22],
    ['— Апсейл: манікюр без фарбування і догляду —', ''],
    ['Всього таких клієнток за 3 місяці', upsell.length],
    ['З них вже стрижуться у нас (пріоритет А)', upsell.filter(r => r.was_cut).length],
    ['Постійні на нігтях (3+ візити за 3 міс)', upsell.filter(r => Number(r.nail_3m) >= 3).length],
    ['— Апсейл: фарбування без манікюру —', ''],
    ['Всього таких клієнток за 3 місяці', upsellNail.length],
    ['З них фарбувались 2+ рази (пріоритет А)', upsellNail.filter(r => Number(r.color_3m) >= 2).length],
    ['Середній чек фарбування у них, грн', upsellNail.length ? Math.round(upsellNail.reduce((s, r) => s + Number(r.avg_color || 0), 0) / upsellNail.length) : 0],
    ['— Не повернулись —', ''],
    ['Фарбування: прострочили норму', lapsedC.length],
    ['Фарбування: потенціал повернення, грн', money(lapsedC)],
    ['Нігті: прострочили норму', lapsedN.length],
    ['Нігті: потенціал повернення, грн', money(lapsedN)],
  ];
  rowsSum.forEach(([k, v]) => {
    const row = s4.addRow({ k, v });
    if (String(k).startsWith('—')) { row.font = { bold: true }; row.getCell(1).fill = FILL('FFEDE7F6'); }
  });
  styleSheet(s4, [52, 22], 'FF37474F');

  const out = process.argv[2] || `/tmp/crm-klienty-${today}.xlsx`;
  await wb.xlsx.writeFile(out);
  console.log(JSON.stringify({ file: out, upsell: upsell.length, upsell_cut: upsell.filter(r => r.was_cut).length, lapsed_color: lapsedC.length, lapsed_nail: lapsedN.length }));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
