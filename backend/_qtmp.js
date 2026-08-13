require('dotenv').config({path:'/home/client/workspace/svs-beauty-space/backend/.env'});
const {Pool}=require('pg');
const pool=new Pool({connectionString:process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
(async()=>{
  const sql=process.argv[2];
  try{const r=await pool.query(sql);console.log(JSON.stringify(r.rows,null,1));}catch(e){console.error('ERR',e.message);}
  await pool.end();
})();
