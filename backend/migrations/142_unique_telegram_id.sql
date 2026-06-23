-- 142: защита от угона аккаунта через подмену telegram_id (аудит 23.06, High #5)
--
-- Один Telegram chat_id должен принадлежать максимум одному сотруднику в тенанте,
-- иначе OTP-вход по этому chat_id может попасть в чужой аккаунт. Роут /link уже
-- проверяет владельца на уровне приложения; этот индекс гарантирует то же на уровне БД.
-- Partial: NULL-значения (несвязанные юзеры) не конфликтуют.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='users' AND column_name='telegram_id'
  ) THEN
    -- только если нет существующих дублей (иначе индекс не создастся — оставляем
    -- приложенческую проверку, дубли разруливаются вручную)
    IF NOT EXISTS (
      SELECT telegram_id FROM users
      WHERE telegram_id IS NOT NULL
      GROUP BY tenant_id, telegram_id HAVING count(*) > 1
    ) THEN
      EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_telegram_uniq '
            || 'ON users (tenant_id, telegram_id) WHERE telegram_id IS NOT NULL';
      RAISE NOTICE 'users_tenant_telegram_uniq создан';
    ELSE
      RAISE NOTICE 'найдены дубли telegram_id — индекс пропущен, разрулить вручную';
    END IF;
  END IF;
END $$;
