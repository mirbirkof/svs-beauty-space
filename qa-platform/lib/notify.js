/* Уведомления о найденных багах → Telegram (Jarvis боту, Боссу).
   Замыкает петлю «нашёл → сообщил инженеру»: критичные (critical/high) летят СРАЗУ,
   medium/low копятся и уходят дайджестом не чаще раза в DIGEST_INTERVAL_H часов.
   Дедуп по сигнатуре: один и тот же баг не шлётся повторно. Best-effort — никогда
   не роняет цикл QA (все ошибки глушатся). */
const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const TOKEN = process.env.QA_BOT_TOKEN || process.env.BOT_TOKEN || '';
const CHAT = (process.env.ADMIN_ID || '').split(',')[0].trim();
const DIGEST_INTERVAL_H = Number(process.env.QA_DIGEST_H || 6);
const STATE_FILE = path.join(cfg.dataDir, 'notified.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return { sent: {}, lastDigestAt: 0 }; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (_) {}
}

async function tg(text) {
  if (!TOKEN || !CHAT) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    return r.ok;
  } catch (_) { return false; }
}

const SEV_ICON = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' };
const line = (b) => `${SEV_ICON[b.severity] || '·'} <b>${b.module}</b>/${b.role || 'system'}: ${b.title}${b.actual ? ` — <i>${String(b.actual).slice(0, 120)}</i>` : ''}`;

// Вызывается после цикла. bugs = массив НОВЫХ реальных багов (не needsManual).
async function notifyNewBugs(bugs) {
  if (!TOKEN || !CHAT || !Array.isArray(bugs) || !bugs.length) return { sent: 0 };
  const st = loadState();
  const now = Date.now();
  let sent = 0;

  // 1) Критичные — сразу и поштучно (если ещё не слали эту сигнатуру)
  const urgent = bugs.filter((b) => (b.severity === 'critical' || b.severity === 'high') && !st.sent[b.signature]);
  for (const b of urgent) {
    const ok = await tg(`🚨 <b>QA нашёл ${b.severity === 'critical' ? 'КРИТИЧНЫЙ' : 'важный'} баг</b>\n\n${line(b)}${b.cause ? `\n\nПричина: ${String(b.cause).slice(0, 200)}` : ''}\n\nБерусь в работу.`);
    if (ok) { st.sent[b.signature] = now; sent++; }
  }

  // 2) medium/low — дайджестом не чаще раза в N часов
  const minor = bugs.filter((b) => b.severity !== 'critical' && b.severity !== 'high' && !st.sent[b.signature]);
  const digestDue = now - (st.lastDigestAt || 0) > DIGEST_INTERVAL_H * 3600 * 1000;
  if (minor.length && digestDue) {
    const ok = await tg(`📋 <b>QA-дайджест — новые баги (${minor.length})</b>\n\n${minor.slice(0, 20).map(line).join('\n')}${minor.length > 20 ? `\n\n…и ещё ${minor.length - 20}` : ''}`);
    if (ok) { minor.forEach((b) => { st.sent[b.signature] = now; }); st.lastDigestAt = now; sent += minor.length; }
  }

  saveState(st);
  return { sent };
}

module.exports = { notifyNewBugs };
