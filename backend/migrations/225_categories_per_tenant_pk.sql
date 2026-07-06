-- 225: товарні категорії — per-tenant (SaaS-аудит 06.07).
-- Проблема: categories.PK = (id) глобальний. Новий салон під RLS бачить порожньо і НЕ може
-- вставити 'coloring' (конфлікт глобального PK з категорією салону Босса) → у нього взагалі
-- немає товарних категорій, склад і прапорець commissionable не працюють.
-- Рішення: PK = (tenant_id, id). FK products(tenant_id, category_id) → categories(tenant_id, id).

-- 1) зняти старий FK і глобальний PK
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_category_id_fkey;
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_pkey;

-- 2) складений PK per-tenant
ALTER TABLE categories ADD PRIMARY KEY (tenant_id, id);

-- 3) новий складений FK (NULL category_id не перевіряється — MATCH SIMPLE)
ALTER TABLE products ADD CONSTRAINT products_category_tenant_fkey
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories(tenant_id, id) ON DELETE SET NULL;
