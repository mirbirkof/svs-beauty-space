require('dotenv').config();
const { Pool } = require('pg');
const url = process.env.DATABASE_URL_APP || process.env.DATABASE_URL;
const pool = new Pool({ connectionString: url, ssl:{rejectUnauthorized:false}, max: 3 });
(async()=>{
  const sql = process.argv[2] === '-f' ? require('fs').readFileSync(process.argv[3],'utf8') : process.argv.slice(2).join(' ');
  try {
    const r = await pool.query(sql);
    if (Array.isArray(r)) r.forEach(x=>console.log(JSON.stringify(x.rows)));
    else console.log(JSON.stringify(r.rows, null, 1));
  } catch(e){ console.error('ERR:', e.message); process.exitCode=1; }
  await pool.end();
})();
