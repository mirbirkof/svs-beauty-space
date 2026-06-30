// Тесты RBAC — сеть безопасности для прав доступа.
// Чистые функции, без БД. Запуск: npm test
const { test } = require('node:test');
const assert = require('node:assert');
const { hasPermission } = require('../lib/rbac');

test('owner с "*" имеет любое право', () => {
  assert.strictEqual(hasPermission(['*'], 'reports.finance'), true);
  assert.strictEqual(hasPermission(['*'], 'payroll.write'), true);
});

test('точное совпадение права', () => {
  assert.strictEqual(hasPermission(['cashbox.read'], 'cashbox.read'), true);
  assert.strictEqual(hasPermission(['cashbox.read'], 'cashbox.write'), false);
});

test('wildcard области: "clients.*" покрывает clients.read', () => {
  assert.strictEqual(hasPermission(['clients.*'], 'clients.read'), true);
  assert.strictEqual(hasPermission(['clients.*'], 'clients.write'), true);
  assert.strictEqual(hasPermission(['clients.*'], 'reports.finance'), false);
});

test('suffix wildcard: "*.read" покрывает любой .read', () => {
  assert.strictEqual(hasPermission(['*.read'], 'reports.read'), true);
  assert.strictEqual(hasPermission(['*.read'], 'reports.finance'), false);
});

test('пустые/нет прав → нет доступа', () => {
  assert.strictEqual(hasPermission([], 'cashbox.read'), false);
  assert.strictEqual(hasPermission(null, 'cashbox.read'), false);
  assert.strictEqual(hasPermission(undefined, 'cashbox.read'), false);
});

// КРИТИЧНО: admin (admin.*) НЕ должен иметь финансы/зарплаты напрямую —
// именно это требовал владелец (админ не видит финотчёт).
test('admin.* НЕ даёт reports.finance / payroll.write', () => {
  const adminPerms = ['crm.*', 'shop.*', 'cashbox.read', 'cashbox.write', 'clients.*', 'admin.*'];
  assert.strictEqual(hasPermission(adminPerms, 'reports.finance'), false, 'admin не должен видеть финотчёт');
  assert.strictEqual(hasPermission(adminPerms, 'payroll.write'), false, 'admin не должен трогать зарплаты');
  assert.strictEqual(hasPermission(adminPerms, 'cashbox.read'), true, 'но кассу дня — может');
  assert.strictEqual(hasPermission(adminPerms, 'clients.read'), true, 'и контакты клиентов — может');
});

// КРИТИЧНО: мастер с урезанными правами не лезет в чужое.
test('master без clients.read не получает контакты', () => {
  const masterPerms = ['schedule.read', 'cashbox.read.own', 'reports.own', 'bookings.own', 'booking.read'];
  assert.strictEqual(hasPermission(masterPerms, 'clients.read'), false);
  assert.strictEqual(hasPermission(masterPerms, 'reports.finance'), false);
  assert.strictEqual(hasPermission(masterPerms, 'cashbox.read'), false, 'cashbox.read.own ≠ cashbox.read');
});

// Защита от вертикальной эскалации (owner-only логика для управления ролями).
test('owner-only guard: только owner проходит', () => {
  const ownerOnly = (u) => (u.role === 'owner' || (u.role_level || 0) >= 100);
  assert.strictEqual(ownerOnly({ role: 'owner', role_level: 100 }), true);
  assert.strictEqual(ownerOnly({ role: 'admin', role_level: 80 }), false);
  assert.strictEqual(ownerOnly({ role: 'manager', role_level: 60 }), false);
  assert.strictEqual(ownerOnly({ role: 'owner', role_level: 999 }), true, 'legacy owner-token');
});
