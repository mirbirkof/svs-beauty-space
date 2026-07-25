/* routes/analytics-clients.js — «Апсейл і повернення» (25.07.2026, задача Босса).
   Чотири сегменти клієнтської бази, які рахуються НА ЛЬОТУ (не зберігаються):
     nail_no_color — ходить на нігті, жодного разу не фарбувалась і не робила догляд
     color_no_nail — фарбується, жодного разу не була на нігтях
     lapsed_color / lapsed_nail — прострочили власну норму повернення

   Норма повернення НЕ захардкоджена: береться медіана та p75 фактичного інтервалу
   між візитами цього ж салону (у нас вийшло 37/52 дні на фарбування, 22/34 на нігті).
   Послуга визначається за трьома джерелами разом (services.name + services_text +
   appointment_services), бо частина записів історична і має лише текст.

   Доступ: право clients.read (власник, адмін, менеджер, маркетолог, рецепція)
   + тарифна фіча retention.analytics. Гейт вішається при монтуванні в shop-api.js. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const { cacheReport } = require('../lib/report-cache');

const router = express.Router();
const pool = getPool();

const RE_COLOR = "(фарбув|фарбуан|мелірув|мілірув|тонув|airtouch|air touch|тотал блонд|вихід з чорного|контурінг|контуринг|балаяж|шатуш|окрашив|колорув)";
const RE_CARE = "(відновлен|біовирівнюв|бовирівюв|біозавив|полірув|biomimetic|кератин|ботокс|нанопласт|ламінування волосся)";
const RE_NAIL = "(манікюр|педикюр|нігт|гель лак|гель-лак|френч|укріплення|корекція нарощен)";
const RE_NOT_NAIL = "(вій|вії|брів|брови)";
const RE_CUT = "(стрижк)";

/* Один прохід по записах: класифікація + агрегат на клієнта.
   Раніше робив підзапит на кожного клієнта — на 5к клієнтів це десятки секунд. */
const AGG = `
WITH v AS (
  SELECT a.client_id, a.starts_at, a.status,
         coalesce(a.real_amount, a.price, 0) AS amount,
         (lower(coalesce(s.name,'') || ' ' || coalesce(a.services_text,'') || ' ' ||
           coalesce((SELECT string_agg(coalesce(s2.name,''), ' ')
                       FROM appointment_services asv
                       LEFT JOIN services s2 ON s2.id = asv.service_id
                      WHERE asv.appointment_id = a.id), ''))) AS blob
    FROM appointments a
    LEFT JOIN services s ON s.id = a.service_id
   WHERE a.client_id IS NOT NULL
),
f AS (
  SELECT client_id, starts_at, status, amount,
         (status = 'done' AND starts_at <= now()) AS did,
         (starts_at > now() - ($1 || ' months')::interval) AS recent,
         (blob ~ '${RE_COLOR}') AS c,
         (blob ~ '${RE_CARE}') AS k,
         (blob ~ '${RE_NAIL}' AND blob !~ '${RE_NOT_NAIL}') AS n,
         (blob ~ '${RE_CUT}') AS t
    FROM v
),
agg AS (
  SELECT client_id,
    count(*) FILTER (WHERE did AND c) color_all,
    count(*) FILTER (WHERE did AND c AND recent) color_recent,
    count(*) FILTER (WHERE did AND n) nail_all,
    count(*) FILTER (WHERE did AND n AND recent) nail_recent,
    count(*) FILTER (WHERE did AND k) care_all,
    count(*) FILTER (WHERE did AND t) cut_all,
    max(starts_at) FILTER (WHERE did AND c)::date last_color,
    max(starts_at) FILTER (WHERE did AND n)::date last_nail,
    max(starts_at) FILTER (WHERE did)::date last_any,
    round(avg(amount) FILTER (WHERE did AND c AND amount > 0)) avg_color,
    round(avg(amount) FILTER (WHERE did AND n AND amount > 0)) avg_nail,
    round(sum(amount) FILTER (WHERE did)) total_spent,
    bool_or(status = 'booked' AND starts_at > now()) has_booking
  FROM f GROUP BY client_id
)
`;

