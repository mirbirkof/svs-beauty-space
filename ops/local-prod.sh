#!/bin/bash
# Локальный прод-инстанс CRM на нашем сервере (порт 3011). Идемпотентный супервизор
# для crontab (@reboot и */5): если жив — ничего не делает.
#
# РЕЖИМЫ:
#   (без аргумента)  крон/сторож: прод мёртв → холодный старт; жив → снять «немых» дублей
#   restart          ВЫКАТКА БЕЗ ПРОСТОЯ (17.09): щит → новый инстанс рядом на тот же порт
#                    (reusePort) → его здоровье на probe-порту → старый гасится мягко (drain)
#                    → новому сигнал «ты главный». Новый не поднялся = убит, СТАРЫЙ РАБОТАЕТ.
#                    Худший исход — «ничего не изменилось», а не «касса лежит».
#   force            жёсткий путь (убить → поднять → ждать 25с). Только если порт застрял
#                    или бесшовный путь невозможен. Тоже через щит.
#   SKIP_SHIELD=1    аварийный обход ворот (когда сломан сам щит, а не код).
PORT=3011
LOG=/tmp/crm-local-prod.log
APP_DIR=/home/client/workspace/svs-beauty-space/backend
SHIELD=/home/client/workspace/ops/crm-regression.sh
MODE="${1:-}"
cd "$APP_DIR" || exit 1

say() { echo "[$(date '+%F %H:%M:%S')] $*" | tee -a "$LOG"; }
notify() {
  curl -s -m 10 -X POST http://127.0.0.1:3005/notify -H "x-notify-token: jarvis-restart-2026" \
    -H "Content-Type: text/plain" --data-binary "$1" >/dev/null 2>&1
}
# инстансы приложения = node с рабочей папкой backend (QA-сторож на 3025 живёт в другой папке
# и под шаблон не попадает; тестовый сервер щита на 3037 — та же папка, но он не держит :3011)
app_pids() {
  for p in $(pgrep -f "node .*shop-api\.js"); do
    [ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "$APP_DIR" ] && echo "$p"
  done
}
listening_pids() { # кто из инстансов реально держит боевой порт
  for p in $(app_pids); do ss -ltnp 2>/dev/null | grep -q ":$PORT .*pid=$p," && echo "$p"; done
}
health() { curl -sf -m 5 "http://127.0.0.1:${1:-$PORT}/health" >/dev/null 2>&1; }

# Один запуск за раз: без блокировки крон */5 мог наплодить параллельные старты.
# Крон — неблокирующий (занято = пропустить тик), ручной restart/force — ЖДЁТ до 90с.
LOCK=/tmp/crm-local-prod.lock
exec 9>"$LOCK"
lock_held_by_server() { # замок унаследовал сам сервер (старт до фикса 9>&-) — это не конкурент
  for p in $(fuser "$LOCK" 2>/dev/null); do
    [ "$(ps -o comm= -p "$p" 2>/dev/null)" = "node" ] && return 0
  done
  return 1
}
if [ "$MODE" = "restart" ] || [ "$MODE" = "force" ]; then
  flock -w 90 9 || lock_held_by_server || { say "$MODE: lock busy 90s, abort"; exit 1; }
else
  flock -n 9 || lock_held_by_server || exit 0
fi

# ── ВОРОТА ДЕПЛОЯ (17.09, Босс: «тесты кассы и графика как ворота деплоя») ──
# Ручной restart/force = выкатка нового кода. Красный щит = код сломан = прод НЕ трогаем.
# Крон-путь ворота НЕ проходит: мёртвый прод надо поднимать, а не тестировать.
if { [ "$MODE" = "restart" ] || [ "$MODE" = "force" ]; } && [ "${SKIP_SHIELD:-0}" != "1" ] && [ -f "$SHIELD" ]; then
  say "$MODE: регресс-щит перед выкаткой…"
  if ! bash "$SHIELD" 2>&1 | tee -a "$LOG"; then
    say "$MODE ОТМЕНЁН: щит красный, прод не тронут (обход: SKIP_SHIELD=1)"
    notify "❌ <b>Выкатка CRM остановлена воротами</b>: регресс-щит красный, прод работает на старом коде. Лог: /tmp/crm-regression.log"
    exit 2
  fi
