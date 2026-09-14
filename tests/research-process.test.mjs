import assert from 'node:assert/strict';
import {before, beforeEach, after, afterEach, test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import express from 'express';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database.');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
process.env.BASE_URL='http://localhost:0';
const temp=mkdtempSync(join(tmpdir(),'sah-research-'));
process.env.FILES_DIR=join(temp,'files');process.env.DOCS_DIR=join(temp,'docs');process.env.OVERLAY_DIR=join(temp,'overlay');
const {q,one,pool,migrate,projectTransaction}=await import('../src/db/index.ts');
const {issueToken}=await import('../src/lib/auth.ts');
const {TERMS_VERSION}=await import('../src/lib/terms.ts');
const {job,resumeDeferredReviews}=await import('../src/routes/job.ts');
const {board}=await import('../src/routes/board.ts');
const {filesRouter}=await import('../src/routes/files.ts');
const files=await import('../src/lib/files.ts');
const {prepareRescue,reconsiderDependents}=await import('../src/lib/research.ts');
const {researchAllocation}=await import('../src/lib/scheduler.ts');
let server,pid,slug,base;
const users={};
const models={author:'claude-opus-5',astra:'gpt-6-astra',runner:'claude-sonnet-5',judge:'claude-fable-5-1'};
before(async()=>{
  await migrate();await migrate();
  for(const [name,model] of Object.entries(models)) {
    const handle='research-'+name+'-'+randomUUID().slice(0,8);
    const id=Number((await one(`INSERT INTO users (github_id,handle,terms_version,terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`,[900000000+Math.floor(Math.random()*1e8),handle,TERMS_VERSION])).id);
    users[name]={id,model,token:await issueToken(id)};
  }
  const app=express();app.use(express.json());app.use('/projects/:slug',job,board);app.use(filesRouter);
  app.use((e,req,res,next)=>res.status(e.status??500).json({error:e.message}));
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
});
beforeEach(async()=>{
  slug='research-'+randomUUID().slice(0,8);
  pid=Number((await one(`INSERT INTO problems (slug,name,repo_url,status_md,discovery_share) VALUES ($1,'Research test','https://example.org/r','open',0) RETURNING id`,[slug])).id);
  await q(`INSERT INTO channels (problem_id,path,title) VALUES ($1,'','Project')`,[pid]);
  await q(`INSERT INTO project_roles (problem_id,user_id,role,note) VALUES ($1,$2,'trusted','test')`,[pid,users.judge.id]);
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
  for(const table of ['project_roles','sessions','pool','channels'])await q(`DELETE FROM ${table} WHERE problem_id=$1`,[pid]);
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
async function call(path,{who='author',method='GET',assignment,body,launch,capabilities,accept='application/json'}={}) {
  const u=users[who],headers={authorization:`Bearer ${u.token}`,'x-model':u.model,'x-effort':'max',accept,'content-type':'application/json'};
  if(launch)headers['x-launch-id']=launch;
  if(capabilities)headers['x-capabilities']=JSON.stringify(capabilities);
  if(assignment){headers['x-session']=assignment.session;headers['x-attempt']=assignment.attempt_id;}
  const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,body:accept==='application/json'?await res.json():await res.text()};
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
const start=async(who='astra',assignment)=>ok(await call('/start?share=25',{who,assignment,launch:assignment?undefined:randomUUID()}));
const submit=(who,body,assignment)=>call('/result',{who,method:'POST',assignment,body:{report_md:'A bounded investigation with explicit evidence and limitations.',transcript:'t',transcript_approved:true,...(assignment?{job_id:assignment.job_id}:{type:'direction'}),...body}});
const step=(label='initial')=>({question:`Can ${label} requirement hold?`,method:`Check the ${label} implication on the specified cases.`,success:'The necessary property survives.',failure:'A decisive witness defeats this attempt.',budget_hours:0.25});
const proposal=()=>({outcome:'proposed',proposal:{title:'A route with a weaker hypothesis',contribution_md:'A new sufficient intermediate statement.',prior_art_md:'Compare the nearest published result at its theorem and assumptions.',uncertainty_md:'Whether the weaker hypothesis suffices.'},evidence_md:'A bounded concrete way to test the missing implication.',next_step:step(),depends_on:[]});
const obstacle={kind:'attempt_failed',statement:'The uniform bound fails.',assumptions:'This proof attempt requires uniformity.',evidence:'A witness violates that bound.',revisit_when:'An average bound might suffice.'};
async function proposed() {return ok(await submit('author',{research:proposal()}));}
async function activeRoute(){const r=await proposed(),a=await start();const p=ok(await submit('astra',{research:{route_id:r.research.route_id,outcome:'promising',evidence_md:'The first test leaves a specific viable implication.',next_step:step()}},a));return {r,a,p};}

test('proposal → triage → pursuit → scoped obstacle → different-model rescue, with replay-safe follow-ups',async()=>{
  const r=await proposed();assert.equal(r.status,'recorded');assert.equal(r.reviews_requested,0);
  const a=await start();assert.equal(a.research_stage,'triage');assert.match(a.brief_md,/Investment state: proposed/);
  const missing=await submit('astra',{},a);assert.equal(missing.status,400);assert.match(missing.body.error,/requires research/);
  assert.equal((await submit('astra',{research:proposal()},a)).status,400);
  assert.equal((await one(`SELECT status FROM jobs WHERE id=$1`,[a.job_id])).status,'assigned');
  const body={research:{route_id:r.research.route_id,outcome:'promising',evidence_md:'A new intermediate implication passed its smallest test.',next_step:step()}};
  const results=await Promise.all([submit('astra',body,a),submit('astra',body,a)]);assert.deepEqual(ok(results[0]),ok(results[1]));
  assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE research_route_id=$1 AND status='queued'`,[r.research.route_id])).n,1);
  const p=await start('author');assert.equal(p.research_stage,'pursue');
  const blocked=ok(await submit('author',{research:{route_id:r.research.route_id,outcome:'blocked',evidence_md:'Only the uniform version failed.',obstacle}},p));
  assert.equal(blocked.research.state,'blocked');assert.equal(blocked.status,'recorded');
  await projectTransaction(pid,async()=>{await prepareRescue(pid,models.astra,null);await prepareRescue(pid,models.astra,null);});
  assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE research_route_id=$1 AND research_stage='rescue'`,[r.research.route_id])).n,1);
  const rescue=await start();assert.equal(rescue.research_stage,'rescue');
  const recovered=ok(await submit('astra',{research:{route_id:r.research.route_id,outcome:'progress',evidence_md:'An average bound suffices, so the uniform counterexample does not defeat the revised step.',next_step:step('average')}},rescue));
  assert.equal(recovered.research.state,'active');
  const route=ok(await call(`/research-routes/${r.research.route_id}`));assert.ok(route.events.some(e=>e.detail.obstacle?.kind==='attempt_failed'));
  assert.equal(route.events.length,4);assert.equal(route.jobs.filter(j=>j.status==='queued').length,1);
  assert.equal((await call(`/research-routes/${r.research.route_id}`,{accept:'text/html'})).status,200);
});

