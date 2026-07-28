-- 285: физический запрет записей-близнецов (аудит 28.07 — касса завышалась дублями).
--
-- ПРИЧИНА. Админка не блокировала кнопку «Записати» → двойной клик создавал ДВЕ
-- одинаковые записи (тот же салон/мастер/время/клиент/услуга). Гейт пересечений это
-- пропускал: у мастера max_parallel>1, поэтому «второй клиент в тот же слот» выглядел
-- легально. Обе записи потом оплачивались → визит попадал в кассу дважды.
-- Факт на 28.07: 20 таких пар за всю историю (18 — импорт BeautyPro, 2 — админка).
--
-- РЕШЕНИЕ. Заплатки на фронте (guard кнопки) и в коде (дедуп 2 мин) оставлены как
-- быстрый слой, но ЕДИНСТВЕННАЯ надёжная защита — уникальный индекс: база физически
-- не даст вставить точный дубль, откуда бы он ни пришёл (админка, бот, синк, скрипт).
--
-- Условие индекса:
--   • только живые записи (отменённые/неявки дублями не считаются — их может быть много);
--   • phantom_dup исключён: этой меткой помечены исторические дубли импорта, они
--     остаются в базе как архив, но из уникальности и аналитики выведены;
--   • client_id и service_id обязаны быть заданы (NULL-записи — черновики, не трогаем).

-- Шаг 1: пометить исторические дубли-близнецы меткой phantom_dup (не удаляем — архив).
-- Оставляем самую раннюю запись группы, лишние помечаем. Оплаченные НЕ трогаем —
-- по ним решение принимает владелец (это деньги в кассе).
UPDATE appointments a SET bp_state = 'phantom_dup'
WHERE a.id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
             PARTITION BY tenant_id, master_id, starts_at, client_id, service_id
             ORDER BY id) AS rn
    FROM appointments
    WHERE status NOT IN ('cancelled','noshow')
      AND client_id IS NOT NULL AND service_id IS NOT NULL
      AND COALESCE(bp_state,'') <> 'phantom_dup'
  ) t WHERE t.rn > 1
)
AND a.pay_settled_at IS NULL;

-- Шаг 2: уникальный индекс. Ставим только если чисто (оплаченные дубли могли остаться —
-- тогда индекс не создаётся, миграция не падает, повторится при следующем запуске).
DO $$
DECLARE dup_left int;
BEGIN
  SELECT COUNT(*) INTO dup_left FROM (
    SELECT 1 FROM appointments
    WHERE status NOT IN ('cancelled','noshow')
      AND client_id IS NOT NULL AND service_id IS NOT NULL
      AND COALESCE(bp_state,'') <> 'phantom_dup'
    GROUP BY tenant_id, master_id, starts_at, client_id, service_id
    HAVING COUNT(*) > 1
  ) t;

  IF dup_left = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_appt_no_exact_dup
      ON appointments (tenant_id, master_id, starts_at, client_id, service_id)
      WHERE status NOT IN ('cancelled','noshow')
        AND client_id IS NOT NULL AND service_id IS NOT NULL
        AND COALESCE(bp_state,'') <> 'phantom_dup';
    RAISE NOTICE '[285] unique index created';
  ELSE
    RAISE NOTICE '[285] % duplicate groups remain (paid) — index deferred', dup_left;
  END IF;
END $$;
