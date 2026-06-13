-- 025_align_role_permissions.sql
-- Фикс C1 (RBAC-гэп): права, которые требуют роуты (admin.*, order.*, promo.*, users.*,
-- sync.*, file.*, branches.*, catalog.*, waitlist.*, reviews.*, blacklist.*, novaposhta.*,
-- reminders.*, notify.*, export.*, booking.*, audit.read), не выдавались НИ ОДНОЙ роли,
-- кроме owner. В итоге admin/manager/reception были бесполезны и все работали под
-- единым ADMIN_TOKEN (owner), что ломало разграничение и аудит.
--
-- Здесь приводим permissions ролей к реальным строкам прав из роутов.
-- owner ('*') не трогаем. Раскладка — предложение, согласуй при необходимости.

-- АДМІН: полный операционный контроль (всё, кроме чистого владения)
UPDATE roles SET permissions = '[
  "crm.*","shop.*","cashbox.*","reports.*","clients.*","masters.*","stock.*",
  "admin.*","order.*","promo.*","catalog.*","booking.*","waitlist.*","reviews.*",
  "blacklist.*","favorites.*","novaposhta.*","file.*","export.*","reminders.*",
  "notify.*","branches.*","sync.*","users.*","audit.read"
]'::jsonb
WHERE code = 'admin';

-- МЕНЕДЖЕР: магазин, заказы, каталог, промо, клиенты, склад, записи — без управления юзерами/филиалами/синком/аудитом
UPDATE roles SET permissions = '[
  "shop.read","shop.write","cashbox.read","cashbox.write","clients.*","reports.read",
  "stock.read","stock.write","order.*","catalog.*","promo.*","waitlist.*","reviews.write",
  "blacklist.read","booking.read","favorites.read","export.read","novaposhta.write"
]'::jsonb
WHERE code = 'manager';

-- РЕЦЕПШЕН: записи, лист ожидания, клиенты, приём оплаты, просмотр магазина
UPDATE roles SET permissions = '[
  "bookings.*","clients.*","cashbox.in","shop.read","booking.read",
  "waitlist.*","reviews.write","favorites.read"
]'::jsonb
WHERE code = 'reception';

-- МАЙСТЕР: свои записи + просмотр расписания
UPDATE roles SET permissions = '[
  "bookings.own","clients.read","cashbox.read.own","reports.own","booking.read"
]'::jsonb
WHERE code = 'master';

-- READONLY: всё на чтение (*.read уже покрывает все GET-роуты) — оставляем как есть.
