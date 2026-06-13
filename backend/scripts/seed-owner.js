/* Разовый сид владельца. Использование:
   node scripts/seed-owner.js <phone> [display_name] [password]
   Читает DATABASE_URL из .env. НЕ печатает строку подключения. */
require('dotenv').config();
const { Pool } = require('pg');
const { hashPassword } = require('../lib/auth-core');

const phoneRaw = process.argv[2];
const displayName = process.argv[3] || 'Власник';
const password = process.argv[4] || null;

if (!phoneRaw) { console.error('Укажи телефон: node scripts/seed-owner.js <phone> [name] [password]'); process.exit(1); }
const phone = String(phoneRaw).replace(/\D/g, '');

const url = process.env.DATABASE_URL;
if (!url) { console.error('Нет DATABASE_URL в окружении/.env'); process.exit(1); }

const pool = new Pool({
  connectionString: url,
  ssl: url.includes('neon.tech') || url.includes('supabase') ? { rejectUnauthorized: false } : false,
});

(async () => {
  try {
    const usersCount = await pool.query('SELECT count(*)::int AS n FROM users');
    const role = await pool.query(`SELECT id FROM roles WHERE code = 'owner' LIMIT 1`);
    if (!role.rowCount) throw new Error('Роль owner не найдена — миграции не применены к этой БД');
    const roleId = role.rows[0].id;
    const hash = password ? await hashPassword(String(password)) : null;

    const existing = await pool.query('SELECT id, role_id FROM users WHERE phone = $1', [phone]);
    let userId, action;
    if (existing.rowCount) {
      userId = existing.rows[0].id;
      await pool.query(
        `UPDATE users SET role_id = $1, display_name = $2, is_active = true,
           password_hash = COALESCE($3, password_hash), updated_at = NOW() WHERE id = $4`,
        [roleId, displayName, hash, userId]
      );
      action = 'updated';
    } else {
      const ins = await pool.query(
        `INSERT INTO users (phone, display_name, role_id, password_hash, is_active)
         VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [phone, displayName, roleId, hash]
      );
      userId = ins.rows[0].id;
      action = 'created';
    }
    console.log(JSON.stringify({
      ok: true, action, user_id: userId, phone, role: 'owner',
      password_set: !!hash, db_users_before: usersCount.rows[0].n,
    }));
  } catch (e) {
    console.error('SEED_ERROR:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
