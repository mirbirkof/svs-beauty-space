/* ops/crm-notes-watch.js — АВТОПІДХОПЛЕННЯ НОТАТОК CRM (наказ Боса 04.09.2026).
 *
 * ПРИЧИНА. Босс лишає нотатку через плаваючу кнопку в адмінці — і мусив ЩЕ РАЗ писати
 * в Telegram «виконай нотатки». Подвійна робота і затримка на години. Тепер система
 * сама бачить нову нотатку і сама ставить її в роботу.
 *
 * ЩО РОБИТЬ (крон кожні 5 хв):
 *   1. Читає crm_notes зі status='open'.
 *   2. Нові (яких немає у стейті) → повідомляє Боса «взяв у роботу» і запускає
 *      незалежного виконавця bg-task.sh (setsid — переживає будь-який обрив ходу).
 *   3. Виконавець робить правку, перевіряє її у браузері і САМ ставить нотатці
 *      status='done', а результат надсилає Босу в Telegram.
 *
 * ЗАПОБІЖНИКИ:
 *   - одна нотатка = один запуск (стейт-файл), повторів не буде;
 *   - не більше одного виконавця нотаток одночасно (щоб правки коду не перетинались);
 *   - при ПЕРШОМУ запуску наявні нотатки лише запамʼятовуються — лавини зі старих не буде.
 *
 * Запуск: cd backend && node -r dotenv/config ops/crm-notes-watch.js [--dry]
 */
'use strict';
const { Client } = require('pg');
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry');
const STATE = '/home/client/workspace/memory/.crm-notes-seen.json';
const BG = '/home/client/workspace/own-engine/bin/bg-task.sh';
const NOTIFY_TOKEN = process.env.RESTART_TOKEN || 'jarvis-restart-2026';

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE, 'utf8'))); } catch (_) { return null; }
}
function saveSeen(set) {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify([...set]));
  } catch (e) { console.error('[notes-watch] state save failed:', e.message); }
}
function notify(text) {
  if (DRY) { console.log('--- DRY notify ---\n' + text); return; }
  try {
    execSync(`curl -s -m 15 -X POST http://127.0.0.1:3005/notify -H "x-notify-token: ${NOTIFY_TOKEN}" -H "Content-Type: application/json" -d @-`,
      { input: JSON.stringify({ text }) });
  } catch (e) { console.error('[notes-watch] notify failed:', e.message); }
}
// Чи вже працює виконавець нотаток.
function workerBusy() {
  try {
    for (const d of fs.readdirSync('/tmp/jarvis-bg').filter(x => x.startsWith('note-'))) {
      const st = `/tmp/jarvis-bg/${d}/status`;
      const finished = fs.existsSync(st) && fs.readFileSync(st, 'utf8').trim() !== '';
      if (!finished) return d;
    }
  } catch (_) {}
  return null;
}