fi

# ── SECURITY-РЕВЬЮ ПЕРЕД ВЫКАТКОЙ (17.09) — общий инструмент ops/sec-review.sh ──
# Тесты отвечают «работает ли». Это отвечает «можно ли сломать»: сильная модель читает дифф кода
# с прошлой выкатки и ищет только дыры (деньги, доступ, ПД, инъекции, секреты). BLOCK → выкатка
# отменена, прод не тронут, Боссу уведомление. Без вердикта (лимит) → предупреждение, выкатка идёт
# (нельзя блокировать хотфикс из-за лимита). Обход: SKIP_SECREVIEW=1. Метка прошлой выкатки: .last-deploy-rev.
REV_FILE=/home/client/workspace/svs-beauty-space/.last-deploy-rev
REPO_DIR=/home/client/workspace/svs-beauty-space
if { [ "$MODE" = "restart" ] || [ "$MODE" = "force" ]; } && [ "${SKIP_SECREVIEW:-0}" != "1" ]; then
  # 17.09: метка выкатки — это коммит. Если код лежит незакоммиченным, следующая выкатка будет
  # сравнивать «от метки», и промежуточный шаг потеряется в истории. Поэтому фиксируем ДО ревью:
  # ревью всё равно смотрит рабочее дерево, а история остаётся полной и откатываемой.
  DIRTY_CODE=$(git -C "$REPO_DIR" status --porcelain -- backend ':(exclude)backend/data' 2>/dev/null | head -20)
  if [ -n "$DIRTY_CODE" ]; then
    say "$MODE: фиксирую незакоммиченные правки перед выкаткой ($(printf '%s\n' "$DIRTY_CODE" | wc -l) файлов)"
    git -C "$REPO_DIR" add -- backend ':(exclude)backend/data' 2>/dev/null
    git -C "$REPO_DIR" commit -q -m "[jarvis] авто-фиксация перед выкаткой $(date '+%F %H:%M')" 2>/dev/null \
      && say "$MODE: зафиксировано $(git -C "$REPO_DIR" rev-parse --short HEAD)" \
      || say "$MODE: фиксировать нечего"
  fi
  say "$MODE: security-ревью диффа с прошлой выкатки…"
  SEC_OUT=$(bash /home/client/workspace/ops/sec-review.sh /home/client/workspace/svs-beauty-space "$(cat "$REV_FILE" 2>/dev/null)" backend 2>&1); SEC_RC=$?
  printf '%s\n' "$SEC_OUT" | tail -8 | tee -a "$LOG"
  if [ "$SEC_RC" -eq 3 ]; then
    say "$MODE ОТМЕНЁН: security-ревью нашло дыру, прод не тронут"
    notify "🛑 <b>Выкатка CRM остановлена security-ревью</b>: $(printf '%s' "$SEC_OUT" | grep '^ВЕРДИКТ: BLOCK' | sed 's/^ВЕРДИКТ: BLOCK:[[:space:]]*//' | head -c 600). Прод на старом коде."
    exit 3
  elif [ "$SEC_RC" -eq 2 ]; then
    notify "⚠️ CRM: security-ревью перед выкаткой не дало вердикта (лимит/сбой) — выкатка прошла БЕЗ него."
  fi
fi

