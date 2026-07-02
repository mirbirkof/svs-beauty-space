-- ═══════════════════════════════════════════════════════════════════
-- 198_money_idempotency.sql — Денежный контур: идемпотентность + канон телефонов
-- (аудит 02.07.2026: гонка двойной оплаты в /pay, повторные начисления бонусов,
--  регресс формата телефонов в waitlist)
-- ═══════════════════════════════════════════════════════════════════

-- 1) Одна ручная оплата на запись журнала: partial UNIQUE на cash_operations.
--    Закрывает гонку SELECT-then-INSERT в POST /api/schedule/appointments/:id/pay
--    (routes/schedule.js): два параллельных запроса больше не создадут два прихода.
--    Код делает INSERT ... ON CONFLICT DO NOTHING и отвечает already_paid.
--    Проверено на проде 02.07.2026: дублей (tenant_id, ref_id) при type='in'
--    AND ref_type='appointment' НЕТ — индекс встаёт чисто, без WHERE-костылей.
CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_ops_appt_payment
  ON cash_operations (tenant_id, ref_type, ref_id)
  WHERE type = 'in' AND ref_type = 'appointment';

-- 2) Идемпотентность начислений бонусов (lib/bonus.js accrue): одно начисление
--    типа 'accrual' на (клиент, источник). client_id в ключе обязателен:
--    для birthday source_id = год и он общий для всех клиентов tenant'а.
--    Ручные начисления (source_id IS NULL) и списания под индекс не попадают.
--    Проверено на проде 02.07.2026: дублей нет.
CREATE UNIQUE INDEX IF NOT EXISTS ux_bonus_tx_accrual_source
  ON bonus_transactions (tenant_id, client_id, source_type, source_id)
  WHERE source_id IS NOT NULL AND type = 'accrual';

-- 3) Канон телефона в БД = '380XXXXXXXXX' БЕЗ ведущего '+' (lib/phone.js, аудит #31).
--    routes/waitlist.js писал '+380...' — приводим существующие строки к канону;
--    код переведён на normalizePhoneDb этим же релизом, поэтому равенство
--    client_phone = $1 в /mine и /booking/history снова находит все строки.
UPDATE waitlist
   SET client_phone = substring(client_phone FROM 2)
 WHERE client_phone LIKE '+380%' AND length(client_phone) = 13;
