// Сторожа от повтора по аудиту 23.10.2026 (пункты 1, 9, 22). Ничего не меняют в базе, внешний ИИ не зовут.
//  п.1  — телефоны/email клиентов не уходят во внешний ИИ; каскад по умолчанию — только Claude.
//  п.9  — журнал действий (audit_log) не удаляется, а переносится в audit_log_archive.
//  п.22 — служебная страница audit-dash без токена закрыта.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createMasker } = require('../lib/pii-mask');

test('п.1: маскировка ловит украинские номера и email, суммы/даты не трогает, обратимо в канон 380…', () => {
  const m = createMasker();
  const src = 'Олена +380 67 123 45 67, 0671234567, (093) 555-12-34, +48 123 456 789, olena@gmail.com; сума 1500000, дата 2026-10-23, id 12345';
  const x = m.mask(src);
  assert.ok(!/123 45 67|0671234567|555-12-34|456 789|olena@/.test(x), 'в замаскированном тексте остались контакты: ' + x);
  assert.ok(x.includes('1500000') && x.includes('2026-10-23') && x.includes('12345'), 'задеты суммы/даты/id: ' + x);
  assert.strictEqual(x.match(/\[ТЕЛ_1\]/g).length, 2, 'один номер в разных форматах = одна метка');
  assert.strictEqual(m.unmask('[ТЕЛ_1] [EMAIL_1]'), '380671234567 olena@gmail.com');
});

test('п.1: llm.js — каскад по умолчанию только Claude, маскировка в ask()', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/llm.js'), 'utf8');
  const cascade = src.slice(src.indexOf('const PROVIDERS = ['), src.indexOf('];', src.indexOf('const PROVIDERS = [')));
  assert.ok(/claude/.test(cascade), 'в каскаде нет Claude');
  assert.ok(!/gemini|openrouter|groq/i.test(cascade), 'в каскаде по умолчанию снова сторонний провайдер: ' + cascade);
  assert.ok(/masker\.mask\(prompt\)/.test(src) && /masker\.unmask\(/.test(src), 'ask() больше не маскирует');
});

test('п.9: audit_log не в списке удаления, есть перенос в архив', () => {
  const { RULES, ARCHIVE_RULES } = require('../lib/retention');
  assert.ok(!RULES.some(([t]) => t === 'audit_log'), 'audit_log снова удаляется');
  assert.ok(ARCHIVE_RULES.some(([t, a]) => t === 'audit_log' && a === 'audit_log_archive'), 'нет переноса в архив');
});

test('п.22: audit-dash без токена не отдаёт страницу и данные', async () => {
  const saved = process.env.AUDIT_DASH_TOKEN; delete process.env.AUDIT_DASH_TOKEN;
  delete require.cache[require.resolve('../routes/audit-dash')];
  const express = require('express');
  const app = express(); app.use('/api/audit-dash', require('../routes/audit-dash'));
  const srv = app.listen(0); const port = srv.address().port;
  try {
    for (const p of ['/api/audit-dash/', '/api/audit-dash/data']) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.strictEqual(r.status, 404, `${p} открыт без токена (${r.status})`);
    }
  } finally { srv.close(); if (saved !== undefined) process.env.AUDIT_DASH_TOKEN = saved; }
});
