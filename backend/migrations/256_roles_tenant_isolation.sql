-- 256: возврат roles под tenant-изоляцию (аудит v6, пентест critical #1).
-- История: 141 сделала roles ГЛОБАЛЬНЫМ каталогом (USING(true)/CHECK(true)), т.к. тогда
-- роли жили только в дефолтном тенанте и вход нового салона ломался (0 строк в JOIN).
-- Но позже tenant-mgmt.createTenant стал засевать КАЖДОМУ салону свои 9 ролей (tenant_id +
-- ON CONFLICT(tenant_id,code)). Теперь глобальная политика — дыра: owner салона B через
-- PATCH/DELETE /roles/:id видит и правит роли салона A (эскалация прав + порча каталога).
-- Возвращаем tenant_isolation: с GUC сессии салона — только свои роли; без GUC (платформа
-- под ADMIN_TOKEN / крон runAs(null)) COALESCE даёт tenant_id=tenant_id → видно всё (fail-open).
BEGIN;

-- страховка: у каждого живого салона должны быть свои роли (иначе вход сломается).
-- Backfill из дефолтного каталога для тех, у кого ролей нет.
INSERT INTO roles (tenant_id, code, name, level, permissions)
SELECT t.id, r.code, r.name, r.level, r.permissions
  FROM tenants t
  CROSS JOIN (SELECT DISTINCT ON (code) code, name, level, permissions
                FROM roles ORDER BY code, tenant_id) r
 WHERE t.status <> 'purged'
   AND NOT EXISTS (SELECT 1 FROM roles r2 WHERE r2.tenant_id = t.id AND r2.code = r.code);

-- убираем глобальную политику, возвращаем изоляцию (идентичную ensure-rls)
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS roles_global_catalog ON public.roles;
DROP POLICY IF EXISTS tenant_isolation ON public.roles;
CREATE POLICY tenant_isolation ON public.roles
  USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id));

COMMIT;
