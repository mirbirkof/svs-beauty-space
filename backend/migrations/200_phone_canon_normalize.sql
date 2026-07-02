-- 200: Канон телефонів 380XXXXXXXXX (без '+') у всіх таблицях з phone-колонками.
-- Проблема (аудит 2026-07-02): client_loyalty/referrals/birthday_bonuses та ін.
-- зберігали '+380...' (локальний normalizePhone у routes/loyalty.js повертав '+'+d),
-- а clients.phone — канон '380...' (lib/phone.js normalizePhoneDb). Через це JOIN
-- client_loyalty.client_phone = clients.phone у lib/bonus.js _tierMultiplier ніколи
-- не матчився → тир-мультиплікатори лояльності завжди = 1.
--
-- Логіка = normalizePhoneDb: цифри; 380+9 → як є; 80+9 → '3'||d; 0+9 → '38'||d;
-- інше (іноземні, нестандартна довжина) — НЕ чіпаємо (щоб не калічити номери, #107).
-- Ідемпотентно: канонічні рядки не оновлюються (norm IS DISTINCT FROM col).
-- Захист унікальних індексів: рядок пропускається, якщо канонічний двійник вже існує
-- (на проді 2026-07-02 дублів не знайдено — SELECT-перевірка перед міграцією).

-- pg_temp: живе лише в сесії міграційного раннера (один client на весь файл)
CREATE FUNCTION pg_temp.svs_norm_ua_phone(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
           WHEN d ~ '^380[0-9]{9}$' THEN d
           WHEN d ~ '^80[0-9]{9}$'  THEN '3'  || d
           WHEN d ~ '^0[0-9]{9}$'   THEN '38' || d
         END
    FROM (SELECT regexp_replace(coalesce(p, ''), '\D', '', 'g') AS d) s
$fn$;

DO $mig$
DECLARE
  t RECORD;
  updated integer;
  dup_cond text;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('ai_call_recordings',      'client_phone', NULL),
      ('appointments_log',        'client_phone', NULL),
      ('birthday_bonuses',        'client_phone', 'tenant_id, year'),
      ('blacklist',               'client_phone', 'tenant_id'),
      ('cancel_tokens',           'client_phone', NULL),
      ('client_loyalty',          'client_phone', 'tenant_id'),
      ('favorites',               'client_phone', 'tenant_id, kind, target_id'),
      ('idempotency_keys',        'client_phone', NULL),
      ('masters',                 'phone',        'tenant_id'),
      ('online_bookings',         'client_phone', NULL),
      ('referrals',               'invited_phone', 'tenant_id'),
      ('referrals',               'referrer_phone', NULL),
      ('reviews',                 'client_phone', NULL),
      ('scheduled_notifications', 'client_phone', NULL),
      ('suppliers',               'phone',        NULL),
      ('users',                   'phone',        'tenant_id'),
      ('waitlist',                'client_phone', NULL)
    ) AS v(tbl, col, uniq_keys)
  LOOP
    -- таблиця/колонка можуть бути відсутні в частині середовищ — тихо пропускаємо
    CONTINUE WHEN to_regclass('public.' || t.tbl) IS NULL;
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t.tbl AND column_name = t.col);

    IF t.uniq_keys IS NULL THEN
      EXECUTE format($q$
        UPDATE %1$I SET %2$I = pg_temp.svs_norm_ua_phone(%2$I)
         WHERE pg_temp.svs_norm_ua_phone(%2$I) IS NOT NULL
           AND pg_temp.svs_norm_ua_phone(%2$I) IS DISTINCT FROM %2$I
      $q$, t.tbl, t.col);
    ELSE
      -- унікальний індекс включає phone-колонку: не оновлюємо рядок, якщо
      -- канонічний двійник з тими ж ключами вже існує (лишаємо як є — злиття вручну)
      SELECT string_agg(format('dup.%1$I IS NOT DISTINCT FROM tgt.%1$I', trim(k)), ' AND ')
        INTO dup_cond
        FROM unnest(string_to_array(t.uniq_keys, ',')) k;
      EXECUTE format($q$
        UPDATE %1$I AS tgt SET %2$I = pg_temp.svs_norm_ua_phone(tgt.%2$I)
         WHERE pg_temp.svs_norm_ua_phone(tgt.%2$I) IS NOT NULL
           AND pg_temp.svs_norm_ua_phone(tgt.%2$I) IS DISTINCT FROM tgt.%2$I
           AND NOT EXISTS (
             SELECT 1 FROM %1$I dup
              WHERE dup.%2$I = pg_temp.svs_norm_ua_phone(tgt.%2$I)
                AND %3$s
           )
      $q$, t.tbl, t.col, dup_cond);
    END IF;

    GET DIAGNOSTICS updated = ROW_COUNT;
    IF updated > 0 THEN
      RAISE NOTICE '200_phone_canon: %.% normalized % rows', t.tbl, t.col, updated;
    END IF;
  END LOOP;
END
$mig$;
