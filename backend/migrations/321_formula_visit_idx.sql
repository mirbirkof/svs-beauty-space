-- client-visit-0411 (Босс 04.11 22:52): формули фарбування прив'язуються до візиту (деталь візиту в картці клієнта,
-- кнопка «Формула» в журналі). Лише ДОДАЄМО індекс для пошуку формул візиту; дані не змінюються.
CREATE INDEX IF NOT EXISTS ix_formulas_appt ON coloring_formulas (tenant_id, appointment_id) WHERE appointment_id IS NOT NULL;
