#!/bin/bash
# 17.09: бесшовная выкатка переехала в сам супервизор — `local-prod.sh restart` (щит → новый
# рядом → старый мягко). Этот файл оставлен как совместимая обёртка.
exec bash /home/client/workspace/svs-beauty-space/ops/local-prod.sh restart
