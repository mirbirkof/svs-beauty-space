require('dotenv').config({path: __dirname + '/.env'});
const {Pool}=require('pg'); const p=new Pool({connectionString:process.env.DATABASE_URL});
(async()=>{ for (const s of process.argv.slice(2)) { try { const r=await p.query(s); console.table(r.rows);} catch(e){console.log('ERR',e.message)} } await p.end(); })();
