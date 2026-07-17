-- 268_video_studio_price_299.sql (17.07.2026, приказ Босса)
-- Модуль «AI Відеостудія» — 299₴/міс (было 199 в мигр. 267).
UPDATE saas_addons SET price_month = 299.00, price_year = 2990.00
 WHERE feature_key = 'video_studio';
