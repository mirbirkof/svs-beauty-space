#!/bin/bash
# ЕДИНЫЙ хозяин публичного адреса CRM. Крон */3.
#
# Зачем: 11.08.2026 serveo (постоянный домен) лёг, CRM ушла на запасной localhost.run,
# который РОТИРУЕТ адрес при каждом переподключении. Каждая смена ломала: закладки Босса,
# вебхук бота записи, ссылки в письмах, redirect оплаты. Раньше это чинилось руками.
#
# Теперь один сторож: выбирает ЛУЧШИЙ живой канал по приоритету, кладёт его в
# tunnel/current-url.txt (оттуда код строит ВСЕ ссылки), и при смене сам переставляет
# вебхук Telegram вместе с секретом. Никаких ручных правок .env и перезапусков.
#
# Приоритет (от лучшего к худшему):
#   1. Tailscale Funnel  — постоянное имя + настоящий сертификат, не зависит от чужих сервисов
#   2. serveo            — постоянный домен из закладок Босса (когда сервис живой)
#   3. localhost.run     — аварийный, адрес ротируется
set -u
exec 9>/tmp/public-url-watch.lock
flock -n 9 || exit 0

ROOT=/home/client/workspace/svs-beauty-space
STATE="$ROOT/tunnel/current-url.txt"
ENVF="$ROOT/backend/.env"
TS_URL="https://zvetlacrm.tailed6c1a.ts.net"

notify(){ curl -s -m 10 -X POST http://127.0.0.1:3005/notify -H "x-restart-token: x" -H "x-notify-token: jarvis-restart-2026" --data "$1" >/dev/null 2>&1; }
# Живой = на том конце ИМЕННО наша CRM (чужой сайт тоже отдаёт 200).
#
# ВАЖНО (поймано 11.08): локальный резолвер сервера закэшировал NXDOMAIN на свежее имя
# ts.net (оно появилось в мировом DNS позже). Из-за этого сторож считал ПОСТОЯННЫЙ адрес
# мёртвым и сваливался на аварийный туннель, который ротируется. Поэтому для ts.net-имён
# адрес берём из публичного DNS и подставляем через --resolve, минуя местный кэш.
# ВАЖНО-2 (поймано 11.08, вторая итерация): у ts.net-имени НЕСКОЛЬКО входных узлов
# (round-robin, 3 адреса). Сторож брал head -1 — и если моргнул именно тот узел, весь
# постоянный адрес объявлялся мёртвым, Босса уводило на ротирующийся запасной, летело
# уведомление. Ложная тревога на ровном месте. Теперь: перебираем ВСЕ узлы + 3 попытки
# с паузой. Мёртвым считаем, только если не ответил НИ ОДИН узел за все попытки.
# Последний рабочий IP кэшируем: если публичный DNS не ответил, берём его, а не сдаёмся.
TS_IP_CACHE=/tmp/ts-net-last-ip
alive(){
  local url="${1:-}"; [ -z "$url" ] && return 1
  local host="${url#https://}"; host="${host%%/*}"
  case "$host" in
    *.ts.net)
      local ips try ip
      ips=$(dig +short +time=3 +tries=1 A "$host" @8.8.8.8 2>/dev/null | grep -E '^[0-9.]+$')
      [ -z "$ips" ] && ips=$(dig +short +time=3 +tries=1 A "$host" @1.1.1.1 2>/dev/null | grep -E '^[0-9.]+$')
      [ -z "$ips" ] && ips=$(cat "$TS_IP_CACHE" 2>/dev/null)
      [ -z "$ips" ] && return 1
      for try in 1 2 3; do
        for ip in $ips; do
          if curl -s -m 10 --resolve "$host:443:$ip" "$url/health" 2>/dev/null | grep -q "svs-shop-api"; then
            echo "$ips" > "$TS_IP_CACHE"; return 0
          fi
        done
        [ "$try" -lt 3 ] && sleep 4
      done
      return 1
      ;;
    *)
      local try
      for try in 1 2; do
        curl -s -m 10 "$url/health" 2>/dev/null | grep -q "svs-shop-api" && return 0
        [ "$try" -lt 2 ] && sleep 3
      done
      return 1
      ;;
  esac
}

PICK=""
for CAND in "$TS_URL" "$(cat /tmp/serveo-current-url.txt 2>/dev/null)" "$(cat /tmp/lhr-crm-url.txt 2>/dev/null)"; do
  if alive "$CAND"; then PICK="$CAND"; break; fi
