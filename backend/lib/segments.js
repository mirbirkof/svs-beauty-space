/* ═══════════════════════════════════════════════════════
   MKT-04 — Движок сегментации клиентов

   Компилирует JSON-правила в параметризованный SQL по БЕЛОМУ СПИСКУ
   полей (никакого raw SQL от пользователя — защита от инъекций).

   Формат правил:
     { op: 'AND'|'OR', conditions: [ { field, operator, value }, ... ] }
   ═══════════════════════════════════════════════════════ */
const { getPool } = require('../db-pg');

// Подзапросы выполненных визитов (на масштаб салона ~5k клиентов — ок)
const VISITS = `(SELECT count(*) FROM appointments a WHERE a.client_id=c.id AND a.status='done')`;

// Белый список полей: field → { expr, type }
const FIELDS = {
  days_since_visit:  { expr: `EXTRACT(EPOCH FROM (NOW()-c.last_visit_at))/86400`, type: 'number' },
  last_visit_at:     { expr: `c.last_visit_at`, type: 'date' },
  total_spent:       { expr: `COALESCE(c.total_spent,0)`, type: 'number' },
  avg_check:         { expr: `CASE WHEN ${VISITS}>0 THEN COALESCE(c.total_spent,0)/${VISITS} ELSE 0 END`, type: 'number' },
  visit_count:       { expr: VISITS, type: 'number' },
  loyalty_points:    { expr: `COALESCE(c.loyalty_points,0)`, type: 'number' },
  has_telegram:      { expr: `(c.telegram_id IS NOT NULL)`, type: 'bool' },
  has_email:         { expr: `(c.email IS NOT NULL AND c.email <> '')`, type: 'bool' },
  has_phone:         { expr: `(c.phone IS NOT NULL AND c.phone <> '')`, type: 'bool' },
  source:            { expr: `c.source`, type: 'text' },
  name:              { expr: `c.name`, type: 'text' },
  tags:              { expr: `c.tags`, type: 'array' },
  birthday_in_days:  { expr: `(
      EXTRACT(DOY FROM make_date(EXTRACT(YEAR FROM NOW())::int, EXTRACT(MONTH FROM c.birthday)::int, LEAST(EXTRACT(DAY FROM c.birthday)::int,28)))
      - EXTRACT(DOY FROM NOW()) + 365)::int % 365`, type: 'number' },
  created_days_ago:  { expr: `EXTRACT(EPOCH FROM (NOW()-c.created_at))/86400`, type: 'number' },
};

const OPS = ['=', '!=', '>', '<', '>=', '<=', 'between', 'in', 'not_in', 'contains', 'is_null', 'is_not_null'];

// Компиляция одного условия → { frag, params }
function compileCond(cond, params) {
  const f = FIELDS[cond.field];
  if (!f) throw new Error('unknown-field:' + cond.field);
  const op = cond.operator;
  if (!OPS.includes(op)) throw new Error('unknown-operator:' + op);
  const E = f.expr;

  switch (op) {
    case 'is_null':     return { frag: `${E} IS NULL` };
    case 'is_not_null': return { frag: `${E} IS NOT NULL` };
    case 'between': {
      const [a, b] = Array.isArray(cond.value) ? cond.value : [cond.value, cond.value];
      params.push(a, b);
      return { frag: `${E} BETWEEN $${params.length - 1} AND $${params.length}` };
    }
    case 'in':
    case 'not_in': {
      const arr = Array.isArray(cond.value) ? cond.value : [cond.value];
      params.push(arr);
      return { frag: `${op === 'not_in' ? 'NOT ' : ''}(${E} = ANY($${params.length}))` };
    }
    case 'contains': {
      if (f.type === 'array') { params.push(cond.value); return { frag: `$${params.length} = ANY(${E})` }; }
      params.push(cond.value);
      return { frag: `${E} ILIKE '%' || $${params.length} || '%'` };
    }
    default: { // = != > < >= <=
      // bool-поля: значение true/false без параметра
      if (f.type === 'bool') {
        const truthy = cond.value === true || cond.value === 'true' || cond.value === 1;
        return { frag: `${E} = ${truthy ? 'TRUE' : 'FALSE'}` };
      }
      params.push(cond.value);
      const sqlOp = op === '!=' ? '<>' : op;
      return { frag: `${E} ${sqlOp} $${params.length}` };
    }
  }
}

