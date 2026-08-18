#!/usr/bin/env node
/**
 * benford-audit.cjs — еженедельный Бенфорд-аудит кассы салона (18.08, «Давай» Босса).
 *
 * ЧТО ПРОВЕРЯЕТ. Первые цифры СВОБОДНЫХ сумм кассы против закона Бенфорда.
 * Свободные = расходы (type=out) и возвраты: их суммы не диктуются прайсом, поэтому
 * должны ложиться в логарифмическое распределение. Выдуманные человеком цифры — не лягут.
 * Приходы по прайсу (750/800/850...) НЕ проверяем: доказано 18.08, что прайс ломает
 * Бенфорда естественным образом (топ-12 сумм = 55% операций) — сигнал был бы ложным.
 *
 * ЧЕСТНЫЕ ПРЕДЕЛЫ. Хи-квадрат на n<80 — шум, не сигнал: молчим и копим данные.
 * Отклонение = ПОВОД ПОСМОТРЕТЬ ГЛАЗАМИ, не приговор. В сообщении всегда конкретные
 * операции-выбросы, чтобы Босс проверял факт, а не абстрактную статистику.
 *
 * Запуск: node ops/benford-audit.cjs [--notify]   (cwd = backend, нужен .env)
 * Крон: понедельник 08:40. Лог: ~/workspace/memory/benford-audit.log
 */
const { Client } = require('pg');
const fs = require('fs');

const LOG = '/home/client/workspace/memory/benford-audit.log';
const NOTIFY = process.argv.includes('--notify');
const MIN_N = 80;              // ниже — статистика недостоверна, молчим
const CHI_ALERT = 20.1;        // p<0.01 при 8 степенях свободы

const benford = (d) => Math.log10(1 + 1 / d);

function analyze(rows) {
  const counts = Object.fromEntries([...Array(9)].map((_, i) => [i + 1, 0]));
  let n = 0;
  for (const r of rows) {
    const first = String(r.amount).replace(/[^1-9]/g, '')[0];
    if (!first) continue;
    counts[first]++; n++;
  }
  let chi = 0;
  const table = [];
  for (let d = 1; d <= 9; d++) {
    const exp = benford(d) * n;
    chi += exp > 0 ? Math.pow(counts[d] - exp, 2) / exp : 0;
    table.push({ d, obs: counts[d], obsPct: n ? (counts[d] / n * 100) : 0, expPct: benford(d) * 100 });
  }
  return { n, chi, table };
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // свободные суммы: все расходы + возвраты. Окно 180 дней, чтобы старое не маскировало свежее.
  const rows = (await c.query(
    `SELECT id, amount, category, description, created_at FROM cash_operations
     WHERE type='out' AND created_at > NOW() - INTERVAL '180 days'`)).rows;

  const { n, chi, table } = analyze(rows);
  const stamp = new Date().toISOString();

  let verdict, detail = '';
  if (n < MIN_N) {
    verdict = `данных мало (n=${n} < ${MIN_N}) — копим, сигнал недостоверен`;
  } else if (chi <= CHI_ALERT) {
    verdict = `чисто: хи-квадрат ${chi.toFixed(1)} ≤ ${CHI_ALERT} (n=${n})`;
  } else {
    verdict = `ОТКЛОНЕНИЕ: хи-квадрат ${chi.toFixed(1)} > ${CHI_ALERT} (n=${n})`;
    // цифры-выбросы: наблюдение выше ожидания в 2+ раза при 5+ случаях
    const bad = table.filter((t) => t.obs >= 5 && t.obsPct > 2 * t.expPct).map((t) => t.d);
    // конкретные свежие операции на этих цифрах — чтобы смотреть глазами факт
    const suspects = rows
      .filter((r) => bad.includes(Number(String(r.amount).replace(/[^1-9]/g, '')[0])))
      .sort((a, b) => b.created_at - a.created_at).slice(0, 6)
      .map((r) => `  #${r.id} ${r.amount}грн ${r.category || ''} ${String(r.description || '').slice(0, 40)} (${r.created_at.toISOString().slice(0, 10)})`);
    detail = `\nПерекошенные первые цифры: ${bad.join(', ') || '—'}\nСвежие операции на них (проверить глазами):\n${suspects.join('\n')}`;
  }

  fs.appendFileSync(LOG, `[${stamp}] ${verdict}\n`);
  console.log(verdict + detail);

  if (NOTIFY && n >= MIN_N && chi > CHI_ALERT) {
    const body = `🔍 Бенфорд-аудит кассы: расходы/возвраты за 180 дней легли НЕ по закону.\n${verdict}${detail}\n\nЭто не приговор, а повод глянуть перечисленные операции. Прайсовые приходы не проверялись (там перекос естественный).`;
    const { execSync } = require('child_process');
    try {
      execSync(`curl -s -m 15 -X POST http://127.0.0.1:3005/notify -H "x-notify-token: ${process.env.RESTART_TOKEN || 'jarvis-restart-2026'}" -H 'Content-Type: text/plain' --data-binary @-`, { input: body });
    } catch {}
  }
  await c.end();
})().catch((e) => { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ОШИБКА: ${e.message}\n`); console.error('ERR', e.message); process.exit(1); });
