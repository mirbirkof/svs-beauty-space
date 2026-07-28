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
//
// Аудит 25.07: считались СТРОКИ appointments, а один приход с тремя услугами — это три
// строки. Из-за этого порог «≥2 визита» проходили люди, бывшие в салоне ОДИН раз, и отток
// показывал 75 вместо 62. Теперь визит = уникальный день (Киев). Плюс будущие записи больше
// не считаются визитами, а клиент, уже записанный наперёд, в отток не попадает вообще.
const VISIT_DAYS = `COUNT(DISTINCT (a.starts_at AT TIME ZONE 'Europe/Kiev')::date) FILTER (WHERE a.starts_at <= NOW())`;
const LAST_PAST = `MAX(a.starts_at) FILTER (WHERE a.starts_at <= NOW())`;
const FIRST_PAST = `MIN(a.starts_at) FILTER (WHERE a.starts_at <= NOW())`;
const CHURNED_CTE = `WITH churned AS (
  SELECT c.id, c.name, c.phone, COALESCE(c.total_spent,0)::numeric AS spent,
         ${LAST_PAST} AS last_visit,
         ${VISIT_DAYS}::int AS visits
  FROM clients c JOIN appointments a ON a.client_id=c.id
  WHERE a.status NOT IN ('cancelled','noshow')
    AND COALESCE(a.bp_state,'') NOT IN ('bp_deleted','not_in_bukon','phantom_dup')
  GROUP BY c.id
  HAVING ${VISIT_DAYS} >= 2
     AND NOT bool_or(a.starts_at > NOW())
     AND (NOW()::date - ${LAST_PAST}::date)
         > GREATEST(90, 2 * (EXTRACT(EPOCH FROM (${LAST_PAST} - ${FIRST_PAST}))/86400)
                          / NULLIF(${VISIT_DAYS} - 1, 0)))`;

// Готовый запрос: количество клиентов в оттоке → { n }.
const CHURN_COUNT_SQL = `${CHURNED_CTE}
SELECT COUNT(*)::int AS n FROM churned`;

// Человекочитаемое определение (для UI/AI-подсказок).
const CHURN_DEFINITION = 'Клієнт у відтоку = мав ≥2 візити і не повертався довше за 2× свого звичного інтервалу (мін. 90 днів). Накопичений відтік за всю історію, НЕ «за 30 днів».';

module.exports = { CHURNED_CTE, CHURN_COUNT_SQL, CHURN_DEFINITION };