test('repeat experiments pause rather than buying the same work with a changed budget',async()=>{
  const {r}=await activeRoute(),p=await start('author');
  const again=ok(await submit('author',{research:{route_id:r.research.route_id,outcome:'progress',evidence_md:'No change to the proposed experiment.',next_step:{...step(),budget_hours:1}}},p));
  assert.equal(again.research.state,'paused');assert.equal(again.research.next_job_id,null);
});

test('invalid dependencies and unrelated route updates roll back without creating work',async()=>{
  const r=await proposed();const before=await one(`SELECT count(*)::int AS n FROM returns WHERE problem_id=$1`,[pid]);
  const bad=await submit('author',{research:{...proposal(),depends_on:[999999999]}});assert.equal(bad.status,400);
  assert.equal((await one(`SELECT count(*)::int AS n FROM returns WHERE problem_id=$1`,[pid])).n,before.n);
  assert.equal((await submit('author',{research:{route_id:r.research.route_id,outcome:'progress',evidence_md:'A different author tries to update the route.',next_step:step('other')}})).status,400);
  const second=Number((await one(`INSERT INTO problems (slug,name,repo_url,status_md) VALUES ($1,'Other','https://example.org/r','open') RETURNING id`,['other-'+randomUUID()])).id);
  const previous=base;base=`http://127.0.0.1:${server.address().port}/projects/${(await one('SELECT slug FROM problems WHERE id=$1',[second])).slug}`;
  assert.equal((await call(`/research-routes/${r.research.route_id}`)).status,404);base=previous;
  await q('DELETE FROM problems WHERE id=$1',[second]);
});

test('a changed trusted premise flags dependents and cancels queued pursuit without asserting refutation',async()=>{
  const prerequisite=Number((await one(`INSERT INTO returns (problem_id,type,user_id,model,provider,report_md,transcript,status,final_rung) VALUES ($1,'source',$2,$3,'anthropic','A required premise.','t','accepted','measured') RETURNING id`,[pid,users.author.id,models.author])).id);
  const r=ok(await submit('author',{research:{...proposal(),depends_on:[prerequisite]}})),a=await start();
  ok(await submit('astra',{research:{route_id:r.research.route_id,outcome:'promising',evidence_md:'Conditional progress using the premise.',next_step:step()}},a));
  ok(await submit('judge',{type:'review',return_id:prerequisite,verdict:'reject',reject_reason:'refuted',notes_md:'The specific premise fails.'}));
  const route=ok(await call(`/research-routes/${r.research.route_id}`));
  assert.equal(route.state,'blocked');assert.equal(route.dependencies[0].status,'rejected');
  assert.ok(route.events.some(e=>e.outcome==='dependency_changed'));assert.equal(route.jobs.filter(j=>j.status==='queued'&&j.research_stage==='pursue').length,0);
});

