#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   SVS Beauty World — Проверка целостности ПОСЛЕ переезда на новый сервер/базу.
   Отвечает на один вопрос: «Ничего не потерялось?»

   Запуск (на НОВОМ сервере, с его окружением):
     node -r dotenv/config scripts/verify-migration.js
   Сравнение со старым (записать эталон ДО переезда):
     node -r dotenv/config scripts/verify-migration.js --save baseline.json   # на старом
     node -r dotenv/config scripts/verify-migration.js --compare baseline.json # на новом

   Проверяет:
   1. Ключи шифрования на месте (иначе данные не расшифровать).
   2. БД доступна, число применённых миграций.
   3. Счётчики строк ключевых таблиц.
   4. Тест-расшифровка телефона клиента (PII_KEY реально подходит к данным).
   5. Папка файлов существует и файлы на месте.
   Код возврата: 0 — всё ок; 1 — есть потери/расхождения.
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const pii = require('../lib/pii-crypto');

const COUNT_TABLES = [
  'clients', 'appointments', 'appointment_materials', 'products',
  'services', 'users', 'orders', 'payments', 'loyalty_ledger', 'files',
];
const CRITICAL_ENV = ['DATABASE_URL', 'PII_KEY', 'INTEGRATION_ENC_KEY', 'JWT_SECRET'];

const args = process.argv.slice(2);
function argVal(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

function fmt(ok, label, detail) {
  return `${ok ? '[+]' : '[-]'} ${label}${detail ? ' — ' + detail : ''}`;
}

(async () => {
  const report = { ts: new Date().toISOString(), env: {}, migrations: null, counts: {}, pii: null, uploads: null };
  const problems = [];
  const lines = [];

  // 1. Критичные env-переменные
  for (const k of CRITICAL_ENV) {
    const present = !!process.env[k];
    report.env[k] = present;
    lines.push(fmt(present, `env ${k}`, present ? 'задан' : 'ОТСУТСТВУЕТ'));
    if (!present) problems.push(`env ${k} не задан`);
  }

  const url = process.env.DATABASE_URL || process.env.DATABASE_URL_APP;
  if (!url) {
    lines.push(fmt(false, 'DB', 'нет строки подключения — дальше проверять нечего'));
    finish(report, lines, ['нет DATABASE_URL']);
    return;
  }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  try {
    // 2. Миграции
    try {
      const m = await pool.query('SELECT COUNT(*)::int AS n FROM _migrations');
      report.migrations = m.rows[0].n;
      lines.push(fmt(true, 'миграции применены', String(m.rows[0].n)));
    } catch (e) {
      report.migrations = 0;
      lines.push(fmt(false, 'миграции', 'таблица _migrations недоступна — схема не накатана'));
      problems.push('_migrations недоступна');
    }

    // 3. Счётчики строк
    for (const t of COUNT_TABLES) {
      try {
        const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
        report.counts[t] = r.rows[0].n;
        lines.push(fmt(true, `таблица ${t}`, `${r.rows[0].n} строк`));
      } catch {
        report.counts[t] = null;
        lines.push(fmt(false, `таблица ${t}`, 'нет / недоступна'));
      }
    }

    // 4. Тест-расшифровка телефона (PII_KEY подходит к реальным данным)
    if (pii.available()) {
      try {
        const r = await pool.query(
          `SELECT phone_enc FROM clients WHERE phone_enc IS NOT NULL AND phone_enc <> '' LIMIT 1`);
        if (!r.rows[0]) {
          report.pii = 'no-encrypted-rows';
          lines.push(fmt(true, 'PII расшифровка', 'зашифрованных телефонов пока нет (ок)'));
        } else {
          const dec = pii.decrypt(r.rows[0].phone_enc);
          const ok = dec != null && dec !== '';
          report.pii = ok ? 'ok' : 'FAIL';
          lines.push(fmt(ok, 'PII расшифровка', ok ? 'ключ подходит к данным' : 'КЛЮЧ НЕ ПОДХОДИТ — телефоны не читаются'));
          if (!ok) problems.push('PII_KEY не расшифровывает существующие данные — НЕВЕРНЫЙ ключ');
        }
      } catch (e) {
        report.pii = 'error';
        lines.push(fmt(false, 'PII расшифровка', e.message));
      }
    } else {
      report.pii = 'no-key';
      lines.push(fmt(false, 'PII расшифровка', 'PII_KEY не задан — телефоны в открытом виде или не читаются'));
    }
  } finally {
    await pool.end();
  }

  // 5. Файлы (uploads)
  const uploadRoot = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
  try {
    let count = 0;
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else count++;
      }
    })(uploadRoot);
    report.uploads = { dir: uploadRoot, files: count };
    lines.push(fmt(true, 'файлы (uploads)', `${count} шт в ${uploadRoot}`));
    if (report.counts.files > 0 && count === 0) {
      lines.push(fmt(false, 'файлы vs БД', `в БД ${report.counts.files} записей files, а на диске 0 — файлы потеряны`));
      problems.push('записи files есть, а файлов на диске нет (диск не перенесён)');
    }
  } catch (e) {
    report.uploads = { dir: uploadRoot, error: e.message };
    lines.push(fmt(false, 'файлы (uploads)', `папка недоступна: ${uploadRoot}`));
  }

  // Сравнение с эталоном
  const compareFile = argVal('--compare');
  if (compareFile && fs.existsSync(compareFile)) {
    const base = JSON.parse(fs.readFileSync(compareFile, 'utf8'));
    lines.push('', '── Сравнение со старым сервером ──');
    if (base.migrations !== report.migrations)
      problems.push(`миграций было ${base.migrations}, стало ${report.migrations}`);
    for (const t of COUNT_TABLES) {
      const was = base.counts?.[t], now = report.counts?.[t];
      if (was == null) continue;
      const ok = now != null && now >= was;
      lines.push(fmt(ok, `${t}`, `было ${was} → стало ${now}`));
      if (!ok) problems.push(`${t}: было ${was}, стало ${now} (пропажа строк)`);
    }
  }

  finish(report, lines, problems);
})().catch(e => { console.error('fatal:', e.message); process.exit(1); });

function finish(report, lines, problems) {
  const saveFile = argVal('--save');
  if (saveFile) {
    fs.writeFileSync(saveFile, JSON.stringify(report, null, 2));
    lines.push('', `эталон сохранён → ${saveFile}`);
  }
  console.log('\n═══ Проверка целостности после переезда ═══\n');
  console.log(lines.join('\n'));
  console.log('\n' + '─'.repeat(45));
  if (problems.length) {
    console.log(`\n❌ НАЙДЕНЫ ПРОБЛЕМЫ (${problems.length}):`);
    problems.forEach(p => console.log('   • ' + p));
    process.exit(1);
  }
  console.log('\n✅ Всё на месте — потерь не обнаружено.');
  process.exit(0);
}