done
# Аудит 13.08: раніше тут був мовчазний `exit 1` — CRM недоступна ЗЗОВНІ ЦІЛКОМ
# (жоден канал не живий), а Бос про це не дізнавався. Тепер попереджаємо, але не
# частіше разу на годину, щоб не спамити кожні 3 хвилини.
if [ -z "$PICK" ]; then
  DOWNMARK=/tmp/public-url-all-down.stamp
  LAST=$(stat -c %Y "$DOWNMARK" 2>/dev/null || echo 0)
  NOWS=$(date +%s)
  if [ $((NOWS - LAST)) -gt 3600 ]; then
    touch "$DOWNMARK"
    notify "🔴 CRM недоступна ЗЗОВНІ: жоден публічний канал не відповідає (tailscale/serveo/lhr). Всередині сервера працює, але клієнти й бот запису зайти не можуть."
  fi
  exit 1
fi
rm -f /tmp/public-url-all-down.stamp

CUR=$(cat "$STATE" 2>/dev/null || true)

mkdir -p "$ROOT/tunnel"
[ "$PICK" != "$CUR" ] && echo "$PICK" > "$STATE"

# Вебхук бота записи проверяем КАЖДЫЙ раз, а не только при смене адреса.
# Причина (поймано 11.08): адрес в файле уже обновился другим скриптом, сторож решил
# «изменений нет» и пропустил вебхук — бот записи молча остался на мёртвом адресе.
# Секрет обязателен: без него API отдаёт 403 на каждый апдейт.
TOKEN=$(grep -h "^BOOKING_BOT_TOKEN=\|^SVS_BEAUTY_BOT_TOKEN=\|^TELEGRAM_BOT_TOKEN=" "$ENVF" 2>/dev/null | head -1 | cut -d= -f2-)
SECRET=$(grep -h "^TG_WEBHOOK_SECRET=" "$ENVF" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'\r')
WANT="$PICK/api/booking/telegram"
if [ -n "$TOKEN" ]; then
  HAVE=$(curl -s -m 15 "https://api.telegram.org/bot$TOKEN/getWebhookInfo" 2>/dev/null | grep -oE '"url":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ "$HAVE" != "$WANT" ]; then
    # Аудит 13.08: раніше відповідь Telegram не перевірялась і в лог писалось
    # «вебхук переставлен» НЕЗАЛЕЖНО від результату. Якщо API відмовляв (битий secret,
    # невалідний URL) — бот запису лишався мертвим, а лог казав, що все добре.
    RESP=$(curl -s -m 15 "https://api.telegram.org/bot$TOKEN/setWebhook" \
      -d "url=$WANT" -d "secret_token=$SECRET" 2>/dev/null)
    if echo "$RESP" | grep -q '"ok":true'; then
      echo "[$(date '+%F %H:%M')] вебхук переставлено: $HAVE -> $WANT"
    else
      echo "[$(date '+%F %H:%M')] ПОМИЛКА setWebhook: $RESP"
      notify "🔴 Бот запису: не вдалося переставити вебхук на $WANT. Відповідь Telegram: $(echo "$RESP" | head -c 300)"
    fi
  fi
fi

[ "$PICK" = "$CUR" ] && exit 0

# Уведомления: Боссу нужен ОДИН постоянный адрес, ротации запасных каналов — не его забота
# (прямое указание 11.08: «почему ты мне спамишь за запасной вход»). Поэтому:
#   • переключение НА постоянный адрес — молча (это норма, а не событие);
#   • упали С постоянного на запасной — ОДНО предупреждение (файл-маркер), дальше тишина;
#   • ротации запасного — всегда молча, вебхук и ссылки переставляются сами.
# Порог зрелости (11.08, после жалобы «надо что-то более стабильное»): короткое моргание
# канала — не событие для человека. Предупреждаем, только если постоянный адрес лежит
# 3 цикла крона подряд (~10 минут). Всё, что короче, — чинится само и молча.
MARK=/tmp/public-url-degraded          # факт отправленного предупреждения
CNT=/tmp/public-url-degraded-count     # сколько циклов подряд мы не на постоянном
case "$PICK" in
  *ts.net*)
    rm -f "$CNT"
    if [ -f "$MARK" ]; then
      rm -f "$MARK"
      notify "CRM знову на постійній адресі. Нічого міняти не треба."
    fi
    ;;
  *)
    n=$(( $(cat "$CNT" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$CNT"
    if [ "$n" -ge 3 ] && [ ! -f "$MARK" ]; then
      touch "$MARK"
      notify "⚠️ Постійна адреса CRM недоступна вже 10 хвилин — працює резервний канал, усе переключено автоматично. Закладку не міняй."
    fi
    ;;
esac