test('late rejection follows the investment chain even when no dependencies were declared',async()=>{
  const {r,p}=await activeRoute(),held=await start('author');
  const progress=ok(await submit('author',{research:{route_id:r.research.route_id,outcome:'progress',evidence_md:'The triage finding supports a second bounded step.',next_step:step('second'),depends_on:[]}},held));
  let route=ok(await call(`/research-routes/${r.research.route_id}`));
  assert.deepEqual(route.basis.map(x=>Number(x.id)),[r.return_id,p.return_id,progress.return_id]);
  assert.equal(route.dependencies.length,0);
  ok(await submit('judge',{type:'review',return_id:p.return_id,verdict:'reject',reject_reason:'refuted',notes_md:'The feasibility argument assumed a property that fails.'}));
  route=ok(await call(`/research-routes/${r.research.route_id}`));
  assert.equal(route.state,'blocked');assert.equal(route.jobs.filter(j=>j.status==='queued').length,0);
  assert.equal(route.basis.find(x=>Number(x.id)===p.return_id).status,'rejected');
  const html=ok(await call(`/research-routes/${r.research.route_id}`,{accept:'text/html'}));
  assert.match(html,/Evidence behind continued investment/);
  assert.match(html,/rejected/);
  // A rescue reassesses the failed step. Old rejected arguments stay visible in history,
  // but do not invalidate a replacement argument unless it explicitly requires them.
  await projectTransaction(pid,()=>prepareRescue(pid,models.astra,null));
  const rescue=await start('astra');assert.equal(rescue.research_stage,'rescue');
  const revised=ok(await submit('astra',{research:{route_id:r.research.route_id,outcome:'progress',evidence_md:'A distinct argument avoids the failed property.',next_step:step('replacement'),depends_on:[]}},rescue));
  await projectTransaction(pid,()=>reconsiderDependents(p.return_id,'reopened'));
  route=ok(await call(`/research-routes/${r.research.route_id}`));
  assert.equal(route.state,'active');assert.deepEqual(route.basis.map(x=>Number(x.id)),[revised.return_id]);
  assert.ok(route.events.some(x=>Number(x.return_id)===p.return_id));
});

test('a useful result can request review and continue pursuit at the same time',async()=>{
  const {r}=await activeRoute(),held=await start('author');
  const result=ok(await submit('author',{research:{route_id:r.research.route_id,outcome:'result',evidence_md:'A useful intermediate lemma leaves a new uncertainty.',next_step:step('next lemma')}},held));
  assert.equal(result.status,'pending');assert.ok(result.reviews_requested>0);
  assert.equal(result.research.state,'active');assert.ok(result.research.next_job_id);
  const pursue=await start('author');assert.equal(pursue.research_stage,'pursue');
  const finished=ok(await submit('author',{research:{route_id:r.research.route_id,outcome:'result',evidence_md:'A finite result is ready for review with no further experiment proposed.'}},pursue));
  assert.equal(finished.status,'pending');assert.equal(finished.research.state,'result');assert.equal(finished.research.next_job_id,null);
});

test('reviews of evidence used by continued pursuit get a bounded advantage over routine backlog',async()=>{
  const {r}=await activeRoute(),held=await start('author');
  const result=ok(await submit('author',{research:{route_id:r.research.route_id,outcome:'result',evidence_md:'A finite lemma now supports the next experiment.',next_step:step('dependent experiment')}},held));
  await start('author'); // Pursuit proceeds concurrently; compare the two remaining review candidates.
  const old=await one(`INSERT INTO returns (problem_id,type,user_id,model,provider,report_md,transcript,status) VALUES ($1,'explore',$2,$3,'anthropic','An older independent claim.','t','pending') RETURNING id`,[pid,users.author.id,models.author]);
  const backlog=await one(`INSERT INTO jobs (problem_id,type,title,brief_md,budget_hours,min_tier,parent_return_id,created_at) VALUES ($1,'review','Older review','Judge this claim.',0.25,1,$2,now()-interval '1 day') RETURNING id`,[pid,old.id]);
  const important=await start('judge');
  assert.equal(Number((await one('SELECT parent_return_id FROM jobs WHERE id=$1',[important.job_id])).parent_return_id),result.return_id);
  ok(await call('/release',{who:'judge',method:'POST',assignment:important,body:{job_id:important.job_id,note:'Test age priority in another session.'}}));
  await q(`UPDATE jobs SET created_at=now()-interval '10 days' WHERE id=$1`,[backlog.id]);
  const aged=await start('judge');assert.equal(Number(aged.job_id),Number(backlog.id),'Age must eventually overtake the dependency bonus.');
});

