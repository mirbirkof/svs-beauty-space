const{Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});await c.connect();
const sql=process.argv[2];const r=await c.query(sql);console.table(r.rows);await c.end();})().catch(e=>{console.error(e.message);process.exit(1)})
