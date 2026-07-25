#!/usr/bin/env node
/** Агрегация lapsed-clients.js в отчёт по бакетам + средний интервал возврата. */
require('dotenv').config();
const { Client } = require('pg');

const COLOR_RE = "(фарбув|фарбуан|мелірув|мілірув|тонув|airtouch|air touch|тотал блонд|вихід з чорного|контурінг|контуринг|балаяж|шатуш|окрашив|колорув)";
const NAIL_RE = "(манікюр|педикюр|нігт|гель лак|гель-лак|френч|укріплення|корекція нарощен)";
const EXCL_NAIL = "(вій|вії|брів|брови)";

const BASE = `
WITH txt AS (
  SELECT a.id, a.client_id, a.starts_at, a.status, a.price, a.real_amount,
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
  SELECT *, (blob ~ '${COLOR_RE}') AS is_color,
            (blob ~ '${NAIL_RE}' AND blob !~ '${EXCL_NAIL}') AS is_nail
  FROM txt
),
done AS (SELECT * FROM v WHERE status='done' AND starts_at <= now())
`;

const Q_INTERVAL = BASE + `
SELECT kind, count(*) pairs,
       round(avg(gap)::numeric,1) avg_gap,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) med_gap,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY gap) p75_gap
FROM (
  SELECT 'color' kind, (starts_at::date - lag(starts_at) OVER (PARTITION BY client_id ORDER BY starts_at)::date) gap
  FROM done WHERE is_color
  UNION ALL
  SELECT 'nail', (starts_at::date - lag(starts_at) OVER (PARTITION BY client_id ORDER BY starts_at)::date)
  FROM done WHERE is_nail
) t WHERE gap BETWEEN 5 AND 200 GROUP BY kind;
`;

const Q_MAIN = BASE + `,
last_color AS (SELECT DISTINCT ON (client_id) client_id, starts_at last_at FROM done WHERE is_color ORDER BY client_id, starts_at DESC),
last_nail  AS (SELECT DISTINCT ON (client_id) client_id, starts_at last_at FROM done WHERE is_nail  ORDER BY client_id, starts_at DESC),
upc AS (SELECT client_id, bool_or(is_color) bc, bool_or(is_nail) bn, true ba
        FROM v WHERE status='booked' AND starts_at > now() GROUP BY client_id)
SELECT 'color' kind, c.id, c.name, c.phone, lc.last_at::date last_at,
       (now()::date - lc.last_at::date) days,
       (SELECT count(*) FROM done d WHERE d.client_id=c.id AND d.is_color) visits_kind,
       (SELECT max(starts_at)::date FROM done d WHERE d.client_id=c.id) last_any,
       (SELECT round(avg(coalesce(d.real_amount,d.price,0))) FROM done d WHERE d.client_id=c.id AND d.is_color) avg_check,
       coalesce(u.bc,false) booked_kind, coalesce(u.ba,false) booked_any
FROM last_color lc JOIN clients c ON c.id=lc.client_id LEFT JOIN upc u ON u.client_id=c.id
WHERE c.deleted_at IS NULL
UNION ALL
SELECT 'nail', c.id, c.name, c.phone, ln.last_at::date, (now()::date - ln.last_at::date),
       (SELECT count(*) FROM done d WHERE d.client_id=c.id AND d.is_nail),
       (SELECT max(starts_at)::date FROM done d WHERE d.client_id=c.id),
       (SELECT round(avg(coalesce(d.real_amount,d.price,0))) FROM done d WHERE d.client_id=c.id AND d.is_nail),
       coalesce(u.bn,false), coalesce(u.ba,false)
FROM last_nail ln JOIN clients c ON c.id=ln.client_id LEFT JOIN upc u ON u.client_id=c.id
WHERE c.deleted_at IS NULL
ORDER BY 6;
`;

const BUCKETS = {
  color: [[30,44,'~1 місяць'],[45,59,'~1.5 місяця'],[60,89,'~2 місяці'],[90,119,'~3 місяці'],[120,9999,'4+ місяці']],
  nail:  [[21,29,'~3 тижні'],[30,44,'~1 місяць'],[45,59,'~1.5 місяця'],[60,89,'~2 місяці'],[90,9999,'3+ місяці']],
};

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const iv = (await c.query(Q_INTERVAL)).rows;
  const rows = (await c.query(Q_MAIN)).rows;
  await c.end();

  const out = { generated: new Date().toISOString(), intervals: iv, kinds: {} };
  for (const kind of ['color','nail']) {
    const list = rows.filter(r => r.kind === kind && !r.booked_kind);
    const buckets = BUCKETS[kind].map(([a,b,label]) => {
      const items = list.filter(r => r.days >= a && r.days <= b);
      const lost  = items.filter(r => !r.booked_any && (now => true)());
      return {
        label, from: a, to: b, count: items.length,
        // «зовсім не приходив» — жодного візиту будь-якого типу після цієї дати
        gone: items.filter(r => String(r.last_any) === String(r.last_at)).length,
        // ходить, але не на цю послугу
        alive_other: items.filter(r => String(r.last_any) !== String(r.last_at)).length,
        loyal: items.filter(r => Number(r.visits_kind) >= 3).length,
        money: items.reduce((s,r) => s + Number(r.avg_check||0), 0),
        clients: items.map(r => ({ id:r.id, name:r.name, phone:r.phone, last:String(r.last_at),
          days:r.days, visits:Number(r.visits_kind), avg:Number(r.avg_check||0),
          came_after: String(r.last_any) !== String(r.last_at) ? String(r.last_any) : null })),
      };
    });
    out.kinds[kind] = { total_clients: rows.filter(r=>r.kind===kind).length, buckets };
  }
  console.log(JSON.stringify(out, null, 1));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
