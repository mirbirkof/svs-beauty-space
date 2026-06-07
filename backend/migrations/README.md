# SVS Beauty World — PostgreSQL setup

## 1. Создать Neon проект

1. https://console.neon.tech/signup → Continue with GitHub
2. Project name: `svs-beauty`, region **EU Central (Frankfurt)**, Postgres 16
3. Скопировать **Connection string** из Dashboard

## 2. Сохранить строку подключения

```bash
# В backend/.env
DATABASE_URL=postgresql://user:pass@ep-xxx.eu-central-1.aws.neon.tech/svs_beauty?sslmode=require
```

## 3. Применить миграции

```bash
cd backend
DATABASE_URL=... node scripts/apply-migrations.js
```

Создаст 15 таблиц: clients, masters, services, appointments, brands,
categories, products, product_variants, orders, order_items, payments,
loyalty_ledger, stock_movements, sms_codes, sessions.

## 4. Импортировать каталог (267 товаров)

```bash
DATABASE_URL=... node scripts/import-products.js
```

Источник: `js/shop-data.js` (Raywell, Envie, Extremo, Invidia).
Бренды/категории/товары/варианты заливаются с upsert — можно запускать повторно.

## 5. Проверить API

```bash
# После рестарта backend:
curl http://localhost:3001/api/catalog/health
# → {"ok":true,"products":267}

curl http://localhost:3001/api/catalog/brands
curl "http://localhost:3001/api/catalog/products?brand=raywell&limit=5"
curl http://localhost:3001/api/catalog/products/rw-welcome-kit-eterna
```

## Архитектура (текущая)

- **SQLite (`db.js`)** — auth, sessions, sms-codes, старые orders. Оставлен
  ради совместимости с уже работающими роутами.
- **Postgres (`db-pg.js`)** — новый каталог, расширенная схема CRM (clients,
  masters, services, appointments), новые orders с payments и loyalty.

Постепенно мигрируем auth и orders на Postgres, когда схема стабилизируется.

## Добавление новых миграций

Файл `migrations/NNN_name.sql` (с возрастающим номером).
Запуск идемпотентный — отслеживается в служебной таблице `_migrations`.
