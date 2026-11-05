#!/bin/bash
# [05.11 Босс] «посилання має відкривати сторінку запису в мініапці, а не чат бота».
# Пряме відкриття мініапки (t.me/<bot>?startapp) працює лише коли в @BotFather увімкнено «головну мініапку» (getMe.has_main_web_app).
# Раз на 10 хв питаємо Telegram і пишемо public/booking-link.json — його читають /p/book.html і меню CRM. Без рестарту сервера.
cd /home/client/workspace/svs-beauty-space/backend || exit 1
T=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2-)
J=$(curl -s -m 10 "https://api.telegram.org/bot$T/getMe")
node -e '
const fs=require("fs");let r;try{r=JSON.parse(process.argv[1]).result}catch{process.exit(0)} if(!r||!r.username)process.exit(0);
const main=!!r.has_main_web_app, url=main?`https://t.me/${r.username}?startapp=book`:`https://t.me/${r.username}?start=book`;
const f="public/booking-link.json"; let old=""; try{old=fs.readFileSync(f,"utf8")}catch{}
const nw=JSON.stringify({url,main}); if(old.trim()!==nw){fs.writeFileSync(f,nw+"\n"); console.log(new Date().toISOString(),"booking-link →",url);}' "$J"