// Компиляция правил → { where, params }
function compileRules(rules) {
  const params = [];
  if (!rules || !Array.isArray(rules.conditions) || !rules.conditions.length) {
    return { where: 'TRUE', params };
  }
  const glue = rules.op === 'OR' ? ' OR ' : ' AND ';
  const frags = rules.conditions.map((c) => compileCond(c, params).frag);
  return { where: '(' + frags.join(glue) + ')', params };
}

// Предустановленные сегменты (правила в коде)
const PRESETS = {
  new:       { name: 'Нові',        rules: { op: 'AND', conditions: [{ field: 'created_days_ago', operator: '<=', value: 30 }] } },
  active:    { name: 'Активні',     rules: { op: 'AND', conditions: [{ field: 'days_since_visit', operator: '<=', value: 30 }] } },
  sleeping:  { name: 'Засинають',   rules: { op: 'AND', conditions: [{ field: 'days_since_visit', operator: 'between', value: [31, 60] }] } },
  lost:      { name: 'Втрачені',    rules: { op: 'AND', conditions: [{ field: 'days_since_visit', operator: '>', value: 90 }] } },
  vip:       { name: 'VIP',         rules: { op: 'OR',  conditions: [{ field: 'total_spent', operator: '>=', value: 5000 }, { field: 'tags', operator: 'contains', value: 'vip' }] } },
  birthday:  { name: 'День народження (7 днів)', rules: { op: 'AND', conditions: [{ field: 'birthday_in_days', operator: '<=', value: 7 }] } },
  high_check:{ name: 'Високий чек', rules: { op: 'AND', conditions: [{ field: 'avg_check', operator: '>=', value: 800 }] } },
  no_telegram:{ name: 'Без Telegram', rules: { op: 'AND', conditions: [{ field: 'has_telegram', operator: '=', value: false }] } },
};

function resolveRules(segment) {
  if (segment.type === 'preset' && PRESETS[segment.preset_key]) return PRESETS[segment.preset_key].rules;
  return segment.rules || {};
}

// Подсчёт количества клиентов в сегменте
async function countSegment(segment) {
  const pool = getPool();
  if (segment.type === 'static') {
    const r = await pool.query(`SELECT count(*)::int c FROM segment_members WHERE segment_id=$1`, [segment.id]);
    return r.rows[0].c;
  }
  const { where, params } = compileRules(resolveRules(segment));
  const r = await pool.query(`SELECT count(*)::int c FROM clients c WHERE ${where}`, params);
  return r.rows[0].c;
}

// Список клиентов сегмента (id + контакты для рассылки)
async function membersOf(segment, { limit = 1000 } = {}) {
  const pool = getPool();
  if (segment.type === 'static') {
    const r = await pool.query(
      `SELECT c.id, c.name, c.phone, c.email, c.telegram_id
       FROM segment_members sm JOIN clients c ON c.id=sm.client_id
       WHERE sm.segment_id=$1 LIMIT $2`, [segment.id, limit]);
    return r.rows;
  }
  const { where, params } = compileRules(resolveRules(segment));
  params.push(limit);
  const r = await pool.query(
    `SELECT c.id, c.name, c.phone, c.email, c.telegram_id
     FROM clients c WHERE ${where} LIMIT $${params.length}`, params);
  return r.rows;
}

// Превью по произвольным правилам (для конструктора)
async function previewRules(rules) {
  const pool = getPool();
  const { where, params } = compileRules(rules);
  const r = await pool.query(`SELECT count(*)::int c FROM clients c WHERE ${where}`, params);
  return r.rows[0].c;
}

module.exports = { compileRules, countSegment, membersOf, previewRules, resolveRules, PRESETS, FIELDS, OPS };
