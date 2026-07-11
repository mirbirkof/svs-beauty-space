# CRM Release Checklist — 11.07.2026

> ЧИТАТЬ ПЕРВЫМ при любой работе с готовностью CRM. НЕ переделывать закрытое.
> Основано на релизной комиссии (RELEASE-COMMISSION-2026-07-11.md). Все правки — коммиты с меткой БЛОКЕР/MAJOR (git log).

## СТАТУС: код готов к пилоту. Задеплоено на прод (push 0864814, 11.07).

---

## ✅ БЛОКЕРЫ РЕЛИЗА — 15/15 ЗАКРЫТО (НЕ ТРОГАТЬ)
| # | Что было | Фикс |
|---|---|---|
| A1 | panel-login обходил 2FA | требует код, verify-2fa выдаёт панельный токен + фронт index.html |
| A2 | Stored XSS отзывы Dikidi | esc() на имена |
| A3 | XSS bonus.html onclick | id вместо JSON.stringify |
| A4 | rate-limiter пропускал /api/admin/* | убран skip('/admin') |
| B1 | двойное бронирование (migration 239 снёс EXCLUDE) | триггер вместимости migration 241 (online_bookings) |
| B2 | кросс-канальная гонка web/bot | guarded-insert в боте (appointments) |
| C1 | DELETE Mono-операции обходил закрытую смену | системные (ext_ref) удалять нельзя |
| C2 | PATCH Mono-операции | финансовые поля системных не редактируются |
| D1 | cancel авто-ЗП не сторнировал кассу | DELETE auto_payroll в транзакции cancel |
| D2 | авто-ЗП игнорил fixed_per_day | ветка fixed_per_day × смены |
| E1 | сертификат CANCEL без FOR UPDATE | транзакция + блокировка строки |
| F1 | Viber webhook писал под дефолтным тенантом | runAs(cfg.salon_id) |
| F2 | CSV импорт обходил лимит тарифа | остаток ёмкости плана |
| G1 | согласие при регистрации не писалось | migration 242 (consent_* на tenants) |
| G2 | erasure не стирал phone_enc | + phone_enc/phone_bidx = NULL |
| G3 | erasure не чистил PII-таблицы | медтаблицы + редакт domain_events/audit_log |

## ✅ MAJOR — ЗАКРЫТО (НЕ ТРОГАТЬ)
- M1 tg-login-verify: добавлен per-account throttle OTP
- M2 кросс-тенантные кеши (slot-engine _setCache, booking-bot _catCache) → per-tenant Map
- #4 предоплата не вычиталась при /pay (двойная выручка) → вычет + prepaid_consumed_at (migration 243). ЛАТЕНТНЫЙ (0 предоплат)
- #5 P&L COGS не считал материалы визитов (reason service:%) → добавлено
- #7 пересчёт ЗП брал gross-базу → переведён на liveEstimate (net)
- #8 гонка расчёта ЗП → UNIQUE-индекс migration 244 + catch 23505
- #10 hold-период бонусов не применялся → available_at (migration 245), redeem/estimate available-aware
- #14 инвентаризация: delta_ml × цена_бутылки → wholesale/unit_ml
- #16 материалы qty_used(мл) × цена_бутылки → /unit_ml во ВСЕХ 12 местах (был активный ×100-1000 на 174 продуктах)
- #17 Viber токен-fallback → только вне прода
- #18 крон-ошибки (billing/dunning/dwh/licenses/bonus/vm) → sentry.capture
- #20 GET /clients/:id → logAction (GDPR audit trail чтения ПД)
- #21/#24/#25 устойчивость админки: api() 401→логин + защита не-JSON; дашборд Promise.allSettled
- #22 Telegram-запрос 2FA/login → timeout 8с

## ⚠️ СОЗНАТЕЛЬНО НЕ ДЕЛАНО (обоснование)
- #13 бот создаёт клиентов без max_clients — НЕ блокирую: гнать реального клиента от онлайн-записи из-за лимита = вредить салону. Лимит enforce'ится на ручном/CSV создании.

## 🔴 ОСТАЛОСЬ — ТРЕБУЕТ БОССА (НЕ КОД)
1. **#19 реквизиты в юрдокументах** (privacy/dpa/offer.html) — нужны: юрлицо/ФОП, ЄДРПОУ/ІПН, юр.адрес. Заглушки. Вписать когда Босс даст.
2. **G4 шифрование телефонов — ЗАКРЫТО РЕШЕНИЕМ (11.07): НЕ доделывать.** Инфра работает (decrypt+blind-index 8/8 на реальных данных), но plaintext phone остаётся т.к. 94 места ищут клиента по номеру — полная миграция = 2-3 дня + риск сломать поиск клиента ради GDPR-галочки, которая пилоту НЕ нужна (изоляция RLS + RBAC + erasure + audit trail уже покрывают «разумные меры»). Вернуться ТОЛЬКО если крупный клиент прямо потребует шифрование at-rest. Из юрдоговоров убрать обещание «шифруем».
3. **SENTRY_DSN + S3-ключи бэкапов** на Render (env) — код готов, нужны внешние аккаунты.

## 📋 ТЕХДОЛГ / ПРОВЕРИТЬ ПОСЛЕ ДЕПЛОЯ
- Изоляция салонов: 349/356 таблиц FORCE RLS. 6 платформенных (invoices_saas/licenses/subscriptions_saas/tenant_addon/tenant_onboarding/staff_otp) без RLS, но с app-level проверкой tenant_id. Утечки нет. Defense-in-depth: добавить signup-совместимую RLS.
- Нагрузочное тестирование гонок (B1/B2/E1/#8) под реальным потоком — не проводилось.
- Пентест (XSS/SQLi/IDOR) живой — не проводился, проверка была code-review.

## РЕГРЕССИЯ АДМИНОВ — ПРОВЕРЕНА ЧИСТОЙ
- 2FA включена у 0 юзеров → вход не изменился.
- Лимит 300/мин >> реальных 16-80/мин (даже 4 человека).
- Ручная касса (1421 операций, ext_ref NULL) правится как раньше; заблокированы 798 системных.

## ГОТОВНОСТЬ
- Продукт для своего салона: было 54% → сейчас пилот-готов.
- SaaS для продажи чужим: было 31% → блокеры сняты, изоляция подтверждена. До массовой продажи: #19 (юр) + G4 (решение) + нагрузка/пентест.
- **Вердикт: можно пилот 1-3 дружественных салона. Массовая продажа — после юр.данных + G4 + нагрузки.**

## ✅ ЗАДАЧА №1 РЕШЕНА (11.07 18:30) — триггер appt_enforce_capacity (migration 246), проверен вживую на проде
ПРОБЛЕМА: защита вместимости мастера размазана по 7 путям вставки в appointments, часть путей БЕЗ защиты:
- mobile.js POST /appointments — НУЛЕВАЯ защита (plain INSERT 'pending')
- agent-tools.js — TOCTOU (wouldExceedParallel + plain INSERT, без лока)
- кросс-табличный разрыв: booking.js считает online_bookings, admin/bot считают appointments — не видят друг друга
- посточечные advisory-локи (bot 1ba81f5, admin a4c23ed) хрупкие — уже было 2 регресса (путь модуля, несовпадение ключей)
ПРАВИЛЬНЫЙ ФИКС (делать АККУРАТНО, отдельным заходом, НЕ наспех):
- ОДИН триггер BEFORE INSERT на appointments: skip если status IN (cancelled,noshow) ИЛИ GUC app.skip_overbook='on';
  advisory_xact_lock(hashtext(master_id::text)) — тот же ключ что у app-локов; count активных перекрытий < max_parallel иначе RAISE 23P01.
- INSERT-only (НЕ UPDATE — иначе смена статуса/перенос исторических записей ложно блокируется; 233 истор. перекрытия из BP).
- Обход: admin force_parallel → SET LOCAL app.skip_overbook='on' (уже в транзакции _apptClient); BP-import (сейчас DISABLED) тоже.
- mobile.js/agent-tools.js получат 23P01 — обработать gracefully (или 500 приемлем как защита от двойной записи).
- После — убрать посточечные app-локи как избыточные ИЛИ оставить (re-entrant, безвредно).
РИСК: ошибка в фильтре статусов/обходе ломает ВСЕ записи или админ-овербукинг. Тестировать каждый шаг. Проверить раундом верификации.