const SELECT_CLIENT = `
  c.id, c.name, c.phone, a.color_all, a.color_recent, a.nail_all, a.nail_recent,
  a.care_all, a.cut_all, a.last_color, a.last_nail, a.last_any,
  a.avg_color, a.avg_nail, a.total_spent, coalesce(a.has_booking,false) has_booking,
  (now()::date - a.last_color) days_color,
  (now()::date - a.last_nail) days_nail
`;

const WHERE = {
  nail_no_color: `a.nail_recent > 0 AND a.color_all = 0 AND a.care_all = 0`,
  color_no_nail: `a.color_recent > 0 AND a.nail_all = 0`,
  lapsed_color: `a.color_all > 0 AND NOT coalesce(a.has_booking,false) AND (now()::date - a.last_color) >= $2`,
  lapsed_nail: `a.nail_all > 0 AND NOT coalesce(a.has_booking,false) AND (now()::date - a.last_nail) >= $2`,
};
const ORDER = {
  nail_no_color: `a.nail_recent DESC, a.total_spent DESC NULLS LAST`,
  color_no_nail: `a.total_spent DESC NULLS LAST, a.color_recent DESC`,
  lapsed_color: `(now()::date - a.last_color) ASC`,
  lapsed_nail: `(now()::date - a.last_nail) ASC`,
};

/* Фактична норма повернення салону, а не вигадана */
async function norms() {
  const q = `
  WITH v AS (
    SELECT a.client_id, a.starts_at,
           (lower(coalesce(s.name,'') || ' ' || coalesce(a.services_text,'') || ' ' ||
             coalesce((SELECT string_agg(coalesce(s2.name,''), ' ')
                         FROM appointment_services asv
                         LEFT JOIN services s2 ON s2.id = asv.service_id
                        WHERE asv.appointment_id = a.id), ''))) AS blob
      FROM appointments a LEFT JOIN services s ON s.id = a.service_id
     WHERE a.client_id IS NOT NULL AND a.status='done' AND a.starts_at <= now()
  ),
  g AS (
    SELECT 'color' k, (starts_at::date - lag(starts_at) OVER (PARTITION BY client_id ORDER BY starts_at)::date) gap
      FROM v WHERE blob ~ '${RE_COLOR}'
    UNION ALL
    SELECT 'nail', (starts_at::date - lag(starts_at) OVER (PARTITION BY client_id ORDER BY starts_at)::date)
      FROM v WHERE blob ~ '${RE_NAIL}' AND blob !~ '${RE_NOT_NAIL}'
  )
  SELECT k, count(*) pairs,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)::int median,
         percentile_cont(0.75) WITHIN GROUP (ORDER BY gap)::int p75
    FROM g WHERE gap BETWEEN 5 AND 200 GROUP BY k`;
  const r = await pool.query(q);
  const out = { color: { median: 37, p75: 52, pairs: 0 }, nail: { median: 22, p75: 34, pairs: 0 } };
  r.rows.forEach((x) => { out[x.k] = { median: x.median, p75: x.p75, pairs: Number(x.pairs) }; });
  return out;
}

router.use(requirePerm('clients.read'));

