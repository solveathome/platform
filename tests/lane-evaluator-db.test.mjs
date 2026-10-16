import assert from 'node:assert/strict';
import {before, beforeEach, after, afterEach, test} from 'node:test';
import {randomUUID, createHash} from 'node:crypto';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import express from 'express';

// The locked evaluator on the check path (#sah-sakana-lane-specs-locked-evaluator, Oct 16 2026): a measured result in a lane with a
// spec gets a check job that carries the lane's pinned evaluator hash, and its receipt is recorded only with that hash or an
// uploaded independent reimplementation. Matching, mismatched and missing hashes, end to end through /result.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database.');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
process.env.BASE_URL='http://localhost:0';
const temp=mkdtempSync(join(tmpdir(),'sah-lane-evaluator-'));
process.env.FILES_DIR=join(temp,'files');process.env.DOCS_DIR=join(temp,'docs');process.env.OVERLAY_DIR=join(temp,'overlay');process.env.PROJECTS_DIR=join(temp,'projects');
const {q,one,pool,migrate}=await import('../src/db/index.ts');
const {issueToken}=await import('../src/lib/auth.ts');
const {TERMS_VERSION}=await import('../src/lib/terms.ts');
const {job}=await import('../src/routes/job.ts');
const {lane}=await import('../src/routes/lane.ts');
const {filesRouter}=await import('../src/routes/files.ts');
const files=await import('../src/lib/files.ts');
const realLane=JSON.parse(readFileSync('projects/twin-primes/project.json','utf8')).lanes.find(l=>l.slug==='measure');
const PINNED=realLane.spec.evaluator.sha256;
let server,pid,slug,base,laneId;
const users={};
const models={author:'claude-opus-5',runner:'claude-sonnet-5'};
before(async()=>{
  await migrate();
  for(const [name,model] of Object.entries(models)) {
    const id=Number((await one(`INSERT INTO users (github_id,handle,terms_version,terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`,[900000000+Math.floor(Math.random()*1e8),'lane-eval-'+name+'-'+randomUUID().slice(0,8),TERMS_VERSION])).id);
    users[name]={id,model,token:await issueToken(id)};
  }
  const app=express();app.use(express.json());app.use('/projects/:slug',job,lane);app.use(filesRouter);
  app.use((e,req,res,next)=>res.status(e.status??500).json({error:e.message}));
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
});
beforeEach(async()=>{
  slug='lane-eval-'+randomUUID().slice(0,8);
  // The project's config: the real measure lane's spec and files, under this test project's slug.
  const dir=join(temp,'projects',slug);mkdirSync(join(dir,'lanes'),{recursive:true});
  cpSync('projects/twin-primes/lanes/measure',join(dir,'lanes','measure'),{recursive:true});
  writeFileSync(join(dir,'project.json'),JSON.stringify({slug,name:'Lane evaluator test',lanes:[realLane]}));
  pid=Number((await one(`INSERT INTO problems (slug,name,repo_url,status_md,discovery_share) VALUES ($1,'Lane evaluator test','https://example.org/r','open',0) RETURNING id`,[slug])).id);
  await q(`INSERT INTO channels (problem_id,path,title) VALUES ($1,'','Project')`,[pid]);
  laneId=Number((await one(`INSERT INTO lanes (problem_id,slug,title) VALUES ($1,'measure','Measure') RETURNING id`,[pid])).id);
  base=`http://127.0.0.1:${server.address().port}/projects/${slug}`;
});
afterEach(async()=>{
  await q(`DELETE FROM file_refs WHERE ref_type='return' AND ref_id IN (SELECT id FROM returns WHERE problem_id=$1)`,[pid]);
  await q(`DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE problem_id=$1)`,[pid]);
  await q(`DELETE FROM channel_members WHERE channel_id IN (SELECT id FROM channels WHERE problem_id=$1)`,[pid]);
  await q(`DELETE FROM reviews WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`,[pid]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`,[pid]);
  await q(`DELETE FROM credits WHERE problem_id=$1`,[pid]);
  await q(`UPDATE returns SET job_id=NULL WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM jobs WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM returns WHERE problem_id=$1`,[pid]);
  for(const table of ['project_roles','sessions','pool','channels','lanes'])await q(`DELETE FROM ${table} WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM problems WHERE id=$1`,[pid]);
});
after(async()=>{
  await new Promise(r=>server.close(r));
  const ids=Object.values(users).map(x=>x.id);
  await q(`DELETE FROM file_refs WHERE file_sha IN (SELECT sha256 FROM files WHERE user_id=ANY($1))`,[ids]);
  for(const table of ['files','tokens','reputation','counted_entries'])await q(`DELETE FROM ${table} WHERE user_id=ANY($1)`,[ids]);
  await q(`DELETE FROM users WHERE id=ANY($1)`,[ids]);
  await pool.end();rmSync(temp,{recursive:true,force:true});
});
async function call(path,{who='author',method='GET',assignment,body,accept='application/json'}={}) {
  const u=users[who],headers={authorization:`Bearer ${u.token}`,'x-model':u.model,'x-effort':'max',accept,'content-type':'application/json'};
  if(assignment){headers['x-session']=assignment.session;headers['x-attempt']=assignment.attempt_id;} else headers['x-launch-id']=randomUUID();
  const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,body:accept==='application/json'?await res.json():await res.text()};
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
const start=async(who)=>ok(await call('/start?share=25',{who}));
const submit=(who,body,a)=>call('/result',{who,method:'POST',assignment:a,body:{report_md:'A bounded measurement with explicit evidence and limitations.',transcript:'t',transcript_approved:true,job_id:a.job_id,...body}});
async function measured(rung='measured'){
  const claims=JSON.stringify({lane:'measure',claims:[{quantity:'pi2',args:{n:1000},value:35}]});
  const checker=(await files.store(users.author.id,models.author,'count.mjs','mjs',`console.log(35) // ${slug}\n`)).sha;
  const target=(await files.store(users.author.id,models.author,'claims.json','json',claims)).sha;
  const plan={schema_version:1,manifest:[{path:'count.mjs',sha256:checker,role:'checker'},{path:'claims.json',sha256:target,role:'target'}],targets:['claims.json'],claim:'pi2(1000) = 35.',scope:'n = 1000 only.',assumptions:'(3,5) counts.',checker,inputs:[target],environment:'Node 18; no dependencies.',command:'node count.mjs',expected:'35\n',supports:'Counts every twin pair below 1000.',coverage:'decisive',coverage_md:'One value.',comparison:'Exact integer.',availability:{status:'complete',details:'All files are in the manifest.',network:false,required_sources:[]},cost:{minutes:1,cpu_hours:0.01,ram_gb:1,disk_gb:1}};
  const j=await one(`INSERT INTO jobs (problem_id,lane_id,type,title,brief_md,budget_hours,min_tier,priority) VALUES ($1,$2,'measure','Measure','Return a result.',4,99,10) RETURNING id`,[pid,laneId]);
  const a=await start('author');assert.equal(Number(a.job_id),Number(j.id));
  return {plan,ret:ok(await submit('author',{verification_plan:plan,author_rung:rung},a))};
}
async function receipt(subjectId,override={}){
  const subject=ok(await call(`/return/${subjectId}`));
  const stdout=(await files.store(users.runner.id,models.runner,'stdout.txt','txt',`ok #1 pi2 ${randomUUID()}\n`)).sha;
  return {check_receipt:{fingerprint:subject.verification_fingerprint,outcome:'pass',observed:'ok #1 pi2({"n":1000}) = 35',elapsed_seconds:1,stdout_sha256:stdout,exit_code:0,environment:'Node 22',coverage_md:'The one claim in claims.json.',method:'rerun',shared_components_md:'None: the lane evaluator, not the author checker.',controls_md:'pi2 claimed 37 fails with exit 1.',...override}};
}

test('a measured result in a lane with a spec gets a locked check; the receipt needs the pinned hash, and the page shows it',async()=>{
  const {plan,ret}=await measured();
  assert.equal(ret.check_requested,true);
  const checkJob=await one(`SELECT lane_evaluator_sha256,brief_md FROM jobs WHERE problem_id=$1 AND type='check'`,[pid]);
  assert.equal(checkJob.lane_evaluator_sha256,PINNED);
  assert.match(checkJob.brief_md,/Locked evaluator \(lane `measure`/);assert.match(checkJob.brief_md,new RegExp(PINNED));
  const spec=ok(await call('/lane/measure/spec'));assert.equal(spec.evaluator.sha256,PINNED);
  const served=await fetch(base+'/lane/measure/spec/evaluate.mjs');assert.equal(served.headers.get('x-content-sha256'),PINNED);
  assert.equal(createHash('sha256').update(Buffer.from(await served.arrayBuffer())).digest('hex'),PINNED);
  const a=await start('runner');assert.equal(a.type,'check');assert.match(a.brief??a.brief_md??JSON.stringify(a),/Locked evaluator/);
  // Missing, the author's own checker, and a different file under rerun: refused with the reason, nothing recorded.
  const missing=await submit('runner',await receipt(ret.return_id),a);
  assert.equal(missing.status,400);assert.match(missing.body.error,/evaluator_sha256 is required/);
  const author=await submit('runner',await receipt(ret.return_id,{evaluator_sha256:plan.checker,method:'independent_implementation'}),a);
  assert.equal(author.status,400);assert.match(author.body.error,/author's own package/);
  const other=await submit('runner',await receipt(ret.return_id,{evaluator_sha256:'e'.repeat(64)}),a);
  assert.equal(other.status,400);assert.match(other.body.error,/not the lane's pinned evaluator/);
  assert.equal((await one(`SELECT count(*)::int AS n FROM verification_runs WHERE subject_return_id=$1`,[ret.return_id])).n,0);
  // The pinned hash: recorded, served on the return JSON and on the page.
  ok(await submit('runner',await receipt(ret.return_id,{evaluator_sha256:PINNED}),a));
  const subject=ok(await call(`/return/${ret.return_id}`));
  assert.equal(subject.verification_runs[0].evaluator_sha256,PINNED);assert.equal(subject.verification_runs[0].evaluator_kind,'lane_pinned');
  const page=await call(`/return/${ret.return_id}`,{accept:'text/html'});
  assert.match(page.body,new RegExp(`the lane&#39;s pinned evaluator, sha256 ${PINNED}|the lane's pinned evaluator, sha256 ${PINNED}`));
});

test('an independent reimplementation passes once uploaded, and is recorded as such',async()=>{
  const {ret}=await measured('verified');
  const a=await start('runner');assert.equal(a.type,'check');
  const own=(await files.store(users.runner.id,models.runner,'my-pi2.py','py',`# my own twin count ${slug}\n`)).sha;
  ok(await submit('runner',await receipt(ret.return_id,{evaluator_sha256:own,method:'independent_implementation'}),a));
  const run=await one(`SELECT evaluator_sha256,evaluator_kind FROM verification_runs WHERE subject_return_id=$1`,[ret.return_id]);
  assert.deepEqual({...run},{evaluator_sha256:own,evaluator_kind:'independent_reimplementation'});
});

test('a heuristic result is not locked: its check job carries no evaluator and the receipt needs none',async()=>{
  const {ret}=await measured('heuristic');
  assert.equal((await one(`SELECT lane_evaluator_sha256 FROM jobs WHERE problem_id=$1 AND type='check'`,[pid])).lane_evaluator_sha256,null);
  const a=await start('runner');assert.equal(a.type,'check');
  ok(await submit('runner',await receipt(ret.return_id),a));
  assert.equal((await one(`SELECT evaluator_sha256 FROM verification_runs WHERE subject_return_id=$1`,[ret.return_id])).evaluator_sha256,null);
});
