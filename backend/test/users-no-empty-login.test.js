// Сторож (ysk 04.11): POST /api/users без телефона/логина/пароля НЕ создаёт users-строку — только карточку мастера.
// И: пустая учётка мастера привязывается по телефону через master-link (роль master, рабочий мастер).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../routes/users.js'), 'utf8');
const link = fs.readFileSync(path.join(__dirname, '../lib/master-link.js'), 'utf8');

test('users.js: ранний выход без INSERT INTO users, когда нет phone/username/password_hash', () => {
  const g = src.indexOf('if (!phone && !username && !password_hash && master_id)');
  const ins = src.indexOf('INSERT INTO users (phone, email, display_name');
  assert.ok(g > 0 && ins > 0 && g < ins, 'guard должен стоять ДО вставки в users');
  assert.ok(/no_login: true/.test(src.slice(g, ins)), 'ответ должен помечать no_login');
  assert.ok(/COMMIT/.test(src.slice(g, ins)), 'карточка мастера фиксируется');
});

test('master-link: существующая учётка роли master без telegram привязывается (UPDATE users SET telegram_id)', () => {
  assert.ok(/UPDATE users SET telegram_id=\$1/.test(link));
  assert.ok(/if \(u && u\.code !== 'master'\)/.test(link));
});