for(const who of ['astra','author','runner'])test(`lightweight triage of an Astra proposal is available to ${who}`,async()=>{
  const r=ok(await submit('astra',{research:proposal()}));
  const a=await start(who);assert.equal(a.research_stage,'triage');
  assert.equal(Number(a.research_route_id),r.research.route_id);
  const queued=await one('SELECT min_tier,avoid_model,budget_hours FROM jobs WHERE id=$1',[a.job_id]);
  assert.equal(queued.min_tier,99);assert.equal(queued.avoid_model,null);assert.equal(Number(queued.budget_hours),0.5);
  const result=ok(await submit(who,{research:{route_id:r.research.route_id,outcome:'promising',evidence_md:'A small test supports one more experiment.',next_step:step()}},a));
  assert.equal(result.status,'recorded');assert.equal(result.reviews_requested,0);
});

test('frontier hours favor discovery and pursuit even with a large consolidation queue',async()=>{
  await q(`UPDATE problems SET research_allocation=$2 WHERE id=$1`,[pid,JSON.stringify({discover:.3,pursue:.4,rescue:.15,consolidate:.15})]);
  for(const bucket of ['discover','pursue','rescue','consolidate'])await q(`INSERT INTO jobs (problem_id,type,title,brief_md,budget_hours,purpose,research_stage) SELECT $1,'source',$2||n,'Find new evidence.',0.25,$3,$2 FROM generate_series(1,45) n`,[pid,bucket,bucket==='consolidate'?'work':'discovery']);
  let a=await start();const counts={discover:0,pursue:0,rescue:0,consolidate:0};
  for(let i=0;i<40;i++) {
    counts[a.assignment_reason.research_bucket]++;
    ok(await call('/release',{who:'astra',method:'POST',assignment:a,body:{job_id:a.job_id,note:'test allocation'}}));
    if(i<39)a=await start('astra',a);
  }
  assert.ok(counts.discover+counts.pursue>=27,JSON.stringify(counts));
  assert.ok(counts.rescue>=5&&counts.consolidate>=5,JSON.stringify(counts));
  const allocation=await researchAllocation(pid);assert.equal(allocation.total,10);assert.equal(allocation.abandoned,10);
  const stats=ok(await call('/board'));assert.equal(stats.research.hours.total,10);
});

async function packageFor(){
  // This test process stands in for the donor. The application only stores and serves these inert files.
  const code=`import json,sys\nvalues=json.load(open(sys.argv[1]))\nassert values==[1,2,3,4], 'mismatch'\nprint('four terms match')\n# ${slug}\n`;
  const checker=(await files.store(users.author.id,models.author,'check.py','py',code)).sha;
  const target=(await files.store(users.author.id,models.author,'result.json','json','[1,2,3,4]')).sha;
  return {schema_version:1,manifest:[{path:'check.py',sha256:checker,role:'checker'},{path:'result.json',sha256:target,role:'target'}],targets:['result.json'],claim:'The supplied four terms equal 1,2,3,4.',scope:'Terms one through four only.',assumptions:'JSON contains integers.',checker,inputs:[target],environment:'Python 3; no dependencies.',command:'python3 check.py result.json',expected:'four terms match\n',supports:'Compares every supplied term with its definition.',coverage:'decisive',coverage_md:'Exactly four terms; no claim about subsequent terms.',comparison:'Exact stdout and successful comparison of all four values.',availability:{status:'complete',details:'All files are public in the manifest.',network:false,required_sources:[]},cost:{minutes:1,cpu_hours:0.01,ram_gb:1,disk_gb:1}};
}
async function computation(plan,report_md){
  const j=await one(`INSERT INTO jobs (problem_id,type,title,brief_md,budget_hours,min_tier) VALUES ($1,'measure','Measure','Return a result.',4,99) RETURNING id`,[pid]);
  // Claim through the same ownership machinery while selecting this one fixture job deterministically.
  await q(`UPDATE jobs SET priority=10 WHERE id=$1`,[j.id]);const a=await start('author');assert.equal(Number(a.job_id),Number(j.id));
  return ok(await submit('author',{verification_plan:plan,...(report_md?{report_md}:{})},a));
}
async function receipt(a,subjectId,outcome='pass',override={}){
  const subject=ok(await call(`/return/${subjectId}`));
  const stdout=(await files.store(users.runner.id,models.runner,'stdout.txt','txt',outcome==='pass'?'four terms match\n':'mismatch\n')).sha;
  return {check_receipt:{fingerprint:subject.verification_fingerprint,outcome,observed:outcome==='pass'?'four terms match':'mismatch',elapsed_seconds:1,stdout_sha256:stdout,exit_code:outcome==='pass'?0:1,environment:'Python 3.12',coverage_md:'All four supplied terms.',method:'rerun',shared_components_md:'The author supplied the checker and expected output.',controls_md:'Changing a term and removing a term both fail.',...override}};
}

