-- 286: включить запрет записей-близнецов НЕМЕДЛЕННО, не дожидаясь разбора истории.
--
-- Миграция 285 ставила индекс только «когда чисто», а чисто не стало: осталась пара
-- 5489/5490 от 18.07 (оплаты 600 и 500 под карточкой-заглушкой «Лены Клиен Юра») —
-- возможно, это два разных живых человека, и трогать её без владельца нельзя.
-- Из-за одной спорной пары защита не включалась вообще — недопустимо.
--
-- Решение: индекс действует ВПЕРЁД. Условие ограничено записями, созданными начиная
-- с момента установки. Историю не трогаем (её разбирает отчёт /api/reports/duplicates),
-- а любой новый двойной клик — откуда угодно — база отклонит физически.

DO $$
BEGIN
  IF to_regclass('public.uq_appt_no_exact_dup') IS NULL
     AND to_regclass('public.uq_appt_no_exact_dup_fwd') IS NULL THEN
    CREATE UNIQUE INDEX uq_appt_no_exact_dup_fwd
      ON appointments (tenant_id, master_id, starts_at, client_id, service_id)
      WHERE status NOT IN ('cancelled','noshow')
        AND client_id IS NOT NULL AND service_id IS NOT NULL
        AND COALESCE(bp_state,'') NOT IN ('bp_deleted','not_in_bukon','phantom_dup')
        AND created_at >= TIMESTAMPTZ '2026-07-28 21:00:00+03';
    RAISE NOTICE '[286] forward-only duplicate guard created';
  ELSE
    RAISE NOTICE '[286] duplicate guard already present';
  END IF;
END $$;
