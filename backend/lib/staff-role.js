'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   ЄДИНЕ ДЖЕРЕЛО ПРАВДИ ПРО РОЛЬ СПІВРОБІТНИКА (нотатка #160)

   Було: питання «ця людина — майстер чи адміністрація?» кожен модуль вирішував
   по-своєму, і відповіді розходились:
     • реєстр «Команда»   — за явною роллю masters.staff_role;
     • план дня / каса    — staff_role OR provides_services=false (майстер, якому
                            зняли послуги, ставав «адміном» у касі);
     • графік роботи      — за ТЕКСТОМ спеціальності (/адміністратор|admin/), бо
                            місячний графік навіть не віддавав роль на фронт;
     • зали               — лише 'admin', власника не враховував.
   Плюс у людей, доданих після міграції 051, staff_role лишався NULL — тобто ролі
   не було взагалі, і кожен модуль домальовував її на свій смак.

   Стало: роль читається ЛИШЕ з masters.staff_role, і тільки звідси. Ознака
   «надає послуги» відповідає за журнал та онлайн-запис і на роль НЕ впливає.
   Один і той самий вираз використовують і SQL-запити, і JS, і фронт.
   ═══════════════════════════════════════════════════════════════════════════ */

const ROLES = ['master', 'admin', 'owner'];
const ROLE_LABEL = { master: 'Майстер', admin: 'Адміністратор', owner: 'Власник' };

/** Роль людини з рядка masters. Невідоме/порожнє = майстер (безпечний типовий стан). */
function staffRole(row) {
  const v = String((row && (row.staff_role ?? row.staffRole)) || '').trim().toLowerCase();
  return ROLES.includes(v) ? v : 'master';
}

/** Адміністрація = адміністратор або власник. Послуги тут ні до чого. */
function isAdminStaff(row) {
  const r = staffRole(row);
  return r === 'admin' || r === 'owner';
}

function roleLabel(row) { return ROLE_LABEL[staffRole(row)]; }

/** Нормалізована роль у SQL — той самий сенс, що й staffRole() у JS. */
function roleSql(alias = 'm') {
  const c = `${alias}.staff_role`;
  return `(CASE WHEN lower(btrim(COALESCE(${c},''))) IN ('master','admin','owner')
                THEN lower(btrim(${c})) ELSE 'master' END)`;
}

/** Ознака «адміністрація» у SQL. Використовувати замість саморобних формул. */
function isAdminSql(alias = 'm') {
  return `(${roleSql(alias)} IN ('admin','owner'))`;
}

/** Сортування: адміністрація завжди суцільним блоком унизу (прохання Боса 04.07). */
function adminLastSql(alias = 'm') { return `(${isAdminSql(alias)})::int ASC`; }

module.exports = { ROLES, ROLE_LABEL, staffRole, isAdminStaff, roleLabel, roleSql, isAdminSql, adminLastSql };

/* ── «Чи є вже картка цієї людини?» — один заслін на всю CRM (нотатка #161) ──
   Власник: «одна аліна продубльована і зайва, незрозуміло звідки матеріалізувалась
   друга». Двійник зʼявлявся тому, що завести ЩЕ ОДНУ картку з тим самим імʼям можна
   було мовчки — і людина роздвоювалась у графіку, плані дня та касі (усі вони рахують
   людей по картках). Прибрати двійників мало: треба закрити сам шлях їх появи.
   Тут — ЄДИНА перевірка для всіх місць, де створюється співробітник. Обʼєднані
   картки (merged_into) за людину не рахуються: це вже погашені порожнівки. */
const twinNameKey = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Знаходить живу картку з таким самим імʼям. pool — pg Pool/Client. */
async function findStaffTwin(pool, name) {
  const key = twinNameKey(name);
  if (!key) return null;
  const r = await pool.query(
    `SELECT id, name, specialty, COALESCE(active,true) AS active FROM masters
      WHERE merged_into IS NULL
        AND lower(regexp_replace(COALESCE(name,''), '\\s+', ' ', 'g')) = $1
      ORDER BY (COALESCE(active,true) = true) DESC, id
      LIMIT 1`, [key]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

/** Людське пояснення відмови — однакове в усіх розділах. */
function twinConflict(row) {
  return {
    error: 'duplicate-name',
    existing_id: row.id,
    message: `«${row.name}» вже є в команді${row.specialty ? ' (' + row.specialty + ')' : ''}`
           + `${row.active === false ? ' — картка неактивна, її можна повернути' : ''}.`
           + ' Друга картка тій самій людині роздвоїть її в графіку, плані дня й касі.'
           + ' Якщо це справді інша людина з таким самим імʼям — підтвердьте створення.',
  };
}

module.exports.twinNameKey = twinNameKey;
module.exports.findStaffTwin = findStaffTwin;
module.exports.twinConflict = twinConflict;
