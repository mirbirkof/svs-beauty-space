/* lib/rfm.js — RFM-аналіз (MKT-04).
   Recency = днів з останнього візиту, Frequency = done-записи, Monetary = total_spent.
   Оцінки 1..5 — квінтилі (NTILE) серед активних клієнтів (frequency>=1).
   Матеріалізує у rfm_scores; повертає матрицю 5×5 і розподіл по макросегментах. */
const { getPool } = require('../db-pg');

// Пріоритетний маппінг R/F у макросегмент (галузевий стандарт, спрощений до 10).
const SEGMENT_CASE = `
  CASE
    WHEN r_score >= 4 AND f_score >= 4 THEN 'champions'
    WHEN r_score >= 3 AND f_score >= 4 THEN 'loyal'
    WHEN r_score >= 4 AND f_score = 1 THEN 'new'
    WHEN r_score >= 4 AND f_score BETWEEN 2 AND 3 THEN 'potential'
    WHEN r_score = 3 AND f_score <= 2 THEN 'promising'
    WHEN r_score = 3 AND f_score = 3 THEN 'need_attention'
    WHEN r_score <= 2 AND f_score >= 4 THEN 'cant_lose'
    WHEN r_score <= 2 AND f_score = 3 THEN 'at_risk'
    WHEN r_score <= 2 AND f_score = 2 THEN 'hibernating'
    ELSE 'lost'
  END`;

const SEGMENT_LABELS = {
  champions:      { ua: 'Чемпіони',          hint: 'Найкращі: свіжі, часті, дорогі. Берегти, VIP-програма.' },
  loyal:          { ua: 'Лояльні',           hint: 'Часто ходять. Допродаж, реферальна програма.' },
  potential:      { ua: 'Потенційно лояльні', hint: 'Свіжі, помірна частота. Підштовхнути до повтору.' },
  new:            { ua: 'Новачки',           hint: 'Перший візит нещодавно. Онбординг, друга знижка.' },
  promising:      { ua: 'Перспективні',      hint: 'Недавні, мало візитів. Нагадування, спецпропозиція.' },
  need_attention: { ua: 'Потребують уваги',  hint: 'Середні по всьому. Активувати акцією.' },
  at_risk:        { ua: 'Під ризиком',       hint: 'Давно не були, раніше ходили. Win-back терміново.' },
  cant_lose:      { ua: 'Не втратити',       hint: 'Колись цінні, давно зникли. Персональний дзвінок.' },
  hibernating:    { ua: 'Сплячі',            hint: 'Давно і рідко. Реактиваційна розсилка.' },
  lost:           { ua: 'Втрачені',          hint: 'Майже пішли. Остання спроба або відпустити.' },
};

// Перерахунок і матеріалізація у rfm_scores. Повертає к-сть оброблених.
async function refresh() {
  const pool = getPool();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('DELETE FROM rfm_scores');
    const r = await c.query(`
      WITH base AS (
        SELECT cl.id AS client_id,
               GREATEST(0, (CURRENT_DATE - cl.last_visit_at::date))::int AS recency_days,
               COUNT(a.id) FILTER (WHERE a.status = 'done')::int AS frequency,
               COALESCE(cl.total_spent, 0)::numeric AS monetary
          FROM clients cl
          LEFT JOIN appointments a ON a.client_id = cl.id
         GROUP BY cl.id, cl.last_visit_at, cl.total_spent
        HAVING COUNT(a.id) FILTER (WHERE a.status = 'done') >= 1
      ),
      scored AS (
        SELECT client_id, recency_days, frequency, monetary,
               NTILE(5) OVER (ORDER BY recency_days DESC)               AS r_score,
               NTILE(5) OVER (ORDER BY frequency ASC, recency_days DESC) AS f_score,
               NTILE(5) OVER (ORDER BY monetary ASC)                    AS m_score
          FROM base
      )
      INSERT INTO rfm_scores (client_id, recency_days, frequency, monetary, r_score, f_score, m_score, segment, computed_at)
      SELECT client_id, recency_days, frequency, monetary, r_score, f_score, m_score,
             ${SEGMENT_CASE}, NOW()
        FROM scored
      RETURNING 1`);
    await c.query('COMMIT');
    return r.rowCount;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

// Зведення: розподіл по сегментах + 5×5 матриця + загальні цифри.
async function summary() {
  const pool = getPool();
  const seg = await pool.query(
    `SELECT segment, COUNT(*)::int clients, ROUND(AVG(monetary),2)::float avg_monetary,
            ROUND(AVG(frequency),1)::float avg_frequency, ROUND(AVG(recency_days))::int avg_recency,
            SUM(monetary)::float total_monetary
       FROM rfm_scores GROUP BY segment ORDER BY total_monetary DESC NULLS LAST`);
  const matrix = await pool.query(
    `SELECT r_score, f_score, COUNT(*)::int clients FROM rfm_scores
      GROUP BY r_score, f_score ORDER BY r_score, f_score`);
  const meta = await pool.query(
    `SELECT COUNT(*)::int total, MAX(computed_at) computed_at FROM rfm_scores`);
  const segments = seg.rows.map(s => ({ ...s, ...(SEGMENT_LABELS[s.segment] || {}) }));
  return { total: meta.rows[0].total, computed_at: meta.rows[0].computed_at, segments, matrix: matrix.rows };
}

// Клієнти конкретного сегмента (для розсилки/експорту).
async function members(segment, { limit = 1000 } = {}) {
  const pool = getPool();
  const r = await pool.query(
    `SELECT s.client_id, c.name, c.phone, c.email, c.telegram_id,
            s.recency_days, s.frequency, s.monetary, s.r_score, s.f_score, s.m_score
       FROM rfm_scores s JOIN clients c ON c.id = s.client_id
      WHERE s.segment = $1 ORDER BY s.monetary DESC LIMIT $2`, [segment, limit]);
  return r.rows;
}

module.exports = { refresh, summary, members, SEGMENT_LABELS };