function taskText(n) {
  const markDone = `cd /home/client/workspace/svs-beauty-space/backend && node -r dotenv/config -e "const{Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});await c.connect();await c.query(\\"UPDATE crm_notes SET status='done',done_at=NOW() WHERE id=${n.id}\\");await c.end();})()"`;
  return [
    `ЗАВДАННЯ: виконати нотатку #${n.id} з CRM салону SVS Beauty.`,
    '',
    `ТЕКСТ НОТАТКИ (від ${n.created_by_name || 'користувача'}, сторінка ${n.page_path || '—'}):`,
    `«${n.body}»`,
    '',
    'КОНТЕКСТ СИСТЕМИ (перевірене, іншого не вигадувати):',
    '- Прод CRM = дроплет, node shop-api.js порт 3011, cwd /home/client/workspace/svs-beauty-space/backend.',
    '- Адмінка: backend/public/admin/index.html (один великий файл, правки точкові).',
    '- API: backend/routes/*.js. Спільна логіка: backend/lib/*.js.',
    '- Деплой бекенду: bash /home/client/workspace/svs-beauty-space/ops/local-prod.sh restart',
    '  (статика admin/index.html підхоплюється без рестарту).',
    '- Render заборонений повністю — не деплоїти і не згадувати.',
    '- Сторінки admin/index|login|reset — ЗАВЖДИ ПК-версія width=1280, ніколи device-width.',
    '- Дані НЕ видаляти. Міграції БД — тільки додавальні.',
    '- Якщо число вже рахується десь у системі (звіт у Telegram, інший розділ) — не вигадувати',
    '  другу формулу, а звести до ОДНОГО спільного джерела, інакше цифри розійдуться.',
    '',
    'ПОРЯДОК РОБОТИ:',
    '1. Знайти місце в коді і зрозуміти ПРИЧИНУ, а не симптом.',
    '2. Зробити правку. Синтаксис: node --check для routes; для admin/index.html витягти',
    '   кожен <script> і перевірити окремо.',
    '3. ОБОВʼЯЗКОВО перевірити в живому браузері:',
    '   PLAYWRIGHT_BROWSERS_PATH=/home/client/workspace/.ms-playwright node <свій тест>.mjs',
    '   вхід: localStorage svs_admin_token = ADMIN_TOKEN з backend/.env, база http://127.0.0.1:3011,',
    '   viewport 1280x900. Без цієї перевірки завдання НЕ виконане.',
    '4. git commit у /home/client/workspace/svs-beauty-space (формат: [jarvis] fix/feat(...): опис).',
    '5. Позначити нотатку виконаною:',
    `   ${markDone}`,
    '',
    'ФІНАЛЬНИЙ ТЕКСТ (його побачить Босс у Telegram):',
    'коротко — що було не так, що зроблено, що тепер видно на екрані. Без шляхів до файлів і',
    'назв функцій. Дозволені теги <b>/<i>, markdown заборонений.',
    'Якщо зробити неможливо — чесно написати чому і що потрібно від Боса.',
  ].join('\n');
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query(
    `SELECT id, body, page_path, page_label, created_by_name, created_at
       FROM crm_notes WHERE status='open' ORDER BY created_at ASC`);
  await c.end();

  let seen = loadSeen();
  const firstRun = seen === null;
  if (firstRun) seen = new Set();

  const fresh = r.rows.filter(n => !seen.has(String(n.id)));
  if (!fresh.length) { console.log('[notes-watch] нових нотаток немає'); return; }

  if (firstRun) {
    fresh.forEach(n => seen.add(String(n.id)));
    saveSeen(seen);
    console.log('[notes-watch] перший запуск: запамʼятав', fresh.length, 'нотаток без запуску');
    return;
  }

  const busy = workerBusy();
  if (busy) { console.log('[notes-watch] виконавець ще працює:', busy, '— чекаю наступного тіку'); return; }

  const n = fresh[0];                        // одна нотатка за тік
  if (!DRY) { seen.add(String(n.id)); saveSeen(seen); }   // у dry чергу не чіпаємо

  const short = String(n.body || '').replace(/\s+/g, ' ').slice(0, 220);
  notify(`📝 <b>Нова нотатка в CRM #${n.id}</b>\nвід ${n.created_by_name || '—'}\n\n«${short}»\n\nВзяв у роботу — результат надішлю сюди сам.`);

  if (DRY) { console.log('--- DRY task ---\n' + taskText(n)); return; }
  const res = spawnSync('bash', [BG, `note-${n.id}`, taskText(n), 'opus'], { encoding: 'utf8' });
  if (res.status !== 0) {
    console.error('[notes-watch] запуск виконавця не вдався:', res.status, res.stderr);
    seen.delete(String(n.id));               // повертаємо в чергу до наступного тіку
    saveSeen(seen);
  } else {
    console.log('[notes-watch] нотатку', n.id, 'передано виконавцю note-' + n.id);
  }
})().catch(e => { console.error('[notes-watch]', e.message); process.exit(1); });