test('finite package reconstructs from served bytes, detects corruption, records execution once and reuses exact evidence',async()=>{
  const plan=await packageFor(),r=await computation(plan);assert.equal(r.check_requested,true);assert.equal(r.reviews_requested,0);
  const clean=mkdtempSync(join(temp,'worker-'));
  for(const f of plan.manifest){const artifact=await fetch(`http://127.0.0.1:${server.address().port}/files/${f.sha256}`);assert.equal(artifact.status,200);writeFileSync(join(clean,f.path),await artifact.text());}
  assert.equal(spawnSync('python3',['check.py','result.json'],{cwd:clean}).status,0);
  writeFileSync(join(clean,'result.json'),'[1,2,9,4]');assert.notEqual(spawnSync('python3',['check.py','result.json'],{cwd:clean}).status,0);
  rmSync(join(clean,'result.json'));assert.notEqual(spawnSync('python3',['check.py','result.json'],{cwd:clean}).status,0);
  const a=await start('runner');assert.equal(a.type,'check');
  assert.equal((await submit('runner',await receipt(a,r.return_id,'pass',{fingerprint:'0'.repeat(64)}),a)).status,400);
  const body=await receipt(a,r.return_id),first=ok(await submit('runner',body,a));assert.deepEqual(ok(await submit('runner',body,a)),first);
  let subject=ok(await call(`/return/${r.return_id}`));assert.equal(subject.status,'pending');assert.equal(subject.verification_runs.length,1);assert.equal(subject.verification_state.execution,'pass');
  const review=await start('judge');assert.equal(review.type,'review');assert.equal(Number((await one('SELECT budget_hours FROM jobs WHERE id=$1',[review.job_id])).budget_hours),.25);
  assert.equal((await submit('judge',{verdict:'accept',rung:'verified'},review)).status,400);
  const receiptId=Number(subject.verification_runs[0].id);
  ok(await submit('judge',{verdict:'accept',rung:'verified',notes_md:'All four terms checked; finite scope only.',verification_receipt_id:receiptId,verification_sufficiency_md:'The checker reads and validates the published four-term target.'},review));
  assert.equal(ok(await call(`/return/${r.return_id}`)).status,'accepted');
  const page=ok(await call(`/return/${r.return_id}`,{accept:'text/html'}));
  assert.ok(page.includes(`Uses execution receipt #${receiptId}.`));
  assert.match(page,/The checker reads and validates the published four-term target/);
  const reused=await computation({...plan,cost:{...plan.cost,minutes:2}});assert.equal(reused.check_requested,false);assert.equal(reused.reviews_requested,0);assert.equal(reused.status,'superseded');assert.equal(reused.canonical_return_id,r.return_id);
  assert.equal(ok(await call('/board')).research.checks.reused_receipts,0);
  const changed=await computation({...plan,scope:'Terms one through ten.'});assert.equal(changed.check_requested,true);
});

test('participants without standing immediately queue assigned and self-assigned claims beyond ten daily admissions',async()=>{
  await q(`INSERT INTO returns (problem_id,user_id,type,model,provider,report_md,transcript,status,review_admitted_at)
    SELECT $1,$2,'explore',$3,'anthropic','Earlier claim','t','rejected',now()
    FROM generate_series(1,12)`,[pid,users.author.id,models.author]);
  const plan=await packageFor(),first=await computation(plan);
  assert.equal(first.review_deferred,false);assert.equal(first.check_requested,true);
  const second=await computation(plan,'A distinct interpretation using exactly the same finite evidence.');
  assert.equal(second.review_deferred,false);assert.equal(second.check_requested,true);
  const direct=ok(await submit('author',{type:'direction'}));
  assert.ok(direct.reviews_requested>0);assert.equal(direct.review_deferred,false);
  const check=await start('runner');assert.equal(check.type,'check');
  ok(await submit('runner',await receipt(check,first.return_id),check));
  for(const r of [first,second]){
    assert.equal(ok(await call(`/return/${r.return_id}`)).status,'pending');
    assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE parent_return_id=$1`,[r.return_id])).n,1);
  }
  assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE problem_id=$1 AND type='check'`,[pid])).n,1,'one execution still serves both claims');
});

