const fs=require("fs"),path=require("path");
const D="/home/client/.claude/projects/-home-client-workspace/d028861f-392f-4cab-9a99-d60fe4b69ae0/subagents/workflows/wf_e420b3da-97e";
const files=fs.readdirSync(D).filter(f=>f.endsWith(".jsonl")&&f.startsWith("agent-"));
const all=[];
for(const f of files){
  let lines;try{lines=fs.readFileSync(path.join(D,f),"utf8").split("\n").filter(Boolean);}catch(e){continue;}
  for(const ln of lines){
    let o;try{o=JSON.parse(ln);}catch(e){continue;}
    // ищем tool_use со structured output (findings) в content
    const msg=o.message||o;
    const content=msg&&msg.content;
    if(!Array.isArray(content))continue;
    for(const c of content){
      if(c&&c.type==="tool_use"&&c.input&&Array.isArray(c.input.findings)){
        for(const fd of c.input.findings) all.push(fd);
      }
    }
  }
}
// дедуп по title
const seen=new Set(),uniq=[];
for(const f of all){const k=(f.title||"")+"|"+(f.severity||"");if(seen.has(k))continue;seen.add(k);uniq.push(f);}
const bySev=s=>uniq.filter(f=>f.severity===s);
console.log("ВСЕГО находок (сырые, до скептика):", uniq.length);
for(const s of ["critical","high","medium","low"]){
  const arr=bySev(s);if(!arr.length)continue;
  console.log(`\n### ${s.toUpperCase()} (${arr.length})`);
  arr.forEach(f=>console.log(`• [${f.module}] ${f.title} (conf ${f.confidence})\n   ${String(f.evidence||"").slice(0,120)}\n   почему: ${String(f.why_real||"").slice(0,120)}`));
}
