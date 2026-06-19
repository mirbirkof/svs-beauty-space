-- 120: эталонные показатели карточки клиента (из выгрузки BeautyPro/букона по телефону)
-- total_visits  — количество визитов (история до выгрузки 24.05.2026 + живые после)
-- first_visit_at — дата первого визита (заменяет ввод "Зареєстр." = дата импорта)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS total_visits integer DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS first_visit_at date;