/* Зведення: норми + кількість у кожному сегменті + потенціал у грошах */
router.get('/summary', cacheReport(), async (req, res) => {
  try {
    const months = Number(req.query.months) || 3;
    const n = await norms();
    const q = `${AGG}
      SELECT
        count(*) FILTER (WHERE ${WHERE.nail_no_color}) nail_no_color,
        count(*) FILTER (WHERE a.nail_recent > 0 AND a.color_all = 0 AND a.care_all = 0 AND a.cut_all > 0) nail_no_color_but_cut,
        count(*) FILTER (WHERE ${WHERE.color_no_nail}) color_no_nail,
        count(*) FILTER (WHERE a.color_recent > 0 AND a.nail_all = 0 AND a.color_recent >= 2) color_no_nail_regular,
        count(*) FILTER (WHERE a.color_all > 0 AND NOT coalesce(a.has_booking,false) AND (now()::date - a.last_color) >= $2) lapsed_color,
        count(*) FILTER (WHERE a.nail_all > 0 AND NOT coalesce(a.has_booking,false) AND (now()::date - a.last_nail) >= $3) lapsed_nail,
        coalesce(sum(a.avg_color) FILTER (WHERE a.color_all > 0 AND NOT coalesce(a.has_booking,false) AND (now()::date - a.last_color) >= $2),0) lapsed_color_money,
        coalesce(sum(a.avg_nail) FILTER (WHERE a.nail_all > 0 AND NOT coalesce(a.has_booking,false) AND (now()::date - a.last_nail) >= $3),0) lapsed_nail_money,
        coalesce(round(avg(a.avg_nail) FILTER (WHERE a.nail_all > 0)),0) avg_nail_check,
        coalesce(round(avg(a.avg_color) FILTER (WHERE a.color_all > 0)),0) avg_color_check
      FROM agg a JOIN clients c ON c.id = a.client_id AND c.deleted_at IS NULL`;
    const r = await pool.query(q, [String(months), n.color.p75, n.nail.p75]);
    const s = r.rows[0] || {};
    res.json({ ok: true, months, norms: n, counts: {
      nail_no_color: Number(s.nail_no_color || 0),
      nail_no_color_but_cut: Number(s.nail_no_color_but_cut || 0),
      color_no_nail: Number(s.color_no_nail || 0),
      color_no_nail_regular: Number(s.color_no_nail_regular || 0),
      lapsed_color: Number(s.lapsed_color || 0),
      lapsed_nail: Number(s.lapsed_nail || 0),
    }, money: {
      lapsed_color: Number(s.lapsed_color_money || 0),
      lapsed_nail: Number(s.lapsed_nail_money || 0),
      upsell_nail_no_color: Number(s.nail_no_color || 0) * Number(s.avg_color_check || 0),
      upsell_color_no_nail: Number(s.color_no_nail || 0) * Number(s.avg_nail_check || 0),
      avg_nail_check: Number(s.avg_nail_check || 0),
      avg_color_check: Number(s.avg_color_check || 0),
    } });
  } catch (e) {
    console.error('[analytics-clients] summary', e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message });
  }
});

/* Список клієнтів одного сегмента */
router.get('/segment', cacheReport(), async (req, res) => {
  try {
    const key = String(req.query.key || '');
    if (!WHERE[key]) return res.status(400).json({ error: 'bad-segment', allowed: Object.keys(WHERE) });
    const months = Number(req.query.months) || 3;
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const n = await norms();
    const params = [String(months)];
    if (key.startsWith('lapsed_')) params.push(key === 'lapsed_color' ? n.color.p75 : n.nail.p75);
    const q = `${AGG}
      SELECT ${SELECT_CLIENT}
        FROM agg a JOIN clients c ON c.id = a.client_id AND c.deleted_at IS NULL
       WHERE ${WHERE[key]}
       ORDER BY ${ORDER[key]}
       LIMIT ${limit}`;
    const r = await pool.query(q, params);
    res.json({ ok: true, key, norms: n, count: r.rows.length, items: r.rows });
  } catch (e) {
    console.error('[analytics-clients] segment', e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message });
  }
});

