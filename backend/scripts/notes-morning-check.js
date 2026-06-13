#!/usr/bin/env node
// Утренний автоконтроль заметок CRM (запускается из crontab в 4:00).
// Читает открытые crm_notes и шлёт Боссу сводку в Telegram (бот Jarvis).
// DB — из backend/.env (DATABASE_URL). Токен/чат — из own-engine/.env (BOT_TOKEN, ADMIN_ID).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function loadEnvFile(p) {
  const out = {};
  try {
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}

async function sendTelegram(token, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(12000),
  });
  return r.json();
}

(async () => {
  const jarvisEnv = loadEnvFile(path.join(process.env.HOME || '/home/client', 'workspace/own-engine/.env'));
  const token = jarvisEnv.BOT_TOKEN || process.env.BOT_TOKEN;
  const chatId = (jarvisEnv.ADMIN_ID || process.env.ADMIN_ID || '').split(',')[0].trim();
  if (!token || !chatId) { console.error('[notes-check] no token/chatId'); process.exit(1); }

  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  let rows;
  try {
    const r = await c.query(
      `SELECT id, body, page_label, created_by_name, created_at
         FROM crm_notes WHERE status='open' ORDER BY created_at ASC`
    );
    rows = r.rows;
  } finally { await c.end(); }

  if (!rows.length) {
    console.log('[notes-check] no open notes — silent');
    return; // тихо, не спамим Босса когда всё чисто
  }

  const fmtDate = (d) => new Date(d).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
  const list = rows.map((n, i) => {
    const who = n.created_by_name ? ` · ${n.created_by_name}` : '';
    const where = n.page_label ? ` <i>(${n.page_label})</i>` : '';
    const body = (n.body || '').slice(0, 300);
    return `${i + 1}. <b>${body}</b>${where}\n   <i>${fmtDate(n.created_at)}${who}</i>`;
  }).join('\n\n');

  const text =
    `🔔 <b>Автоконтроль заміток CRM (04:00)</b>\n` +
    `Відкритих заміток: <b>${rows.length}</b>\n\n${list}\n\n` +
    `Перевір що з цим зробити. Закриті позначаю status=done.`;

  const res = await sendTelegram(token, chatId, text);
  console.log('[notes-check] sent:', res.ok === true, 'notes:', rows.length);
})().catch((e) => { console.error('[notes-check] error:', e.message); process.exit(1); });
