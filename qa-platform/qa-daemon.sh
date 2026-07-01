#!/bin/bash
# Сторож QA-loop: замена системного cron (он недоступен без прав на spool).
# Каждые 30с проверяет, жив ли ИМЕННО node-процесс run.js --loop, и поднимает если нет.
# Считает через ps+awk по comm==node, чтобы не спутать с bash-сторожами/эхом (их comm != node).
# Запуск: setsid bash qa-daemon.sh >/dev/null 2>&1 </dev/null & disown
while true; do
  c=$(ps -eo comm,args | awk '$1=="node" && /run\.js --loop/{n++} END{print n+0}')
  if [ "${c:-0}" -eq 0 ]; then
    cd "$HOME/workspace/svs-beauty-space/qa-platform" && bash keepalive.sh >>/tmp/qa-platform.log 2>&1
    echo "[qa-daemon $(date '+%F %T')] loop был мёртв → поднял" >> /tmp/qa-daemon.log
  fi
  sleep 30
done