# ── КРОН-ПУТЬ: жив → только снять «немых» дублей и выйти ──
if [ "$MODE" != "restart" ] && [ "$MODE" != "force" ]; then
  if health; then
    for pid in $(app_pids); do
      ss -ltnp 2>/dev/null | grep -q "pid=$pid," && continue   # держит порт — не орфан
      # только что стартовавший ещё не слушает — не убивать (иначе крон рвёт свой же старт)
      age=$(( $(date +%s) - $(stat -c %Y /proc/$pid 2>/dev/null || echo 0) ))
      [ "$age" -lt 90 ] && continue
      kill "$pid" 2>/dev/null
      # [27.09 Jarvis] орфан 3332455 13 часов ел 80% ядра и НЕ умирал от TERM (мёртвый цикл блокирует обработчик сигнала);
      # крон 161 раз писал «killed orphan» впустую. Не умер за 5с → SIGKILL, и об этом — отдельной строкой.
      sleep 5
      if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null; say "killed -9 orphan $pid (не умер от TERM за 5с — мёртвый цикл?)"; else say "killed orphan $pid"; fi
    done
    exit 0
  fi
fi

# ── ЖЁСТКИЙ ПУТЬ: убить всё → поднять → ждать 25с (крон при мёртвом проде, force, и fallback) ──
hard_start() {
  for pid in $(app_pids); do kill "$pid" 2>/dev/null; done
  sleep 3
  for pid in $(app_pids); do kill -9 "$pid" 2>/dev/null; done
  sleep 1
  # 9>&- ОБЯЗАТЕЛЬНО (26.07): иначе сервер наследует flock и держит его вечно.
  # CRM_REUSEPORT=1 ОБЯЗАТЕЛЕН (29.07): выкатка рядом возможна только если флаг у ВСЕХ сокетов порта.
  PORT=$PORT CRM_REUSEPORT=1 setsid nohup node shop-api.js >> "$LOG" 2>&1 9>&- &
  sleep 25
  if health; then say "started ok (hard)"; rm -f /tmp/crm-start-fails; { [ "$MODE" = "restart" ] || [ "$MODE" = "force" ]; } && git -C /home/client/workspace/svs-beauty-space rev-parse HEAD > "$REV_FILE" 2>/dev/null; return 0; fi
  # 17.09: сторож (крон */5) молча крутил бы неудачный старт бесконечно. Считаем провалы подряд:
  # 3-й провал = Боссу сообщение (не чаще раза в час), чтобы он узнал от меня, а не от пустого сайта.
  FAILS=$(( $(cat /tmp/crm-start-fails 2>/dev/null || echo 0) + 1 )); echo "$FAILS" > /tmp/crm-start-fails
  say "START FAILED (подряд: $FAILS)"
  if [ "$FAILS" -ge 3 ]; then
    STAMP=/tmp/crm-start-fail-notify
    if [ ! -f "$STAMP" ] || [ $(( $(date +%s) - $(stat -c %Y "$STAMP" 2>/dev/null || echo 0) )) -gt 3600 ]; then
      touch "$STAMP"
      notify "🛑 <b>CRM не поднимается</b> — $FAILS неудачных старта подряд, сайт и касса недоступны. Последние строки лога: <code>$(tail -3 "$LOG" | tr -d '<>' | head -c 400)</code>"
    fi
  fi
  return 1
}

