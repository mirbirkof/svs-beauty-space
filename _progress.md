# Предпродажная доводка svs-beauty-space до 100%

Старт: 57% готовности к продаже как SaaS. Цель — 100%.

## БЛОК 1: Изоляция тенантов (самый критичный, ~25% оставшейся работы)
- [x] 1.1 stock_import_docs — tenant_id + RLS (миграция 226) ✓ чужой=0, свой=4
- [x] 1.2 DWH 12 таблиц — tenant_id + RLS (миграция 227) ✓ чужой=0, свой=5221
- [x] БОНУС: подтверждено что базовый механизм RLS РАБОТАЕТ в проде (DATABASE_URL_APP=app_tenant, fail-closed) — снят страх аудита про BYPASSRLS
- [x] 1.3 ЛОЖНАЯ ТРЕВОГА: promos/promotions (клиентские) уже изолированы. promo_codes_saas — глобальные коды платформы на подписку (корректно, saas.write)
- [x] 1.4 Mono-вебхук — обработка в runAs(tenant платежа) (payments-mono.js) ✓ синтаксис OK, self-wrapping контекст
- [x] 1.5 plans.js + feature-flags.js req.tenant_id (был camelCase req.tenantId → null) ✓ + нашёл тот же баг в feature-flags
- [ ] 1.6 boot-time guard: CI-проверка новых таблиц (превентивно, НЕ блокер — данные уже изолированы)

## БЛОК 1 ЗАКРЫТ: изоляция тенантов
Реальные утечки устранены (226, 227, Mono runAs, plans/feature-flags). 3 ложные тревоги сняты (.env, promo_codes, BYPASSRLS). Механизм подтверждён рабочим в проде.

## БЛОК 2: Деньги
- [x] 2.1 Сертификат double-spend (schedule.js оплата визита) ✓ атомарный UPDATE + откат при гонке + 409 клиенту. /use уже был защищён, др. пути не списывают
- [x] 2.2 Двойной расход ЗП — full вычитает транши + partial блокируется на paid (обе стороны) ✓
- [x] 2.3 Частичная выплата ЗП без смены — пишется в кассу с shift_id NULL ✓

## БЛОК 2 ЗАКРЫТ: деньги (сертификат + ЗП)

## БЛОК 3 ЗАКРЫТ: двойное бронирование
- [x] 3.1 EXCLUDE-констрейнт ob_no_overlap_confirmed на online_bookings (миграция 228) ✓ протестирован: 2-я пересекающаяся отклонена 23P01. + обработка в booking.js (клиент видит "слот занят")
- [x] Разобрано: appointments EXCLUDE не ставим (233 историч. пересечения из BP-импорта, будущих 0). Онлайн-канал (главный вектор параллельных клиентов) защищён на уровне БД. Админ-путь schedule.js имеет проверку slot-busy в коде (один оператор, низкий параллелизм).

## БЛОК 4 РАЗОБРАН: self-service биллинг
- [x] 4.0 РЕАЛЬНЫЙ ФИКС: продление подписки Mono/manual — dunning-цикл при продлении + notifyOwnerPayLink (отправка pay-link владельцу в Telegram). Было: счёт в вакууме, notification_sent без отправки. Теперь: продление→счёт→напоминание с ссылкой→оплата→или suspend.
- [~] 4.1 Вебхуки Stripe/LiqPay — заглушки, НО опциональны (для UA не нужны). Mono вебхук работает отдельным путём (payInvoiceViaMono). Не блокер.
- [~] 4.2 Авто-charge с карты — ограничение Mono API (нет tokenized recurring в pay-link). Модель pay-link-per-период рабочая. Не баг, особенность шлюза.
- [x] 4.3 Рассинхрон планов — ЛОЖНАЯ ТРЕВОГА: обработан маппингом LEGACY_SLUG (solo→free, pro→professional) в feature-gate/plan-limits/plans.js. Консолидация набора планов = продуктовое решение Босса, не техбаг.

## Админ-бронирование ДОЗАКРЫТО: атомарный INSERT...WHERE NOT EXISTS (schedule.js) — двойной клик оператора не создаст дубль. Задеплоено e754d06 live.

## ═══ ВСЕ 7 БЛОКОВ ПРОЙДЕНЫ ═══

## БЛОК 5 ЗАКРЫТ: склад
- [x] 5.1 routes/consumables.js применял applyTenant без импорта → ReferenceError. Добавлен импорт ✓ (lib/consumables.js был OK — агент указал не тот файл, но баг реальный в routes/)

## БЛОК 6 РАЗОБРАН: фронт (в основном ложные тревоги)
- [x] 6.1 js/auth.js localhost→prod (гигиена) — НО файл legacy/мёртвый: account.html его не грузит, эндпоинты /auth/sms/* не существуют. Реальный вход через cabinet.js (уже prod). Не был блокером.
- [x] 6.2 viewport — ЛОЖНАЯ ТРЕВОГА: admin index/login/reset уже width=1280 (правило Босса соблюдено). master.html/cabinet.html = «Кабінет майстра», мобильный by design (мастер с телефона). Не трогаем.
- [x] 6.3 signup.html ЕСТЬ и работает (location.origin + /api/public/signup, прод 400=жив). Онбординг ЕСТЬ (loadOnboarding + onboarding.js 6 роутов). ЛОЖНАЯ ТРЕВОГА.

## БЛОК 7 РАЗОБРАН: прод-хардненинг (код готов, остаток = ops Босса)
- [x] 7.3 rate-limit на логин — УЖЕ ЕСТЬ: ip-лимит + failed_login_attempts + lock + 429 на login/verify-2fa/panel-login/tg-login. Не через express-middleware, а свой механизм attempts. Функционально закрыто.
- [x] 7.1 Sentry — КОД ГОТОВ (sentry.capture в unhandledRejection/uncaughtException). Защита от падения сервера ЕСТЬ. Нужен только env SENTRY_DSN на Render → OPS БОССА.
- [~] 7.2 CVE (form-data/multer/xlsx high) — "No fix available", --force сломает загрузки (multer 2.x breaking). Вектор — только авторизованный админ, не публичный. ТЕХДОЛГ, не блокер. НЕ ломаю рабочее.
- [~] 7.4 S3-бэкапы — код backup-core есть, нужны S3-креды env на Render → OPS БОССА.

## OPS-ДЕЙСТВИЯ ДЛЯ БОССА (env на Render, я не имею доступа):
1. SENTRY_DSN=<dsn> — включит мониторинг ошибок
2. S3-креды (S3_BUCKET/KEY/SECRET) — включит выгрузку бэкапов в облако

Текущая оценка: ~59% (закрыт 1 из ~20 фиксов, но блок изоляции — тяжёлый).
