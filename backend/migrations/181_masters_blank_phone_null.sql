-- 181: порожні phone/email/category майстрів → NULL
-- Причина: unique-обмеження (tenant_id, phone) трактує '' як значення, тож два майстри
-- без телефону падали в 23505 duplicate key при збереженні профілю — ламалося редагування
-- імені й усього профілю. NULL не конфліктує в unique-індексі. Код (schedule.js / employees.js)
-- тепер теж нормалізує '' → NULL на запис; ця міграція чистить історичні дані.
UPDATE masters SET phone    = NULL WHERE phone    IS NOT NULL AND TRIM(phone)    = '';
UPDATE masters SET email    = NULL WHERE email    IS NOT NULL AND TRIM(email)    = '';
UPDATE masters SET category = NULL WHERE category  IS NOT NULL AND TRIM(category) = '';