# ── БЕСШОВНЫЙ ПУТЬ (restart): новый рядом → доказал здоровье → старый мягко гаснет ──
zero_downtime() {
  local OLD NEW PROBE ok i still
  OLD=$(listening_pids | tr '\n' ' ')
  if [ -z "${OLD// /}" ] || ! health; then
    say "restart: прод не жив (инстансы: '${OLD}') → обычный холодный старт"
    hard_start; return $?
  fi
  # свободный probe-порт: отвечает ГАРАНТИРОВАННО новый процесс (на :$PORT слушают оба)
  PROBE=""
  for p in 3019 3020 3021 3022; do ss -ltn 2>/dev/null | grep -q ":$p " || { PROBE=$p; break; }; done
  [ -n "$PROBE" ] || { say "restart: нет свободного probe-порта → жёсткий путь"; hard_start; return $?; }

  say "restart: старые инстансы [$OLD]; поднимаю новый рядом (reusePort, задачи отложены, probe :$PROBE)"
  # DEPLOY_TEST_BREAK=1 — ТОЛЬКО для проверки самого скрипта: новый инстанс намеренно падает на старте
  local NODE_EXTRA=""
  [ "${DEPLOY_TEST_BREAK:-0}" = "1" ] && NODE_EXTRA="--require /tmp/crm-boot-fail.js"
  PORT=$PORT CRM_REUSEPORT=1 CRM_DEFER_JOBS=1 CRM_PROBE_PORT=$PROBE NODE_OPTIONS="${NODE_OPTIONS:-} $NODE_EXTRA" \
    setsid nohup node shop-api.js >> "$LOG" 2>&1 9>&- &
  NEW=$!
  ok=0
  for i in $(seq 1 40); do   # до 80с
    if ! kill -0 "$NEW" 2>/dev/null; then
      say "restart: новый инстанс УПАЛ на старте → старый [$OLD] работает дальше, код на проде не сменился"
      notify "❌ <b>Выкатка CRM не удалась</b>: новый инстанс упал на старте, старый продолжает работать (простоя не было). Лог: $LOG"
      return 3
    fi
    # ДВА условия (урок 29.07): probe отвечает даже когда основной listen упал с EADDRINUSE —
    # обязательно проверяем, что новый РЕАЛЬНО занял боевой порт
    if health "$PROBE" && ss -ltnp 2>/dev/null | grep -q ":$PORT .*pid=$NEW,"; then
      ok=1; say "restart: новый (pid $NEW) здоров и держит :$PORT (~$((i*2))с)"; break
    fi
    sleep 2
  done
  if [ "$ok" != "1" ]; then
    say "restart: новый не отдал health за 80с → убиваю его, СТАРЫЙ [$OLD] РАБОТАЕТ ДАЛЬШЕ"
    kill -9 "$NEW" 2>/dev/null
    notify "❌ <b>Выкатка CRM не удалась</b>: новый инстанс не поднялся за 80с, убит; старый работает (простоя не было). Лог: $LOG"
    return 3
  fi
  # старый гасим мягко: SIGTERM = перестать принимать, дождаться активных запросов (оплаты дойдут), выйти
  say "restart: переключаю — старым [$OLD] SIGTERM (drain)"
  for p in $OLD; do kill -TERM "$p" 2>/dev/null; done
  for i in $(seq 1 15); do
    still=""; for p in $OLD; do kill -0 "$p" 2>/dev/null && still="$still $p"; done
    [ -z "${still// /}" ] && break
    sleep 2
  done
  for p in $OLD; do kill -0 "$p" 2>/dev/null && { say "restart: старый $p не ушёл за 30с → kill -9"; kill -9 "$p" 2>/dev/null; }; done
  # прочие остатки в папке (не новый, не слушают) — снять
  for p in $(app_pids); do [ "$p" = "$NEW" ] && continue; ss -ltnp 2>/dev/null | grep -q "pid=$p," || kill "$p" 2>/dev/null; done
  kill -USR2 "$NEW" 2>/dev/null   # «ты теперь главный»: фоновые задачи включаются, probe закрывается
  sleep 3
  if health; then
    say "restart: ГОТОВО без простоя. pid $NEW. health: $(curl -s -m 5 http://127.0.0.1:$PORT/health | head -c 120)"
    git -C /home/client/workspace/svs-beauty-space rev-parse HEAD > "$REV_FILE" 2>/dev/null   # метка для следующего security-ревью
    return 0
  fi
  say "restart: ТРЕВОГА — :$PORT не отвечает после переключения → аварийный жёсткий старт"
  notify "⚠️ <b>CRM: после бесшовной выкатки порт не ответил</b> — поднимаю жёстко (простой ~30с). Лог: $LOG"
  hard_start
}

if [ "$MODE" = "restart" ]; then
  zero_downtime; rc=$?
elif [ "$MODE" = "force" ]; then
  say "force: жёсткий перезапуск"; hard_start; rc=$?
else
  say "cron: прод мёртв → холодный старт"; hard_start; rc=$?
fi
exit $rc
