#!/bin/bash
# Сторож ПОСТОЯННОГО адреса CRM (Tailscale Funnel). Крон */2.
#
# Зачем (11.08.2026, после «надо что-то более стабильное»): постоянный адрес держится
# на процессе tailscaled + включённой публикации (funnel). Раньше его поднимал только
# @reboot — то есть смерть процесса означала мёртвый постоянный адрес до перезагрузки
# сервера, а Босса всё это время держал ротирующийся запасной канал.
#
# Теперь: каждые 2 минуты проверяем три уровня и чиним молча.
#   1. процесс tailscaled жив?          → нет: поднять (setsid, переживает смерть родителя)
#   2. узел авторизован (Running)?      → нет: залогиниться ключом из state (без ключа — лог)
#   3. публикация включена и смотрит в CRM? → нет: включить funnel на 3011
#
# Молча = без уведомлений Боссу. Человеку сообщает только public-url-watch.sh и только
# если постоянный адрес реально лежит 10+ минут.
set -u
exec 9>/tmp/ts-funnel-guard.lock
flock -n 9 || exit 0

TS_DIR=/home/client/opt/tailscale
SOCK=$TS_DIR/ts.sock
TS="$TS_DIR/tailscale --socket=$SOCK"
PORT=3011
LOG=/tmp/ts-funnel-guard.log
say(){ echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# 1. Процесс
if ! pgrep -f "tailscaled --tun=userspace-networking --statedir=$TS_DIR/state" >/dev/null; then
  say "tailscaled мёртв → поднимаю"
  cd "$TS_DIR" || exit 1
  setsid nohup ./tailscaled --tun=userspace-networking --statedir="$TS_DIR/state" \
    --socket="$SOCK" >> /tmp/tailscaled.log 2>&1 &
  sleep 8
fi

# 2. Авторизация узла (state на диске, ключ не нужен при живом state)
# ВНИМАНИЕ: в JSON после двоеточия ЕСТЬ пробел — без него regex не матчился и сторож
# считал живой узел мёртвым (поймано сразу на первом же запуске, 11.08).
# И никаких --reset: он стирает настройки узла. Чиним мягко — up без флагов.
state(){ $TS status --json 2>/dev/null | grep -oE '"BackendState":[ ]*"[^"]*"' | head -1 | cut -d'"' -f4; }
ST=$(state)
if [ "$ST" != "Running" ]; then
  say "состояние узла: ${ST:-нет ответа} → пробую поднять"
  $TS up >/dev/null 2>&1
  sleep 6
  ST=$(state)
  [ "$ST" != "Running" ] && say "узел не поднялся (${ST:-нет ответа}) — нужен повторный вход в Tailscale"
fi

# 3. Публикация наружу
if ! $TS funnel status 2>/dev/null | grep -q "127.0.0.1:$PORT"; then
  say "funnel не смотрит в CRM → включаю на $PORT"
  $TS funnel --bg "$PORT" >/dev/null 2>&1 || $TS funnel "$PORT" >/dev/null 2>&1 &
  sleep 5
fi

# Ротация лога, чтобы не рос вечно
[ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 200000 ] && tail -300 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit 0
