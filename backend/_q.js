require('dotenv').config();
const { Pool } = require('pg');
const url = process.env.DATABASE_URL || process.env.DATABASE_URL_APP;
const pool = new Pool({ connectionString: url, ssl: url.includes('neon.tech')||url.includes('supabase')?{rejectUnauthorized:false}:false });
(async()=>{
  try {
    const q = process.argv[2];
    const r = await pool.query(q);
    console.log(JSON.stringify(r.rows, null, 1));
  } catch(e){ console.error('ERR:', e.message); }
  await pool.end();
})();
