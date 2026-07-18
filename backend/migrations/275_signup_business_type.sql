-- 275: выбор вертикали при самостоятельной регистрации (Phase A SaaS-фундамента, 18.07.2026).
-- Раньше business_type назначал только оператор через saas-admin PATCH — фитнес-клуб или
-- стоматология физически не могли зарегистрироваться сами. Заявка (pending_signups) теперь
-- несёт вертикаль до финализации. Валидация значения — на границе (public-signup) + CHECK в tenants (272).
ALTER TABLE pending_signups ADD COLUMN IF NOT EXISTS business_type TEXT NOT NULL DEFAULT 'beauty';
