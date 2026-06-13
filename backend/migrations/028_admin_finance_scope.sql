-- 028: ограничение финансового доступа администратора.
-- Босс: админ видит ТОЛЬКО дневную кассу (сегодня), НЕ видит вчера/месяц/общую
-- финансовую статистику. Полный финансовый доступ — только владелец (или как доп-функция).
--
-- Вводим два «премиальных» права:
--   cashbox.history  — прошлые смены, Z-отчёты, налоги, операции закрытых смен
--   reports.finance  — P&L, выручка, дашборд денег, доходы мастеров
-- owner имеет '*' → покрывает оба. admin их НЕ получает по умолчанию.

-- АДМІН: полный операционный контроль, но касса — только текущий день,
-- финансовая аналитика закрыта (выдаётся точечно конкретному юзеру при необходимости).
UPDATE roles SET permissions = '[
  "crm.*","shop.*","cashbox.read","cashbox.write","cashbox.in",
  "reports.read","clients.*","masters.*","stock.*",
  "admin.*","order.*","promo.*","catalog.*","booking.*","waitlist.*","reviews.*",
  "blacklist.*","favorites.*","novaposhta.*","file.*","export.*","reminders.*",
  "notify.*","branches.*","sync.*","users.*","audit.read","settings.write"
]'::jsonb
WHERE code = 'admin';

-- owner: гарантируем '*' (полный доступ, включая cashbox.history и reports.finance)
UPDATE roles SET permissions = '["*"]'::jsonb WHERE code = 'owner';
