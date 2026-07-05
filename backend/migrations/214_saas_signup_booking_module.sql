-- 214: SaaS этап 2 — онлайн-запись как продаваемый модуль.
-- Модуль в каталоге лицензий: при публичной регистрации салона выдаётся
-- trial-лицензия, дальше — подписка. Гейт проверяется в booking-роутах.
INSERT INTO module_catalog (code, name, description, category, trial_days, price_monthly_uah, price_yearly_uah, status, sort_order)
SELECT 'online_booking',
       'Онлайн-запис + Telegram-бот',
       'Запис клієнтів через сайт і власного Telegram-бота салону: вільні слоти, підтвердження номером, нагадування 24г/2г, передоплата.',
       'booking', 14, 0, 0, 'available', 5
WHERE NOT EXISTS (SELECT 1 FROM module_catalog WHERE code = 'online_booking');
