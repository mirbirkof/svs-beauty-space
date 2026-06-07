# Shop-API Tunnel

Тимчасовий публічний URL для backend, поки нема постійного домену (Railway/Render).

## Поточний URL
Дивись `current-url.txt`

## Старт
```bash
ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=60 -R 80:localhost:3011 nokey@localhost.run
```
Або у фоні:
```bash
(nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=60 -R 80:localhost:3011 nokey@localhost.run > shop-tunnel.log 2>&1 & disown)
sleep 8
grep -oE "https://[a-z0-9]+\.lhr\.life" shop-tunnel.log | head -1
```

## Перевірка
```bash
curl -s https://XXXXX.lhr.life/api/shop/readiness
```

## Важливо
- При перезапуску URL змінюється — треба оновити `current-url.txt` і пушнути в репозиторій вітрини
- lhr.life показує interstitial першому браузеру без cookies — потрібно "Continue" один раз
- Cloudflare tunnels в Україні не працюють без VPN — використовуємо localhost.run
- Коли отримаємо постійний хостинг (Railway / Render / VPS) — туннель не потрібен
