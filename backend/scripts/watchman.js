/* Тестер-охранник. Гоняется по расписанию (крон, раз в час).
   Запускает смоук прода + аудит денег. МОЛЧИТ при успехе,
   шлёт Боссу в Telegram короткий алерт ТОЛЬКО когда что-то сломалось.

   Запуск вручную:  node -r dotenv/config scripts/watchman.js
   Тест алерта:     WATCH_FORCE_ALERT=1 node -r dotenv/config scripts/watchman.js */
require('dotenv').config();
const { execFile } = require('child_process');
const path = require('path');

const DIR = path.join(__dirname);
const TOKEN = process.env.TELEGRAM_NOTIFY_TOKEN || process.env.BOT_TOKEN;
const CHAT = (process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.OWNER_CHAT_ID || process.env.ADMIN_ID || '').split(',')[0].trim();

// запустить один чек-скрипт, вернуть {name, ok, tail}
function run(name, file, env = {}) {
  return new Promise((resolve) => {
    execFile('node', ['-r', 'dotenv/config', path.join(DIR, file)],
      { cwd: path.join(DIR, '..'), timeout: 90000, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        const out = (stdout || '') + (stderr || '');
        // берём только строки-провалы и итог — чтобы алерт был коротким
        const bad = out.split('\n').filter(l => /\[-\]|ИТОГ|Error|упал/.test(l)).slice(-8).join('\n');
        resolve({ name, ok: !err || err.code === 0, code: err ? err.code : 0, tail: bad || out.slice(-400) });
      });
  });
}

async function alert(text) {
  if (!TOKEN || !CHAT) { console.error('[watchman] нет TOKEN/CHAT для алерта — пропуск отправки'); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    console.error('[watchman] alert →', r.status);
  } catch (e) { console.error('[watchman] alert fail:', e.message); }
}

(async () => {
  const checks = [
    await run('Смоук прода', 'smoke.js'),
    await run('Аудит денег', 'money_audit.js'),
  ];
  const failed = checks.filter(c => !c.ok);
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);

  if (failed.length === 0 && !process.env.WATCH_FORCE_ALERT) {
    console.log(`[watchman ${stamp}] всё чисто — ${checks.map(c => c.name).join(', ')} зелёные`);
    return; // ТИШИНА = всё хорошо
  }

  const list = (failed.length ? failed : checks);
  const msg = `🚨 <b>CRM: тестер поймал проблему</b>\n${stamp} Kyiv\n\n` +
    list.map(c => `<b>${c.ok ? '🟢' : '🔴'} ${c.name}</b>\n<pre>${(c.tail || '').slice(0, 500)}</pre>`).join('\n') +
    `\n\nПроверь и/или откати последний деплой.`;
  await alert(msg);
  console.log(`[watchman ${stamp}] АЛЕРТ отправлен: ${failed.map(c => c.name).join(', ')}`);
  process.exit(1);
})();
