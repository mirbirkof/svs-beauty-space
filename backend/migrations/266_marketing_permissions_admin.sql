-- 266_marketing_permissions_admin.sql (17.07.2026)
-- AI Відеостудія (/api/ai/video/*) гейтиться marketing.read/marketing.write,
-- але роль admin НЕ мала жодного marketing-права → студія була закрита адмінам.
-- Біль салону: адмін має сам монтувати промо-ролики, не чекаючи власника.
-- Видаємо marketing.* адміну і маркетологу, marketing.read менеджеру. Ідемпотентно.

UPDATE roles
  SET permissions = permissions || '["marketing.read","marketing.write"]'::jsonb
  WHERE code = 'admin' AND NOT (permissions @> '["marketing.read"]'::jsonb);

UPDATE roles
  SET permissions = permissions || '["marketing.read","marketing.write"]'::jsonb
  WHERE code = 'marketer' AND NOT (permissions @> '["marketing.read"]'::jsonb);

UPDATE roles
  SET permissions = permissions || '["marketing.read"]'::jsonb
  WHERE code = 'manager' AND NOT (permissions @> '["marketing.read"]'::jsonb);
