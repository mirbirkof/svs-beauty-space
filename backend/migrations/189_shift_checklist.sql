-- Чек-лист зміни адміністратора (з посадової інструкції).
-- Один запис на робочий день: відкриття зміни, протягом дня, закриття + звірка каси.
-- Мета: оживити інструкцію в CRM — адмін відмічає галочки, зміна не закривається
-- доки каса не зведена (як у самій інструкції).

CREATE TABLE IF NOT EXISTS shift_checklists (
  id           SERIAL PRIMARY KEY,
  work_date    DATE        NOT NULL UNIQUE,
  admin_name   VARCHAR(120),
  items        JSONB       NOT NULL DEFAULT '[]',   -- [{key,label,phase,done,done_at}]
  cash_program NUMERIC(12,2),                       -- сума за програмою
  cash_journal NUMERIC(12,2),                       -- сума за журналом
  cash_fact    NUMERIC(12,2),                       -- реальна готівка в касі
  cash_diff    NUMERIC(12,2),                       -- розбіжність (fact - program)
  note         TEXT,
  closed_at    TIMESTAMPTZ,                         -- коли зміну закрито
  closed_by    VARCHAR(120),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shift_checklist_date ON shift_checklists (work_date DESC);