test('retired quota deferrals recover in bounded batches without duplicate jobs or elevation of recorded leads',async()=>{
  const result=await computation(await packageFor());
  // Reconstruct the production state left by the retired gate.
  await q(`DELETE FROM jobs WHERE evidence_return_id=$1`,[result.return_id]);
  await q(`UPDATE returns SET review_admitted_at=NULL WHERE id=$1`,[result.return_id]);
  const old=await q(`INSERT INTO returns (problem_id,user_id,type,model,provider,report_md,transcript,status)
    SELECT $1,$2,'direction',$3,'anthropic','A legacy pending claim','t','pending'
    FROM generate_series(1,11) RETURNING id`,[pid,users.author.id,models.author]);
  const lead=await proposed();
  assert.equal(await projectTransaction(pid,()=>resumeDeferredReviews(pid)),10);
  const starts=await Promise.all([start('runner'),start('runner')]);
  const check=starts.find(a=>a.type==='check');assert.ok(check);
  const ids=[result.return_id,...old.map(r=>Number(r.id))];
  assert.equal((await one(`SELECT count(*)::int AS n FROM returns WHERE id=ANY($1::bigint[]) AND review_admitted_at IS NOT NULL`,[ids])).n,12);
  assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE evidence_return_id=$1`,[result.return_id])).n,1);
  const before=await one(`SELECT count(*)::int AS n FROM jobs WHERE problem_id=$1`,[pid]);
  assert.equal(await projectTransaction(pid,()=>resumeDeferredReviews(pid)),0);
  assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE problem_id=$1`,[pid])).n,before.n);
  assert.equal(ok(await call(`/return/${lead.return_id}`)).status,'recorded');
  assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE parent_return_id=$1`,[lead.return_id])).n,0);
  ok(await submit('runner',await receipt(check,result.return_id),check));
  assert.equal(ok(await call(`/return/${result.return_id}`)).review_deferred,false);
});

test('review requests have no daily standing gate and admission does not grant reviewer authority',async()=>{
  const leads=await q(`INSERT INTO returns (problem_id,user_id,type,model,provider,report_md,transcript,status)
    SELECT $1,$2,'explore',$3,'anthropic','A recorded observation','t','recorded'
    FROM generate_series(1,12) RETURNING id`,[pid,users.author.id,models.author]);
  for(const lead of leads){
    const elevated=ok(await call(`/return/${lead.id}/request-review`,{method:'POST',body:{note:'The finite claim now warrants independent review.'}}));
    assert.equal(elevated.status,'pending');assert.ok(elevated.reviews_requested>0);
  }
  assert.equal((await one(`SELECT count(*)::int AS n FROM return_decisions WHERE return_id=ANY($1::bigint[]) AND by='elevate'`,[leads.map(r=>r.id)])).n,12);
  assert.equal((await call(`/return/${leads[0].id}/request-review`,{method:'POST',body:{note:'Retrying the same request.'}})).status,409);
  const participant=await start('author');assert.notEqual(participant.type,'review');
  const trusted=await start('judge');assert.equal(trusted.type,'review');
});

test('sample coverage and older contradictory receipts stay visible; acceptance requires explicit reconciliation',async()=>{
  const plan={...await packageFor(),coverage:'sample',coverage_md:'Only terms one and two were sampled; terms three and four are excluded.'};
  const r=await computation(plan),a=await start('runner');ok(await submit('runner',await receipt(a,r.return_id,'fail'),a));
  // Multiple worker observations of the same package, including a failure older than the display page.
  const subject=ok(await call(`/return/${r.return_id}`));
  await q(`INSERT INTO jobs (problem_id,type,title,brief_md,budget_hours,min_tier,evidence_return_id,research_stage,priority) VALUES ($1,'check','Independent repeat','Run the exact package.',0.1,99,$2,'consolidate',10)`,[pid,r.return_id]);
  const secondCheck=await start('runner');assert.equal(secondCheck.type,'check');
  ok(await submit('runner',await receipt(secondCheck,r.return_id),secondCheck));
  assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE problem_id=$1 AND origin_key LIKE 'check-conflict:%' AND status='queued'`,[pid])).n,1);
  assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE parent_return_id=$1 AND status='queued'`,[r.return_id])).n,1);
  for(let i=0;i<30;i++) {
    const result=await one(`INSERT INTO returns (problem_id,type,user_id,model,provider,report_md,transcript,status) VALUES ($1,'check',$2,$3,'anthropic','Observed pass.','t','recorded') RETURNING id`,[pid,users.runner.id,models.runner]);
    await q(`INSERT INTO verification_runs (subject_return_id,result_return_id,fingerprint,outcome,observed,elapsed_seconds) VALUES ($1,$2,$3,'pass','pass',1)`,[r.return_id,result.id,subject.verification_fingerprint]);
  }
  const state=ok(await call(`/return/${r.return_id}`));assert.equal(state.verification_state.execution,'conflicting');assert.equal(state.verification_state.unresolved_conflict,true);assert.equal(state.verification_runs.length,32);
  const review=await start('judge');const accept={verdict:'accept',rung:'measured',notes_md:'Sample only.',verification_sufficiency_md:'The sample is limited to two terms.'};
  assert.equal((await submit('judge',accept,review)).status,409);
  ok(await submit('judge',{...accept,verification_conflict_resolution_md:'The failed receipt used an incompatible environment; both observations are retained and the conclusion is restricted to the reviewed environment and sample.'},review));
  const after=ok(await call(`/return/${r.return_id}`));assert.equal(after.verification_state.conflict,true);assert.equal(after.verification_state.unresolved_conflict,false);assert.equal(after.verification_plan.coverage,'sample');
  const html=(await call(`/return/${r.return_id}`,{accept:'text/html'})).body;assert.match(html,/terms three and four are excluded/);
});


test('work held during a premise change preserves evidence without restoring stale route state',async()=>{
  const {r}=await activeRoute(),held=await start('author');
  const prerequisite=await one(`INSERT INTO returns (problem_id,type,user_id,model,provider,report_md,transcript,status) VALUES ($1,'source',$2,$3,'anthropic','Premise','t','rejected') RETURNING id`,[pid,users.author.id,models.author]);
  await q(`INSERT INTO research_dependencies (route_id,return_id) VALUES ($1,$2)`,[r.research.route_id,prerequisite.id]);
  await projectTransaction(pid,()=>reconsiderDependents(Number(prerequisite.id),'rejected'));
  const currentSearch=(await one('SELECT prior_art_md FROM research_routes WHERE id=$1',[r.research.route_id])).prior_art_md;
  const result=ok(await submit('author',{research:{route_id:r.research.route_id,outcome:'progress',evidence_md:'These findings predate the changed premise.',prior_art_md:'An outdated search made before the premise changed.',next_step:step('stale'),depends_on:[]}},held));
  assert.equal(result.research.stale,true);assert.equal(result.research.state,'blocked');assert.equal(result.research.next_job_id,null);
  const route=ok(await call(`/research-routes/${r.research.route_id}`));assert.equal(route.dependencies.length,1);assert.equal(route.events[0].outcome,'stale_progress');
  assert.equal(route.prior_art_md,currentSearch,'A stale assignment cannot replace the current search record.');
  await projectTransaction(pid,()=>prepareRescue(pid,models.judge,null));
  assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE research_route_id=$1 AND research_stage='rescue' AND status='queued'`,[r.research.route_id])).n,1);
});

