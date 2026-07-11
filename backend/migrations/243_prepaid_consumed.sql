-- Major #4: передоплата (online_bookings.prepaid_amount, вже в касі як 'prepayment')
-- при закритті візиту /pay не віднімалась → каса рахувала гроші двічі (передоплата + повна оплата).
-- Маркер споживання, щоб при оплаті відняти передоплату один раз і не задвоїти.
ALTER TABLE online_bookings ADD COLUMN IF NOT EXISTS prepaid_consumed_at timestamptz;
