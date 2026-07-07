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

## БЛОК 3: Двойное бронирование
- [ ] 3.1 DB-констрейнт appt_no_overlap на проде + атомарная вставка

## БЛОК 4: Self-service биллинг
- [ ] 4.1 Вебхуки шлюзов (заглушки)
- [ ] 4.2 Авто-charge с сохранённой карты
- [ ] 4.3 Единые планы (saas_plans vs saas_plans_v2)

## БЛОК 5: Склад
- [ ] 5.1 consumables.js ReferenceError applyTenant (не импортирован)

## БЛОК 6: Фронт
- [ ] 6.1 js/auth.js localhost → prod URL
- [ ] 6.2 viewport 1280 в admin/master.html, qa.html
- [ ] 6.3 UI онбординга + self-service signup

## БЛОК 7: Прод-хардненинг
- [ ] 7.1 SENTRY_DSN
- [ ] 7.2 CVE-патчи (multer, form-data, opentelemetry)
- [ ] 7.3 rate-limit на логин
- [ ] 7.4 S3-бэкапы

Текущая оценка: ~59% (закрыт 1 из ~20 фиксов, но блок изоляции — тяжёлый).
