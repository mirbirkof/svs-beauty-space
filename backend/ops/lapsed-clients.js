#!/usr/bin/env node
/**
 * Статистика "хто не повернувся": окрашивание (волосся) и ногти.
 * Визит классифицируется по: services.name (service_id), appointment_services, services_text.
 */
require('dotenv').config();
const { Client } = require('pg');

const COLOR_RE = "(фарбув|фарбуан|мелірув|мілірув|тонув|airtouch|air touch|тотал блонд|вихід з чорного|контурінг|контуринг|балаяж|шатуш|окрашив|колорув)";
const NAIL_RE = "(манікюр|педикюр|нігт|нігті|гель лак|гель-лак|френч|укріплення|нарощування нігт|корекція нарощен)";
const EXCL_NAIL = "(вій|вії|брів|брови|вія)";

const SQL = `
WITH txt AS (
  SELECT a.id, a.client_id, a.starts_at, a.status,
         lower(coalesce(s.name,'') || ' ' || coalesce(a.services_text,'') || ' ' ||
               coalesce((SELECT string_agg(coalesce(s2.name, ''), ' ')
                         FROM appointment_services asv
                         LEFT JOIN services s2 ON s2.id = asv.service_id
                         WHERE asv.appointment_id = a.id), '')) AS blob
  FROM appointments a
  LEFT JOIN services s ON s.id = a.service_id
  WHERE a.client_id IS NOT NULL
),
v AS (
  SELECT id, client_id, starts_at, status,
         (blob ~ '${COLOR_RE}') AS is_color,
         (blob ~ '${NAIL_RE}' AND blob !~ '${EXCL_NAIL}') AS is_nail
  FROM txt
),
done AS (SELECT * FROM v WHERE status = 'done' AND starts_at <= now()),
last_color AS (
  SELECT DISTINCT ON (client_id) client_id, starts_at AS last_at
  FROM done WHERE is_color ORDER BY client_id, starts_at DESC
),
last_nail AS (
  SELECT DISTINCT ON (client_id) client_id, starts_at AS last_at
  FROM done WHERE is_nail ORDER BY client_id, starts_at DESC
),
upcoming AS (
  SELECT client_id,
         bool_or(is_color) AS book_color,
         bool_or(is_nail)  AS book_nail,
         bool_or(true)     AS book_any
  FROM v WHERE status = 'booked' AND starts_at > now() GROUP BY client_id
)
SELECT 'color' AS kind, c.id, c.name, c.phone, lc.last_at,
       (now()::date - lc.last_at::date) AS days,
       (SELECT count(*) FROM done d WHERE d.client_id=c.id AND d.is_color) AS visits_kind,
       (SELECT max(starts_at) FROM done d WHERE d.client_id=c.id) AS last_any,
       coalesce(u.book_color,false) AS booked_kind, coalesce(u.book_any,false) AS booked_any
FROM last_color lc JOIN clients c ON c.id=lc.client_id LEFT JOIN upcoming u ON u.client_id=c.id
WHERE c.deleted_at IS NULL
UNION ALL
SELECT 'nail', c.id, c.name, c.phone, ln.last_at,
       (now()::date - ln.last_at::date),
       (SELECT count(*) FROM done d WHERE d.client_id=c.id AND d.is_nail),
       (SELECT max(starts_at) FROM done d WHERE d.client_id=c.id),
       coalesce(u.book_nail,false), coalesce(u.book_any,false)
FROM last_nail ln JOIN clients c ON c.id=ln.client_id LEFT JOIN upcoming u ON u.client_id=c.id
WHERE c.deleted_at IS NULL
ORDER BY 6 ASC;
`;

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const { rows } = await c.query(SQL);
  await c.end();
  console.log(JSON.stringify(rows));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