test('identical in-flight contributions share one execution and one judgment',async()=>{
  const plan=await packageFor(),first=await computation(plan),second=await computation(plan);
  assert.equal(first.check_requested,true);assert.equal(second.check_requested,false);assert.equal(second.canonical_return_id,first.return_id);
  assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE problem_id=$1 AND type='check'`,[pid])).n,1);
  const a=await start('runner');ok(await submit('runner',await receipt(a,first.return_id),a));
  assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE problem_id=$1 AND type='review'`,[pid])).n,1);
  const duplicate=ok(await call(`/return/${second.return_id}`));assert.equal(duplicate.verification_runs.length,1);assert.equal(duplicate.verification_runs[0].reused,true);
});

test('an unclassified inability goes to judgment with missing execution and compute needs intact',async()=>{
  const plan=await packageFor(),r=await computation(plan),a=await start('runner');
  const body=await receipt(a,r.return_id,'unable',{stdout_sha256:undefined,exit_code:null,observed:'The declared Python runtime is unavailable; execution did not begin.',coverage_md:'No target records were checked.',controls_md:'Could not run controls because the runtime was missing.'});
  ok(await submit('runner',body,a));
  const record=ok(await call(`/return/${r.return_id}`));assert.equal(record.verification_state.execution,'unable');assert.equal(record.status,'pending');
  assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE evidence_return_id=$1 AND type='check' AND status='queued'`,[r.return_id])).n,0);
  const review=await start('judge');assert.equal(review.type,'review');
  const job=await one('SELECT compute_hint,budget_hours FROM jobs WHERE id=$1',[review.job_id]);
  assert.equal(job.compute_hint.cpu_hours,plan.cost.cpu_hours);assert.equal(Number(job.budget_hours),.25);
});

test('a capability gap gets one targeted reassignment and a completed receipt releases judgment compute',async()=>{
  const plan=await packageFor();plan.cost.minutes=180;
  const longStart=async(who,capabilities)=>ok(await call('/start',{who,method:'POST',launch:randomUUID(),capabilities,body:{agreed:true,ai:{max_hours_per_assignment:4},compute:{cpu_hours:.5,ram_gb:4}}}));
  const r=await computation(plan),a=await longStart('runner');assert.equal(a.type,'check');
  const body=await receipt(a,r.return_id,'unable',{stdout_sha256:undefined,exit_code:null,observed:'This worker lacks Python and access to the declared source.',coverage_md:'Nothing ran.',controls_md:'Not run.',blocker:{kind:'capability',required_tools:['python3'],required_sources:['archive-a']}});
  assert.equal((await submit('runner',{...body,check_receipt:{...body.check_receipt,blocker:{kind:'capability'}}},a)).status,400);
  ok(await submit('runner',body,a));
  const retry=await one(`SELECT * FROM jobs WHERE evidence_return_id=$1 AND type='check' AND status='queued'`,[r.return_id]);
  assert.deepEqual(retry.required_tools,['python3']);assert.deepEqual(retry.required_sources,['archive-a']);
  assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE parent_return_id=$1 AND type='review'`,[r.return_id])).n,0);
  const incapable=await longStart('astra');assert.notEqual(incapable.type,'check');
  const capable={tools:['python3'],sources:['archive-a']};
  const previousWorker=await longStart('runner',capable);
  assert.notEqual(previousWorker.type,'check');
  const ready=await longStart('judge',capable);
  assert.equal(Number(ready.job_id),Number(retry.id));
  ok(await submit('judge',await receipt(ready,r.return_id),ready));
  const review=await one(`SELECT compute_hint,budget_hours FROM jobs WHERE parent_return_id=$1 AND type='review' AND status='queued'`,[r.return_id]);
  assert.deepEqual(review.compute_hint,{});assert.equal(Number(review.budget_hours),.25);
  const subject=ok(await call(`/return/${r.return_id}`));
  assert.equal(subject.verification_state.execution,'pass');assert.equal(subject.verification_runs.length,2);
});

