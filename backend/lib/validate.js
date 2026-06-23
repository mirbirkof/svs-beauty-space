'use strict';
/**
 * lib/validate.js — лёгкий zero-dependency валидатор входа.
 * Цель (аудит #9): отбивать мусор/инъекции на границах ДО бизнес-логики,
 * не добавляя тяжёлой зависимости (zod) на прод.
 *
 * Поверх уже существующих ручных проверок — не заменяет их, а отсекает
 * заведомо невалидные тела с понятной 400-ошибкой.
 *
 * Использование:
 *   const { validateBody, t } = require('../lib/validate');
 *   router.post('/login', validateBody({
 *     identifier: t.string({ min: 1, max: 200, required: true }),
 *     password:   t.string({ min: 1, max: 200, required: true }),
 *     remember_me: t.bool({ required: false }),
 *   }), handler);
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// телефон: цифры, +, пробелы, скобки, дефисы; 7..20 символов
const PHONE_RE = /^[+\d][\d\s()\-]{6,19}$/;

function fail(msg) { return { ok: false, msg }; }
function pass(value) { return { ok: true, value }; }

const t = {
  string(opts = {}) {
    const { min = 0, max = 100000, required = true, trim = true, pattern = null, enum: en = null } = opts;
    return (raw, key) => {
      if (raw === undefined || raw === null || raw === '') {
        if (required) return fail(`${key} обязательно`);
        return pass(raw === '' ? '' : undefined);
      }
      if (typeof raw !== 'string') return fail(`${key} должно быть строкой`);
      let v = trim ? raw.trim() : raw;
      if (v.length < min) return fail(`${key}: минимум ${min} символов`);
      if (v.length > max) return fail(`${key}: максимум ${max} символов`);
      if (pattern && !pattern.test(v)) return fail(`${key}: неверный формат`);
      if (en && !en.includes(v)) return fail(`${key}: недопустимое значение`);
      return pass(v);
    };
  },
  email(opts = {}) {
    const { required = true, max = 254 } = opts;
    return (raw, key) => {
      if (raw === undefined || raw === null || raw === '') {
        if (required) return fail(`${key} обязательно`);
        return pass(undefined);
      }
      if (typeof raw !== 'string') return fail(`${key} должно быть строкой`);
      const v = raw.trim().toLowerCase();
      if (v.length > max) return fail(`${key}: слишком длинный`);
      if (!EMAIL_RE.test(v)) return fail(`${key}: неверный email`);
      return pass(v);
    };
  },
  phone(opts = {}) {
    const { required = true } = opts;
    return (raw, key) => {
      if (raw === undefined || raw === null || raw === '') {
        if (required) return fail(`${key} обязательно`);
        return pass(undefined);
      }
      const v = String(raw).trim();
      if (!PHONE_RE.test(v)) return fail(`${key}: неверный телефон`);
      return pass(v);
    };
  },
  number(opts = {}) {
    const { min = -Infinity, max = Infinity, required = true, int = false } = opts;
    return (raw, key) => {
      if (raw === undefined || raw === null || raw === '') {
        if (required) return fail(`${key} обязательно`);
        return pass(undefined);
      }
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return fail(`${key}: должно быть числом`);
      if (int && !Number.isInteger(n)) return fail(`${key}: должно быть целым`);
      if (n < min) return fail(`${key}: минимум ${min}`);
      if (n > max) return fail(`${key}: максимум ${max}`);
      return pass(n);
    };
  },
  bool(opts = {}) {
    const { required = false } = opts;
    return (raw, key) => {
      if (raw === undefined || raw === null) {
        if (required) return fail(`${key} обязательно`);
        return pass(undefined);
      }
      if (typeof raw === 'boolean') return pass(raw);
      if (raw === 'true' || raw === 1 || raw === '1') return pass(true);
      if (raw === 'false' || raw === 0 || raw === '0') return pass(false);
      return fail(`${key}: должно быть true/false`);
    };
  },
  id(opts = {}) {
    // целочисленный идентификатор > 0
    return t.number({ min: 1, int: true, required: opts.required !== false });
  },
};

/** Прогон одного объекта по схеме. Возвращает {ok, value, errors}. */
function check(obj, schema) {
  const src = obj && typeof obj === 'object' ? obj : {};
  const out = {};
  const errors = [];
  for (const key of Object.keys(schema)) {
    const r = schema[key](src[key], key);
    if (!r.ok) { errors.push(r.msg); continue; }
    if (r.value !== undefined) out[key] = r.value;
  }
  return { ok: errors.length === 0, value: out, errors };
}

/**
 * Express middleware: валидирует req.body по схеме.
 * При ошибке — 400 с первым сообщением. При успехе — кладёт
 * очищенные значения в req.valid (req.body НЕ мутируем, чтобы не сломать
 * существующие хендлеры, читающие сырые поля).
 */
function validateBody(schema) {
  return (req, res, next) => {
    const r = check(req.body, schema);
    if (!r.ok) {
      return res.status(400).json({ error: 'validation_error', message: r.errors[0], details: r.errors });
    }
    req.valid = r.value;
    next();
  };
}

module.exports = { t, check, validateBody, EMAIL_RE, PHONE_RE };
