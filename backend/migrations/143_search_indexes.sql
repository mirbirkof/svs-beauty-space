-- 143: индексы под нагрузку (аудит 23.06, #8 + #11)
--
-- #8: календарь грузится запросами WHERE tenant_id=? AND starts_at BETWEEN ?..?.
--     Сейчас два раздельных индекса (tenant_id) и (starts_at) — планировщик выбирает
--     один, второй фильтр идёт по строкам. Составной (tenant_id, starts_at) даёт
--     index-range прямо по диапазону дат внутри тенанта.
--
-- #11: поиск клиентов (routes/search.js) фильтрует по:
--     • name ILIKE  → уже покрыт idx_clients_name_trgm (GIN trgm)
--     • email ILIKE → btree idx_clients_email НЕ помогает '%x%' → добавляем GIN trgm
--     • regexp_replace(phone,'\D','','g') ILIKE → функциональное выражение без индекса
--       → функциональный GIN trgm по нормализованному телефону.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- #8 составной индекс календаря
CREATE INDEX IF NOT EXISTS idx_appointments_tenant_starts
  ON appointments (tenant_id, starts_at);

-- #11 email trgm (под ILIKE-поиск)
CREATE INDEX IF NOT EXISTS idx_clients_email_trgm
  ON clients USING gin (lower(coalesce(email,'')) gin_trgm_ops);

-- #11 нормализованный телефон trgm — точно под выражение из search.js
CREATE INDEX IF NOT EXISTS idx_clients_phone_norm_trgm
  ON clients USING gin (regexp_replace(coalesce(phone,''),'\D','','g') gin_trgm_ops);
