-- 117: manual_override для appointments.
-- Якщо адмін вручну переніс запис (час / майстер / тривалість) у нашій CRM —
-- автосинхронізація BeautyPro не повинна перетирати ці поля назад кожні 5 хв.
-- Прапорець ставиться у PATCH /appointments/:id, поважається у syncAppointments().

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS manual_override boolean NOT NULL DEFAULT false;
