require('dotenv').config();
const {Pool}=require('pg');
const pool=new Pool({connectionString:process.env.QA_DB_URL, ssl:{rejectUnauthorized:false}});
(async()=>{ try{const r=await pool.query(process.argv[2]);console.log(JSON.stringify(r.rows));}catch(e){console.error('ERR',e.message);} await pool.end();})();
