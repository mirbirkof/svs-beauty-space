#!/bin/bash
# ДЕПЛОЙ CRM БЕЗ ПРОСТОЯ (задача #6, приём подсмотрен у Coolify)
#
# ЗАЧЕМ: старый путь `local-prod.sh restart` = убить → поднять → ждать 25с.
# Касса недоступна ~28 секунд при каждой правке. Хуже: если новый код сломан,
# CRM не поднимается вообще, а крон каждые 5 минут запускает то же сломанное.
#
# КАК ЗДЕСЬ: новый процесс поднимается РЯДОМ на тот же порт (reusePort ядра),
# доказывает здоровье на отдельном диагностическом порту, и только после этого
# старый гасится мягко (graceful drain — активные оплаты успевают дойти).
# Новый получает SIGUSR2 = «ты теперь главный» и включает фоновые задачи.
# Если новый не поднялся или болен — он убивается, СТАРЫЙ ПРОДОЛЖАЕТ РАБОТАТЬ.
# Худший исход этого скрипта — «ничего не изменилось», а не «прод лежит».
#
# Использование: bash ops/deploy-zero.sh
set -u

PORT=3011
PROBE_PORT=3019
APP_DIR=/home/client/workspace/svs-beauty-space/backend
LOG=/tmp/crm-local-prod.log
DLOG=/tmp/crm-deploy-zero.log
HEALTH_TRIES=40          # 40 × 2с = до 80с на подъём нового
cd "$APP_DIR" || exit 1

say() { echo "[$(date '+%F %H:%M:%S')] $*" | tee -a "$DLOG"; }

# Замок общий с супервизором: иначе крон */5 может влезть в середину выкатки
LOCK=/tmp/crm-local-prod.lock
exec 9>"$LOCK"
flock -w 120 9 || { say "деплой: замок занят 120с, отмена"; exit 1; }

old_pids() {
  for p in $(pgrep -x -f "node shop-api.js"); do
    [ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "$APP_DIR" ] && echo "$p"
  done
}

OLD=$(old_pids | tr '\n' ' ')
say "деплой стартовал. Работающие инстансы: ${OLD:-нет}"

# Нет старого — обычный холодный старт, изощряться незачем
if [ -z "${OLD// /}" ]; then
  say "прод не запущен → обычный старт"
  exec 9>&-
  exec bash /home/client/workspace/svs-beauty-space/ops/local-prod.sh restart
fi

# ── 1. Поднимаем новый рядом ────────────────────────────────────────────────
say "поднимаю новый инстанс рядом (reusePort, фоновые задачи отложены)"
PORT=$PORT CRM_REUSEPORT=1 CRM_DEFER_JOBS=1 CRM_PROBE_PORT=$PROBE_PORT \
  setsid nohup node shop-api.js >> "$LOG" 2>&1 9>&- &
NEW=$!
sleep 2

# ── 2. Ждём, пока новый докажет здоровье НА СВОЁМ порту ─────────────────────
ok=0
for i in $(seq 1 $HEALTH_TRIES); do
  if ! kill -0 "$NEW" 2>/dev/null; then
    say "новый инстанс упал на старте (см. $LOG) → старый остаётся работать"
    exec 9>&-; exit 1
  fi
  # ДВА условия, и второе критично (урок 29.07): probe-порт отвечает даже когда
  # основной listen упал с EADDRINUSE. Я принял здоровье probe за успех, погасил
  # старый — и остался без сервиса на основном порту. Теперь обязательно проверяем,
  # что новый процесс РЕАЛЬНО занял боевой порт.
  if curl -sf -m 3 "http://127.0.0.1:$PROBE_PORT/health" >/dev/null 2>&1 \
     && ss -ltnp 2>/dev/null | grep -q ":$PORT .*pid=$NEW,"; then
    ok=1; say "новый здоров И держит боевой порт (попытка $i, ~$((i*2))с)"; break
  fi
  sleep 2
done

if [ "$ok" != "1" ]; then
  say "новый не отдал health за $((HEALTH_TRIES*2))с → убиваю его, СТАРЫЙ РАБОТАЕТ ДАЛЬШЕ"
  kill -9 "$NEW" 2>/dev/null
  exec 9>&-; exit 1
fi

# ── 3. Гасим старый мягко: он дренирует активные запросы сам (SIGTERM) ──────
say "переключаю: гашу старый ($OLD) мягко"
for p in $OLD; do kill -TERM "$p" 2>/dev/null; done

# ждём реальной смерти, не «на глазок»
for i in $(seq 1 15); do
  still=""
  for p in $OLD; do kill -0 "$p" 2>/dev/null && still="$still $p"; done
  [ -z "${still// /}" ] && break
  sleep 2
done
for p in $OLD; do kill -0 "$p" 2>/dev/null && { say "старый $p не ушёл за 30с → жёстко"; kill -9 "$p" 2>/dev/null; }; done

# ── 4. Новый становится главным: включает фоновые задачи ────────────────────
kill -USR2 "$NEW" 2>/dev/null
say "новый получил сигнал «ты главный» (pid $NEW)"

# ── 5. Контроль по основному порту — теперь отвечает только новый ───────────
sleep 3
if curl -sf -m 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  rev=$(curl -s -m 5 "http://127.0.0.1:$PORT/health" | head -c 200)
  say "ГОТОВО, простоя не было. health: $rev"
  exec 9>&-; exit 0
else
  say "ТРЕВОГА: основной порт не отвечает после переключения → аварийный обычный старт"
  exec 9>&-
  exec bash /home/client/workspace/svs-beauty-space/ops/local-prod.sh restart
fi
