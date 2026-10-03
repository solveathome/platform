import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,closeSync,readSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import express from 'express';
const dir=mkdtempSync(join(tmpdir(),'sah-snapshot-privacy-'));
process.env.DUMP_DIR=dir;process.env.DUMPS_PUBLIC='true';
const {dumps}=await import('../src/routes/dumps.ts');
test('historical snapshot gate protects full, range and encoded paths without changing safe bytes or old proofs',async()=>{
 const day=join(dir,'2026-10-03');mkdirSync(day);const path=join(day,'returns.jsonl');
 const manifest='{"day":"2026-10-03"}\n';writeFileSync(join(day,'manifest.json'),manifest);writeFileSync(join(day,'manifest.json.ots'),'proof');
 const unsafe='{"report":"attempt 01234567… was replaced by 0123456789abcdef0123456789abcdef, which another of your sessions holds"}\n';writeFileSync(path,unsafe);
 const app=express();app.use(dumps);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  for(const url of ['/dumps/2026-10-03/returns.jsonl','/dumps/2026-10-03/returns%2ejsonl','/dumps/2026-10-03/returns.jsonl%2f.']) {
   const response=await fetch(base+url,{headers:{Range:'bytes=0-9'}});assert.equal(response.status,409);assert.match(response.headers.get('cache-control'),/no-store/);assert.ok(!(await response.text()).includes('01234567'));
  }
  assert.equal(readFileSync(path,'utf8'),unsafe);assert.equal(readFileSync(join(day,'manifest.json'),'utf8'),manifest);assert.equal(readFileSync(join(day,'manifest.json.ots'),'utf8'),'proof');
  const safe='{"id":42,"anchor":75053614359224265389282351,"x":-0,"y":1e400,"scientific_sha":"'+'a'.repeat(64)+'"}\n';writeFileSync(path,safe);
  const full=await fetch(base+'/dumps/2026-10-03/returns.jsonl');assert.equal(full.status,200);assert.equal(await full.text(),safe);
  const range=await fetch(base+'/dumps/2026-10-03/returns.jsonl',{headers:{Range:'bytes=0-9'}});assert.equal(range.status,206);assert.equal(await range.text(),safe.slice(0,10));
  const {openDumpSnapshot}=await import('../src/lib/dump.ts');const opened=await openDumpSnapshot(path);assert.ok(opened);
  writeFileSync(path+'.next',unsafe);renameSync(path+'.next',path);
  try{const bytes=Buffer.alloc(opened.size);readSync(opened.fd,bytes,0,bytes.length,0);assert.equal(bytes.toString(),safe);}finally{closeSync(opened.fd);}
  assert.equal((await fetch(base+'/dumps/2026-10-03/returns.jsonl')).status,409);
  writeFileSync(path,'x'.repeat(8*1024*1024+1));assert.equal((await fetch(base+'/dumps/2026-10-03/returns.jsonl')).status,409);
 }finally{await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
