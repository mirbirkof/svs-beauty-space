/* lib/service-cadence.js — возвращаемость по КАЖДОЙ услуге, из реальных данных.
 *
 * Запрос Босса 28.07: «период возвращаемости ногтевиков и волосевиков разный —
 * аналитика должна быть грамотнее». Факт из БД: у всех услуг rebook_interval_days = NULL,
 * т.е. «Розумний режим» и AI работали по одному общему порогу для всех.
 *
 * Здесь считается ФАКТИЧЕСКИЙ ритм: для каждой услуги берутся пары «визит → следующий
 * визит того же клиента по той же услуге» (визит = уникальный день, Киев; отмены/неявки/
 * артефакты синка исключены) и выводятся медиана и 75-й перцентиль интервала.
 *   • median_days — типичный цикл («ногти раз в 3 недели»)
 *   • p75_days    — 75% возвратов укладываются в этот срок
 *   • threshold_days = GREATEST(p75, 1.5×median) — «клиент выпал из ритма этой услуги»
 * Минимум 5 пар возвратов — иначе статистика шумная и услуга не участвует.
 *
 * Использование:
 *   SVC_CADENCE_CTE — фрагмент CTE (вставлять в WITH ... как `svc_cadence`)
 *   getServiceCadence(pool) — топ услуг с ритмом для AI-снапшота/отчётов
 */

const SVC_CADENCE_INNER = `
  SELECT service_id,
         ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap))::numeric)::int AS median_days,
         ROUND((PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY gap))::numeric)::int AS p75_days,
         GREATEST(ROUND((PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY gap))::numeric),
                  CEIL((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap)) * 1.5))::int AS threshold_days,
         COUNT(*)::int AS return_pairs,
         COUNT(DISTINCT client_id)::int AS returning_clients
  FROM (
    SELECT service_id, client_id,
           day - LAG(day) OVER (PARTITION BY service_id, client_id ORDER BY day) AS gap
    FROM (
      SELECT a.service_id, a.client_id, (a.starts_at AT TIME ZONE 'Europe/Kiev')::date AS day
      FROM appointments a
      WHERE a.status NOT IN ('cancelled','noshow')
        AND a.starts_at <= NOW()
        AND COALESCE(a.bp_state,'') NOT IN ('bp_deleted','not_in_bukon','phantom_dup')
        AND a.client_id IS NOT NULL AND a.service_id IS NOT NULL
      GROUP BY 1,2,3
    ) vd
  ) g
  WHERE gap > 0
  GROUP BY service_id
  HAVING COUNT(*) >= 5`;

const SVC_CADENCE_CTE = `svc_cadence AS (${SVC_CADENCE_INNER})`;

/** Топ услуг с фактическим ритмом возврата (для AI-снапшота и отчётов). */
async function getServiceCadence(pool, limit = 20) {
  const r = await pool.query(
    `WITH ${SVC_CADENCE_CTE}
     SELECT s.name, s.category, sc.median_days, sc.p75_days, sc.threshold_days,
            sc.return_pairs, sc.returning_clients, s.rebook_interval_days AS configured_days
     FROM svc_cadence sc JOIN services s ON s.id = sc.service_id
     ORDER BY sc.return_pairs DESC
     LIMIT $1`, [limit]).catch(() => ({ rows: [] }));
  return r.rows.map(x => ({
    service: x.name, category: x.category,
    median_days: x.median_days, p75_days: x.p75_days,
    overdue_threshold_days: x.threshold_days,
    return_pairs: x.return_pairs, returning_clients: x.returning_clients,
    configured_days: x.configured_days != null ? Number(x.configured_days) : null,
  }));
}

module.exports = { SVC_CADENCE_CTE, SVC_CADENCE_INNER, getServiceCadence };
