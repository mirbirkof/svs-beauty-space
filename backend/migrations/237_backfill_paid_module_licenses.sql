-- 237_backfill_paid_module_licenses.sql
-- ПРЕСЕЙЛ-БЛОКЕР #4 (бэкфилл): салоны, которые уже оплатили подписку до фикса, имеют
-- в `licenses` устаревшую trial-строку online_booking (или expired) — рантайм-проверка
-- isLicensed() отдаёт им 403 после истечения триала. Конвертируем такие строки в
-- subscription с датой конца текущего периода подписки.
--
-- Безопасно: НЕ трогаем салоны, у которых уже есть здоровая subscription-лицензия модуля
-- (в т.ч. бессрочная expires_at IS NULL — платформенный/компенсированный доступ), чтобы
-- не укоротить срок. Затрагиваются только trial/expired/отсутствующие строки.

INSERT INTO licenses (tenant_id, module_id, license_type, status, activated_at, expires_at, renewed_at)
SELECT tl.tenant_id, m.id, 'subscription', 'active', NOW(), s.current_period_end, NOW()
  FROM tenant_licenses tl
  JOIN saas_plans p     ON p.code = tl.plan_code
  JOIN module_catalog m ON (p.features ? m.code OR p.features ? '*')
  LEFT JOIN subscriptions_saas s ON s.tenant_id = tl.tenant_id
 WHERE tl.status = 'active'
   AND NOT EXISTS (
     SELECT 1 FROM licenses l2
      WHERE l2.tenant_id = tl.tenant_id AND l2.module_id = m.id
        AND l2.status IN ('active','grace_period')
        AND l2.license_type = 'subscription'
        AND (l2.expires_at IS NULL OR l2.expires_at > NOW())
   )
ON CONFLICT (tenant_id, module_id) WHERE status IN ('active','grace_period')
DO UPDATE SET license_type='subscription', status='active',
  expires_at = EXCLUDED.expires_at, renewed_at = NOW(), updated_at = NOW();
