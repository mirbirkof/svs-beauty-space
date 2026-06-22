/* lib/churn.js — ЕДИНОЕ определение оттока клиентов для всей CRM.
 *
 * Проблема (аудит 22.06): отток считался ДВУМЯ разными формулами:
 *   • ai.js  — cadence-aware: ≥2 визита и пропуск > 2× обычного интервала (мин. 90 дней)
 *   • reports.js (дашборд ×2, /churn) — фиксированные 90 дней
 * → AI-ассистент и дашборд показывали РАЗНЫЕ числа оттока для одного салона.
 *   Это и есть «2+2=5»: метрика обязана быть единой на всех экранах.
 *
 * Канон — cadence-aware: клиент на цикле «раз в 2 мес» не считается оттоком на 95-й
 * день, только когда реально выпал из своего ритма. Все поверхности импортируют
 * отсюда, никаких локальных копий SQL.
 */

// CTE `churned` — выбирает выпавших клиентов. Без параметров.
const CHURNED_CTE = `WITH churned AS (
  SELECT c.id, c.name, c.phone, COALESCE(c.total_spent,0)::numeric AS spent,
         MAX(a.starts_at) AS last_visit,
         COUNT(a.id)::int AS visits
  FROM clients c JOIN appointments a ON a.client_id=c.id
  WHERE a.status NOT IN ('cancelled','noshow')
  GROUP BY c.id
  HAVING COUNT(a.id) >= 2
     AND (NOW()::date - MAX(a.starts_at)::date)
         > GREATEST(90, 2 * (EXTRACT(EPOCH FROM (MAX(a.starts_at)-MIN(a.starts_at)))/86400) / (COUNT(a.id)-1)))`;

// Готовый запрос: количество клиентов в оттоке → { n }.
const CHURN_COUNT_SQL = `${CHURNED_CTE}
SELECT COUNT(*)::int AS n FROM churned`;

// Человекочитаемое определение (для UI/AI-подсказок).
const CHURN_DEFINITION = 'Клієнт у відтоку = мав ≥2 візити і не повертався довше за 2× свого звичного інтервалу (мін. 90 днів). Накопичений відтік за всю історію, НЕ «за 30 днів».';

module.exports = { CHURNED_CTE, CHURN_COUNT_SQL, CHURN_DEFINITION };
