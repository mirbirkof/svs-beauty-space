-- ═══════════════════════════════════════════════════════
-- CRM-09 — Картка співробітника: вкладки «Онлайн-запис» + «Оповіщення»
-- Один-в-один з DIKIDI. Усі поля nullable/з дефолтами, additive.
-- ═══════════════════════════════════════════════════════

-- Онлайн-запис: чи показувати майстра клієнтам, порядок, опис
ALTER TABLE masters ADD COLUMN IF NOT EXISTS online_booking_enabled BOOLEAN DEFAULT true;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS online_rank INTEGER DEFAULT 0;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS online_title TEXT;        -- звання/підпис для клієнтів ("Топ-майстер")
ALTER TABLE masters ADD COLUMN IF NOT EXISTS online_description TEXT;  -- опис у картці онлайн-запису

-- Оповіщення: канал + про що повідомляти майстра
ALTER TABLE masters ADD COLUMN IF NOT EXISTS notify_channel TEXT DEFAULT 'telegram';  -- telegram/sms/email/none
ALTER TABLE masters ADD COLUMN IF NOT EXISTS notify_telegram TEXT;     -- @username або chat_id для сповіщень
ALTER TABLE masters ADD COLUMN IF NOT EXISTS notify_new_booking BOOLEAN DEFAULT true;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS notify_cancellation BOOLEAN DEFAULT true;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS notify_reschedule BOOLEAN DEFAULT true;