test('a second capability failure stops reassignment and preserves missing execution for judgment',async()=>{
  const plan=await packageFor(),r=await computation(plan),a=await start('runner');
  const unable={stdout_sha256:undefined,exit_code:null,observed:'Required capability is unavailable.',coverage_md:'Nothing ran.',controls_md:'Not run.',blocker:{kind:'capability',required_tools:['python3']}};
  ok(await submit('runner',await receipt(a,r.return_id,'unable',unable),a));
  const ready=ok(await call('/start?share=25',{who:'astra',launch:randomUUID(),capabilities:{tools:['python3']}}));
  assert.equal(ready.type,'check');
  ok(await submit('astra',await receipt(ready,r.return_id,'unable',{...unable,blocker:{kind:'capability',required_tools:['python3','sage']}}),ready));
  assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE evidence_return_id=$1 AND type='check'`,[r.return_id])).n,2);
  assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE evidence_return_id=$1 AND type='check' AND status='queued'`,[r.return_id])).n,0);
  const review=await one(`SELECT compute_hint FROM jobs WHERE parent_return_id=$1 AND type='review' AND status='queued'`,[r.return_id]);
  assert.equal(review.compute_hint.cpu_hours,plan.cost.cpu_hours);
});

test('package defects go directly to judgment and rebudgeting never reruns an identical completed package',async()=>{
  const plan=await packageFor(),r=await computation(plan),a=await start('runner');
  ok(await submit('runner',await receipt(a,r.return_id,'unable',{stdout_sha256:undefined,exit_code:null,observed:'The checker imports an undeclared module.',coverage_md:'Nothing ran.',controls_md:'Not run.',blocker:{kind:'package'}}),a));
  assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE evidence_return_id=$1 AND type='check' AND status='queued'`,[r.return_id])).n,0);
  const broken=await one(`SELECT compute_hint FROM jobs WHERE parent_return_id=$1 AND type='review'`,[r.return_id]);
  assert.equal(broken.compute_hint.cpu_hours,plan.cost.cpu_hours);
  const repaired=await computation({...plan,environment:'Python 3 with the now declared module.'});
  const execution=await start('runner');assert.equal(execution.type,'check');
  ok(await submit('runner',await receipt(execution,repaired.return_id),execution));
  const repairedPlan=ok(await call(`/return/${repaired.return_id}`)).verification_plan;
  const reused=await computation({...repairedPlan,cost:{...repairedPlan.cost,minutes:180,judgment_minutes:60}},'A distinct interpretation requiring its own judgment of the same finite data.');
  assert.equal(reused.check_requested,false);
  const review=await one(`SELECT compute_hint,budget_hours FROM jobs WHERE parent_return_id=$1 AND type='review'`,[reused.return_id]);
  assert.deepEqual(review.compute_hint,{});assert.equal(Number(review.budget_hours),1);
});
