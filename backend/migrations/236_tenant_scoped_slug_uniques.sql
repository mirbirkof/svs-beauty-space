-- 236_tenant_scoped_slug_uniques.sql
-- ПРЕСЕЙЛ-БЛОКЕР #3: slug услуг/комбо/тегов уникальны ГЛОБАЛЬНО, а не по салону.
--
-- Проблема: services_slug_uq/service_combos_slug_uq/client_tag_defs_name_uq —
-- уникальны на всю платформу. Функция uniqueSlug() проверяет коллизию под RLS
-- (видит только СВОЙ салон) и возвращает свободный в его пределах slug, но INSERT
-- бьётся о глобальный индекс → 23505 → сырой 500. Второй салон не может создать
-- услугу с типовым названием («Стрижка», «Манікюр») — детерминированный блокер онбординга.
--
-- Решение: пересобрать уникальность с префиксом tenant_id. WHERE-условия сохранены
-- один-в-один со старыми индексами. Старые данные уникальны глобально → композитный
-- индекс строится без конфликтов. Идемпотентно.

-- services.slug → (tenant_id, slug) WHERE slug IS NOT NULL
DROP INDEX IF EXISTS services_slug_uq;
CREATE UNIQUE INDEX IF NOT EXISTS services_slug_uq
  ON public.services (tenant_id, slug) WHERE (slug IS NOT NULL);

-- service_combos.slug → (tenant_id, slug) WHERE slug IS NOT NULL
DROP INDEX IF EXISTS service_combos_slug_uq;
CREATE UNIQUE INDEX IF NOT EXISTS service_combos_slug_uq
  ON public.service_combos (tenant_id, slug) WHERE (slug IS NOT NULL);

-- client_tag_defs.lower(name) → (tenant_id, lower(name))
DROP INDEX IF EXISTS client_tag_defs_name_uq;
CREATE UNIQUE INDEX IF NOT EXISTS client_tag_defs_name_uq
  ON public.client_tag_defs (tenant_id, lower(name));
