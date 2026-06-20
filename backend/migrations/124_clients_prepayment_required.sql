-- 124: індивідуальна вимога передоплати для клієнта.
-- false (за замовч.) = передоплата не потрібна. true = бот вимагає 100% передоплату
-- за запис (для «ризикових» клієнтів, що можуть не прийти). Керується в картці клієнта.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS prepayment_required BOOLEAN DEFAULT FALSE;
