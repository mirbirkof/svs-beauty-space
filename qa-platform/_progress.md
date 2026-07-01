# QA safe-fix pipeline — прогресс

## Логика (ТЗ Босса)
Нажал «В работу» → фикс генерируется → применяется в ПЕСОЧНИЦЕ (Neon qa-sandbox + staging backend)
→ там прогоняются тесты → если чисто и нет новых багов → ТОЛЬКО ТОГДА промоушен на боевую CRM.
Никакого слепого деплоя в прод.

## Что уже есть
- [+] Neon qa-sandbox ветка (cfg.qaDbUrl) — изолированная копия БД
- [+] QA-loop 24/7 + панель на Render + синк багов в Neon
- [+] Кнопка «В работу» → флаг fix_requested в qa_bugs
- [+] Статусы бага в реестре

## Чего НЕТ (строим)
- [ ] Staging backend на песочнице (запуск shop-api.js с DATABASE_URL=qaDbUrl, отд. порт)
- [ ] Fix-worker: берёт fix_requested → генерит фикс в git worktree
- [ ] Прогон QA против staging (баг ушёл + нет регрессий)
- [ ] Промоушен: зелёно → merge main + деплой Render; красно → reopened + отчёт
- [ ] Статус-машина: fix_requested→fixing→sandbox_test→passed→promoted / failed
- [ ] Отражение стадий в панели (колонка/бейдж прогресса)

## Режим промоушена: С ПОДТВЕРЖДЕНИЕМ (вариант 2) — зелёные тесты → Боссу "деплоить? ✔"

## Этапы
1. [+] staging.js — backend на sandbox-ветке, health-check ✓ РАБОТАЕТ (порт 3025, изолирован)
     - фикс: SHOP_API_PORT приоритет над PORT — переопределён
     - guard QA_STAGING в shop-api.js глушит setInterval/setTimeout >=20с
     - telegram-токены обнулены в staging env (кроны на node-cron не шлют наружу)
     - TODO: точечный QA_STAGING-guard в cron-модулях (reminders/notif-hub/monitor) для полной чистоты
2. [ ] fix-worker.js — worktree + askClaude фикс + syntax-check  ← СЛЕДУЮЩИЙ
3. [ ] verify — QA-прогон против staging (баг ушёл + нет регрессий)
4. [ ] promote — при зелёном показать Боссу "деплоить? ✔"; при красном откат+reopened
5. [ ] панель — прогресс стадий по каждому багу в работе

## Статус: этап 1 готов, начинаю этап 2 (fix-worker)
