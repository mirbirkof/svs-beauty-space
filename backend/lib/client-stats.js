/* lib/client-stats.js — перерахунок вітринних лічильників клієнта з ПЕРШОДЖЕРЕЛА.
 *
 * Аудит 25.07: clients.total_spent жив своїм життям — його ніхто не збільшував при оплаті
 * (тільки зменшували при поверненнях) → занижений на 480 308 ₴ (21.6%), у 253 клієнтів 0
 * при реальних візитах. total_visits був заморожений разовим імпортом з 24.05,
 * last_visit_at у 258 клієнтів вказував на СКАСОВАНИЙ візит.
 *
 * Рішення: лічильники — похідні дані. Не інкрементуємо їх вручну (інкременти розʼїжджаються
 * назавжди), а перераховуємо з appointments + salon_product_sales одним запитом.
 * Виклик: після pay/unpay/зміни статусу — для одного клієнта (дешево, ~мс),
 * та bin-скриптом для всієї бази (разова синхронізація).
 *
 * Визначення (єдині для всієї CRM):
 *   візит        = унікальний день з записом done, що вже відбувся
 *   total_spent  = Σ coalesce(real_amount, price, 0) по done-візитах + Σ товарних продажів клієнта
 *   last_visit_at / first_visit_at — тільки по done-візитах, що відбулись
 */
const { getPool } = require('../db-pg');

const RECALC_SQL = `
  UPDATE clients c SET
    total_visits = agg.visits,
    total_spent  = agg.spent,
    first_visit_at = agg.first_v,
    last_visit_at  = agg.last_v,
    updated_at = NOW()
  FROM (
    SELECT cl.id,
      COALESCE(v.visits, 0)  AS visits,
      COALESCE(v.spent, 0) + COALESCE(ps.prod, 0) AS spent,
      v.first_v, v.last_v
    FROM clients cl
    LEFT JOIN (
      SELECT client_id,
             COUNT(DISTINCT (starts_at AT TIME ZONE 'Europe/Kyiv')::date)::int AS visits,
             ROUND(SUM(COALESCE(real_amount, price, 0)))::numeric AS spent,
             MIN(starts_at) AS first_v,
             MAX(starts_at) AS last_v
        FROM appointments
       WHERE status = 'done' AND starts_at <= NOW() AND client_id IS NOT NULL
       GROUP BY client_id
    ) v ON v.client_id = cl.id
    LEFT JOIN (
      SELECT client_id, ROUND(SUM(COALESCE(total_price,0)))::numeric AS prod
        FROM salon_product_sales WHERE client_id IS NOT NULL GROUP BY client_id
    ) ps ON ps.client_id = cl.id
    WHERE ($1::int IS NULL OR cl.id = $1::int)
  ) agg
  WHERE agg.id = c.id
    AND (c.total_visits IS DISTINCT FROM agg.visits
      OR c.total_spent  IS DISTINCT FROM agg.spent
      OR c.last_visit_at IS DISTINCT FROM agg.last_v
      OR c.first_visit_at IS DISTINCT FROM agg.first_v)`;

/** Перерахувати лічильники одного клієнта (clientId) або всієї бази (null). */
async function recalcClientStats(clientId = null, dbClient = null) {
  const runner = dbClient || getPool();
  const r = await runner.query(RECALC_SQL, [clientId]);
  return r.rowCount;
}

module.exports = { recalcClientStats };