/* Мітки для картки клієнта: чого людина в нас ніколи не робила */
router.get('/client/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad-id' });
    const n = await norms();
    const q = `${AGG}
      SELECT ${SELECT_CLIENT} FROM agg a JOIN clients c ON c.id = a.client_id
       WHERE c.id = $2`;
    const r = await pool.query(q, ['3', id]);
    if (!r.rows.length) return res.json({ ok: true, tags: [] });
    const x = r.rows[0];
    const tags = [];
    if (Number(x.nail_all) > 0 && Number(x.color_all) === 0) tags.push({ t: 'ніколи не фарбувалась', kind: 'upsell' });
    if (Number(x.color_all) > 0 && Number(x.nail_all) === 0) tags.push({ t: 'ніколи не робила нігті', kind: 'upsell' });
    if (Number(x.color_all) > 0 && Number(x.care_all) === 0) tags.push({ t: 'без догляду волосся', kind: 'upsell' });
    if (!x.has_booking && x.days_color !== null && Number(x.days_color) >= n.color.p75) tags.push({ t: `фарбування прострочене (${x.days_color} дн)`, kind: 'lapsed' });
    if (!x.has_booking && x.days_nail !== null && Number(x.days_nail) >= n.nail.p75) tags.push({ t: `нігті прострочені (${x.days_nail} дн)`, kind: 'lapsed' });
    res.json({ ok: true, tags, stats: x, norms: n });
  } catch (e) {
    console.error('[analytics-clients] client', e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message });
  }
});

/* Вивантаження в Excel — те саме, що адмін бачить на екрані */
router.get('/export.xlsx', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const n = await norms();
    const months = Number(req.query.months) || 3;
    const sheets = [
      ['nail_no_color', 'Манікюр без фарбування', 'FF7A4E9B'],
      ['color_no_nail', 'Фарбування без манікюру', 'FF2E7D6B'],
      ['lapsed_color', 'Не повернулись — фарбування', 'FF9B4E4E'],
      ['lapsed_nail', 'Не повернулись — нігті', 'FF4E6B9B'],
    ];
    const wb = new ExcelJS.Workbook();
    wb.creator = 'CRM';
    for (const [key, title, color] of sheets) {
      const params = [String(months)];
      if (key.startsWith('lapsed_')) params.push(key === 'lapsed_color' ? n.color.p75 : n.nail.p75);
      const r = await pool.query(`${AGG}
        SELECT ${SELECT_CLIENT} FROM agg a JOIN clients c ON c.id = a.client_id AND c.deleted_at IS NULL
         WHERE ${WHERE[key]} ORDER BY ${ORDER[key]} LIMIT 2000`, params);
      const ws = wb.addWorksheet(title);
      ws.columns = [
        { header: 'Клієнт', key: 'name', width: 24 },
        { header: 'Телефон', key: 'phone', width: 16 },
        { header: 'Візитів на фарбування', key: 'ca', width: 13 },
        { header: 'Візитів на нігті', key: 'na', width: 13 },
        { header: 'Останнє фарбування', key: 'lc', width: 15 },
        { header: 'Останні нігті', key: 'ln', width: 15 },
        { header: 'Серед. чек фарбування', key: 'ac', width: 15 },
        { header: 'Серед. чек нігті', key: 'an', width: 14 },
        { header: 'Витратила всього', key: 'ts', width: 15 },
        { header: 'Є майбутній запис', key: 'bk', width: 13 },
      ];
      r.rows.forEach((x) => ws.addRow({
        name: x.name || 'без імені', phone: x.phone || '', ca: Number(x.color_all), na: Number(x.nail_all),
        lc: x.last_color || '', ln: x.last_nail || '', ac: Number(x.avg_color || 0), an: Number(x.avg_nail || 0),
        ts: Number(x.total_spent || 0), bk: x.has_booking ? 'так' : 'ні',
      }));
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
      ws.getRow(1).height = 26;
      ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 10 } };
      ws.getColumn(5).numFmt = 'dd.mm.yyyy';
      ws.getColumn(6).numFmt = 'dd.mm.yyyy';
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="clients-segments.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('[analytics-clients] export', e);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message });
  }
});

module.exports = router;
