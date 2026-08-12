-- 032: алиасы стара CRM-профилей мастера.
-- В стара CRM один реальный человек может иметь несколько профилей-сотрудников
-- (например, смена фамилии: "Перукар Світлана" → "Скібенко Світлана").
-- Эта таблица сводит несколько BP-GUID к одной карточке мастера, чтобы
-- записи из любого профиля линковались к одному мастеру в нашей CRM.
CREATE TABLE IF NOT EXISTS master_bp_aliases (
  legacy_ref TEXT PRIMARY KEY,
  master_id    INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_master_bp_aliases_master ON master_bp_aliases (master_id);
