#!/bin/bash
# СТОРОЖ «CRM НЕ НА RENDER» (приказ Босса 01.08, после того как он попал на Render-двойник).
#
# ЧТО СЛУЧИЛОСЬ: при переезде 19.07 на дроплет остались (а) живой backup-сервис на
# Render и (б) хардкод onrender в клиентских страницах и в backend (ссылки в письмах,
# приглашения сотрудникам, CORS, health-пробы). Босс входил по своей ссылке и попадал
# на мёртвого/старого двойника — с риском вносить записи не в ту базу.
#
# ЧТО ДЕЛАЕТ: раз в 10 минут проверяет ТРИ вещи и при нарушении сразу пишет Боссу:
#   1) в рабочем коде и страницах нет активных onrender-адресов (комментарии игнорируем)
#   2) адреса Render НЕ отвечают (сервисы должны быть погашены)
#   3) настоящая CRM снаружи открывается и это ИМЕННО наш сервис
# Ничего не «чинит» молча — молчаливая починка и привела к тому, что двойник жил месяц.
set -u
ROOT=/home/client/workspace/svs-beauty-space
NOTIFY_URL=http://127.0.0.1:3005/notify
STATE=/tmp/guard-no-render.state

notify() {
  curl -s -m 10 -X POST "$NOTIFY_URL" \
    -H "x-notify-token: jarvis-restart-2026" -H 'Content-Type: text/plain' \
    --data "$1" >/dev/null 2>&1
}

PROBLEMS=""

# 1. Активные (не закомментированные) ссылки на Render в коде и страницах
HITS=$(grep -rIn "onrender\.com" \
        --include="*.js" --include="*.mjs" --include="*.html" --include="*.json" \
        "$ROOT" 2>/dev/null \
      | grep -v node_modules \
      | grep -vE ':[0-9]+: *(//|#|\*)' \
      | grep -vE '<!--' \
      | head -5)
if [ -n "$HITS" ]; then
  PROBLEMS="${PROBLEMS}• В коде снова появились ссылки на Render:
$(echo "$HITS" | sed "s|$ROOT/||" | cut -c1-120)
"
fi

# 2. Сервисы Render должны быть мертвы. Живой двойник = запись данных не в ту базу.
for U in https://svs-shop-api.onrender.com/health https://svs-shop-api-backup.onrender.com/health; do
  CODE=$(curl -s -m 12 -o /dev/null -w '%{http_code}' "$U" 2>/dev/null)
  if [ "$CODE" = "200" ]; then
    PROBLEMS="${PROBLEMS}• ОЖИЛ двойник на Render: $U (код 200) — погасить немедленно
"
  fi
done

# 3. Настоящая CRM снаружи жива и это наш сервис (200 недостаточно: чужой сайт тоже 200)
REAL=$(curl -s -m 15 https://zvetlacrm.serveousercontent.com/health 2>/dev/null)
if ! echo "$REAL" | grep -q "svs-shop-api"; then
  PROBLEMS="${PROBLEMS}• CRM снаружи НЕ отвечает как наша (zvetlacrm/health)
"
fi

if [ -n "$PROBLEMS" ]; then
  # Не спамим: одинаковую проблему повторяем не чаще раза в час
  SIG=$(echo "$PROBLEMS" | md5sum | cut -d' ' -f1)
  PREV=$(cut -d' ' -f1 "$STATE" 2>/dev/null || echo "")
  PREV_TS=$(cut -d' ' -f2 "$STATE" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  if [ "$SIG" != "$PREV" ] || [ $((NOW - PREV_TS)) -gt 3600 ]; then
    echo "$SIG $NOW" > "$STATE"
    notify "🔴 СТОРОЖ CRM: обнаружена проблема с Render/доступом

$PROBLEMS
Вход должен быть только: https://zvetlacrm.serveousercontent.com/admin/login.html"
  fi
  exit 1
fi

: > "$STATE"
exit 0
