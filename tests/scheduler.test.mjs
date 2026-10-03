import assert from 'node:assert/strict';
import {before, beforeEach, after, afterEach, test} from 'node:test';
import express from 'express';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = 'http://localhost:0';
const {migrate, q, one, pool, transaction, queueFileEffect, flushFileEffects} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job} = await import('../src/routes/job.ts');
const {asks} = await import('../src/routes/asks.ts');
const {board} = await import('../src/routes/board.ts');
const {backlogFor, selectJob, selectRequiredCorrection, allocation, discoveryDue, discoveryShare, workConcentration, ROUTE_REPEAT_PENALTY} = await import('../src/lib/scheduler.ts');
const {parseCapabilities, matchingMetadata} = await import('../src/lib/agent-profile.ts');
const {holdForStepCheck} = await import('../src/lib/research.ts');
const {DUMP_TABLES} = await import('../src/lib/dump.ts');
let server, base, uid, other, token, otherToken, pid, slug;
const tag = `scheduler-${Date.now().toString(36)}`;

before(async () => {
  await migrate(); await migrate(); // additive migration also supports subsequent starts
  uid = Number((await one(`INSERT INTO users (github_id,handle,terms_version,terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000+Math.floor(Math.random()*1e8),tag,TERMS_VERSION])).id);
  other = Number((await one(`INSERT INTO users (github_id,handle,terms_version,terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000+Math.floor(Math.random()*1e8),tag+'-other',TERMS_VERSION])).id);
  token = await issueToken(uid); otherToken = await issueToken(other);
  const app = express(); app.use(express.json()); app.use('/projects/:slug',job,asks,board);
  app.use((error,req,res,next) => res.status(500).json({error: error.message}));
  server = app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
});
beforeEach(async () => {
  slug = tag+'-'+randomUUID().slice(0,8);
  pid = Number((await one(`INSERT INTO problems (slug,name,repo_url,status_md,discovery_share) VALUES ($1,'Scheduler test','https://example.org/r','open',0) RETURNING id`,[slug])).id);
  await q(`INSERT INTO channels (problem_id,path,title) VALUES ($1,'','Project')`,[pid]);
  base = `http://127.0.0.1:${server.address().port}/projects/${slug}`;
});
afterEach(async () => {
  await q(`DELETE FROM document_versions WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM document_publications WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM file_refs WHERE file_sha IN (SELECT sha256 FROM files WHERE user_id=ANY($1))`,[[uid,other]]);
  await q(`DELETE FROM files WHERE user_id=ANY($1)`,[[uid,other]]);
  await q(`DELETE FROM findings WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM asks WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE problem_id=$1)`,[pid]);
  await q(`DELETE FROM channel_members WHERE channel_id IN (SELECT id FROM channels WHERE problem_id=$1)`,[pid]);
  await q(`DELETE FROM credits WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM counted_entries WHERE user_id = ANY($1)`,[[uid,other]]);
  await q(`DELETE FROM reviews WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`,[pid]);
  await q(`DELETE FROM return_decisions WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`,[pid]);
  await q(`UPDATE returns SET job_id=NULL WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM jobs WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM returns WHERE problem_id=$1`,[pid]);
  for (const table of ['project_roles','sessions','pool','channels']) await q(`DELETE FROM ${table} WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM problems WHERE id=$1`,[pid]);
});

test('concurrent one-task launches reserve bounded trusted repairs despite an overallocated consolidation portfolio',async()=>{
  await q(`INSERT INTO project_roles(problem_id,user_id,role,note) VALUES ($1,$2,'trusted','repair fixture')`,[pid,uid]);
  await q(`UPDATE problems SET research_allocation='{"discover":0.3,"pursue":0.4,"rescue":0.15,"consolidate":0.15}' WHERE id=$1`,[pid]);
  // Historical consolidation made every live-batch registration choose pursuit.
  const past=await one(`INSERT INTO sessions(id,problem_id,user_id,model,started_at,ended_at) VALUES ($1,$2,$3,'claude-fable-5-1',now(),now()) RETURNING id`,[randomUUID(),pid,uid]);
  const done=await queued({type:'audit'});await q(`UPDATE jobs SET status='accepted' WHERE id=$1`,[done.id]);
  await q(`INSERT INTO assignment_attempts(id,job_id,problem_id,session_id,user_id,model,tier,purpose,scheduled,budget_hours,reason,research_stage,status) VALUES ($1,$2,$3,$4,$5,'claude-fable-5-1',1,'work',true,95,'{}','consolidate','completed')`,[randomUUID().replaceAll('-',''),done.id,pid,past.id,uid]);
  const author=await one(`INSERT INTO returns(problem_id,type,user_id,model,provider,report_md,transcript,status) VALUES ($1,'audit',$2,'claude-opus-5','anthropic','Established correction.','t','accepted') RETURNING id`,[pid,other]);
  for(let i=0;i<5;i++){
    const j=await queued({type:'audit'});await q(`UPDATE jobs SET min_tier=1,requires_trust=true WHERE id=$1`,[j.id]);
    await q(`INSERT INTO findings(problem_id,path,return_id,note,scope,job_id) VALUES ($1,$2,$3,'Correct the false clause.','before_circulation',$4)`,[pid,`paper/repair-${i}.md`,author.id,j.id]);
  }
  for(let i=0;i<15;i++)await queued({type:'explore',purpose:'discovery'});
  const agent={problemId:pid,slug,sessionId:'fixture-reserve',uid,tier:1,model:'claude-fable-5-1',provider:'anthropic',trusted:true,granted:true,lane:null,cpuHours:4,ramGb:8,hasGpu:false,disk:1,maxHours:2,reviewStreak:0,capabilities:{}};
  for (const override of [{trusted:false},{tier:2},{directionId:1},{jobId:1}]) assert.equal(await selectRequiredCorrection({...agent,...override}),null);
  await q(`UPDATE findings SET scope='advisory' WHERE problem_id=$1`,[pid]);
  assert.equal(await selectRequiredCorrection(agent),null,'advisory findings never receive reserved repair work');
  await q(`UPDATE findings SET scope='before_circulation' WHERE problem_id=$1`,[pid]);

  const assignments=await Promise.all(Array.from({length:10},()=>start()));
  const repairs=assignments.filter(a=>a.assignment_reason.policy==='required correction');
  assert.equal(repairs.length,3,'one reserve at positions 1, 5 and 9, shared by concurrent launches');
  assert.equal(new Set(assignments.map(a=>a.job_id)).size,10);
  assert.ok(repairs.every(a=>a.type==='audit'&&a.assignment_reason.required_correction));
  assert.ok(assignments.filter(a=>!repairs.includes(a)).every(a=>a.type==='explore'));
});
after(async () => {
  await new Promise(r=>server.close(r));
  for (const table of ['tokens','reputation']) await q(`DELETE FROM ${table} WHERE user_id=ANY($1)`,[[uid,other]]);
  await q(`DELETE FROM users WHERE id=ANY($1)`,[[uid,other]]);
  await pool.end();
});
async function call(path,{method='GET',session,attempt,launch,model='claude-fable-5-1',effort='max',capabilities,body,who=token}={}) {
  const h={authorization:`Bearer ${who}`,accept:'application/json','content-type':'application/json'};
  if(model)h['x-model']=model;if(effort)h['x-effort']=effort;if(session)h['x-session']=session;
  if(attempt)h['x-attempt']=attempt;if(launch)h['x-launch-id']=launch;if(capabilities)h['x-capabilities']=JSON.stringify(capabilities);
  const res=await fetch(base+path,{method,headers:h,body:body?JSON.stringify(body):undefined});
  return {status:res.status,body:await res.json()};
}
const ok = r => {assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
const start = async opts => ok(await call('/start?share=0',{launch:randomUUID(),...opts}));
const release = a => call('/release',{method:'POST',session:a.session,attempt:a.attempt_id,body:{job_id:a.job_id,note:'test complete'}});
const result = (a,body={}) => call('/result',{method:'POST',session:a.session,attempt:a.attempt_id,body:{job_id:a.job_id,report_md:'A bounded evidence note with uncertainty.',transcript:'t',transcript_approved:true,...body}});
async function queued({type='source',purpose='work',hours=1,tools=[],sources=[],skills=[],priority=0,age=0}={}) {
  return one(`INSERT INTO jobs (problem_id,type,title,brief_md,git_ref,budget_hours,min_tier,required_tools,required_sources,preferred_skills,priority,purpose,created_at) VALUES ($1,$2,$3,'Find the evidence.','main',$4,99,$5,$6,$7,$8,$9,now()-($10::int*interval '1 day')) RETURNING *`,[pid,type,`Test ${randomUUID()}`,hours,tools,sources,skills,priority,purpose,age]);
}

async function runtimeRouteFixture({paths=[],prepare}={}) {
  const step={question:'One bounded question',method:'A frozen producer',success:'Exact certificate',failure:'Counterexample',budget_hours:1};
  const origin=await one(`INSERT INTO returns(problem_id,type,user_id,model,provider,report_md,transcript,status,research) VALUES ($1,'explore',$2,'gpt-6-astra','test','Source','t','accepted',$3) RETURNING id`,[pid,other,JSON.stringify({outcome:'progress',next_step:step})]);
  const route=await one(`INSERT INTO research_routes(problem_id,origin_return_id,title,contribution_md,prior_art_md,uncertainty_md,state,next_step) VALUES ($1,$2,'Runtime fixture','c','p','u','active',$3) RETURNING id`,[pid,origin.id,JSON.stringify(step)]);
  await q('UPDATE returns SET research_route_id=$2 WHERE id=$1',[origin.id,route.id]);
  const j=await queued({type:'explore',priority:10});await q(`UPDATE jobs SET research_route_id=$2,research_source_return_id=$3,research_stage='first_look' WHERE id=$1`,[j.id,route.id,origin.id]);
  if(prepare)await prepare({origin,route,j,step});
  const capabilities={tools:['python3'],execution:{cpu_seconds:10,wall_seconds:20,publication_context_privacy:'export-v1'}};
  const a=ok(await call(`/start?share=0&job=${j.id}`,{launch:randomUUID(),capabilities}));assert.equal(Number(a.job_id),Number(j.id));
  const body={job_id:a.job_id,deferral:{kind:'execution',fit_scope:'runtime',source_scope:'task',source_paths:paths,evidence_md:'This frozen producer exceeds the measured controls.',reopen_when:'Actual sources or runtime controls change.'}};
  const opts={method:'POST',session:a.session,attempt:a.attempt_id,body};const receipt=ok(await call('/release',opts));
  assert.deepEqual(ok(await call('/release',opts)),receipt);
  const stored=await one('SELECT * FROM assignment_deferrals WHERE attempt_id=$1',[a.attempt_id]);
  assert.equal(stored.source_scope,'task');assert.ok(stored.task_source_epoch);
  const b=await start({capabilities});assert.notEqual(Number(b.job_id),Number(j.id));ok(await release(b));
  const originalSession=await one('SELECT capabilities,department_id FROM sessions WHERE id=$1',[b.session]);
  const agent={problemId:pid,slug,sessionId:b.session,uid,tier:1,model:'claude-fable-5-1',provider:'anthropic',trusted:true,granted:true,lane:null,cpuHours:0,ramGb:0,hasGpu:false,disk:5,maxHours:2,reviewStreak:0,capabilities};
  assert.ok(!await selectJob(agent,false));
  return {origin,route,j,step,a,b,agent,stored,opts,receipt,originalSession};
}

test('explicit task-source runtime checkpoints ignore unrelated publications and reopen for watched versions or controls',async()=>{
  const f=await runtimeRouteFixture({paths:['research/producer.py']});
  await q(`INSERT INTO document_publications(problem_id,path,sha256) VALUES ($1,'research/unrelated.md',$2)`,[pid,'a'.repeat(64)]);
  await q(`INSERT INTO document_versions(problem_id,path,version,content_sha) VALUES ($1,'research/unrelated.md',1,$2)`,[pid,'b'.repeat(64)]);
  assert.ok(!await selectJob(f.agent,false),'unrelated prose no longer reopens a runtime checkpoint');
  assert.equal(Number((await selectJob({...f.agent,jobId:Number(f.j.id)},false)).id),Number(f.j.id),'human directed job still works');
  await q(`UPDATE sessions SET capabilities=jsonb_set(capabilities,'{execution,cpu_seconds}','20') WHERE id=$1`,[f.b.session]);
  assert.equal(Number((await selectJob(f.agent,false)).id),Number(f.j.id),'real runtime change reopens');
  await q(`UPDATE sessions SET capabilities=$2 WHERE id=$1`,[f.b.session,JSON.stringify(f.originalSession.capabilities)]);
  const department=randomUUID();
  await q(`INSERT INTO departments(id,user_id,registration_key) VALUES ($1,$2,$3)`,[department,uid,randomUUID()]);
  await q(`UPDATE sessions SET department_id=$2 WHERE id=$1`,[f.b.session,department]);
  assert.equal(Number((await selectJob(f.agent,false)).id),Number(f.j.id),'another department is not blocked');
  await q(`UPDATE sessions SET department_id=$2 WHERE id=$1`,[f.b.session,f.originalSession.department_id]);
  await q(`DELETE FROM departments WHERE id=$1`,[department]);
  assert.ok(!await selectJob(f.agent,false));
  await q(`INSERT INTO document_versions(problem_id,path,version,content_sha,created_at) VALUES ($1,'research/producer.py',1,$2,'2000-01-01')`,[pid,'c'.repeat(64)]);
  assert.equal(Number((await selectJob(f.agent,false)).id),Number(f.j.id),'missing watched producer appearing reopens despite older timestamp');
  assert.deepEqual(await one('SELECT * FROM assignment_deferrals WHERE id=$1',[f.stored.id]),f.stored,'original checkpoint is unchanged');
  assert.deepEqual((await one('SELECT receipt FROM assignment_attempts WHERE id=$1',[f.a.attempt_id])).receipt,f.receipt);
});

test('task-source checkpoints reuse unchanged comparisons but detect material route evidence and newly linked old sources',async()=>{
  let foreign;
  const f=await runtimeRouteFixture({prepare:async()=>{
    foreign=await one(`INSERT INTO returns(problem_id,type,user_id,model,provider,report_md,transcript,status,research) VALUES ($1,'explore',$2,'gpt-6-astra','test','Old unlinked source','t','recorded','{"outcome":"progress"}') RETURNING id`,[pid,other]);
    const rr=await one(`INSERT INTO research_routes(problem_id,origin_return_id,title,contribution_md,prior_art_md,uncertainty_md,state) VALUES ($1,$2,'Other route','c','p','u','active') RETURNING id`,[pid,foreign.id]);
    await q('UPDATE returns SET research_route_id=$2 WHERE id=$1',[foreign.id,rr.id]);
  }});
  const comparison=await queued({type:'explore'});await q(`UPDATE jobs SET status='returned',step_check_of=$2,research_source_return_id=$3 WHERE id=$1`,[comparison.id,f.j.id,f.origin.id]);
  const ret=await one(`INSERT INTO returns(problem_id,type,user_id,model,provider,job_id,research_route_id,report_md,transcript,status,research) VALUES ($1,'explore',$2,'gpt-6-astra','test',$3,$4,'Same step','t','recorded',$5) RETURNING id`,[pid,other,comparison.id,f.route.id,JSON.stringify({outcome:'promising',next_step:f.step})]);
  assert.ok(!await selectJob(f.agent,false),'unchanged promising comparison is not new evidence');
  await q('UPDATE returns SET cites=$2 WHERE id=$1',[foreign.id,JSON.stringify({returns:[Number(f.origin.id)]})]);
  assert.equal(Number((await selectJob(f.agent,false)).id),Number(f.j.id),'an older newly linked material source is visible');
  await q(`UPDATE returns SET cites='{}' WHERE id=$1`,[foreign.id]);assert.ok(!await selectJob(f.agent,false));
  await q('UPDATE returns SET research=$2 WHERE id=$1',[ret.id,JSON.stringify({outcome:'progress',next_step:{...f.step,method:'A bounded replacement'}})]);
  assert.equal(Number((await selectJob(f.agent,false)).id),Number(f.j.id),'changed method/progress reopens focused work');
});

test('actual unchanged step-check completion preserves a task runtime checkpoint and serves its comparison note',async()=>{
  const f=await runtimeRouteFixture({prepare:async({route,j,step})=>{
    const key=createHash('sha256').update(JSON.stringify([step.question,step.method,step.success,step.failure])).digest('hex');
    await q(`UPDATE jobs SET research_stage='pursue',origin_key=$2 WHERE id=$1`,[j.id,`pursue:${route.id}:${key}`]);
  }});
  await q(`UPDATE jobs SET created_at=now()-interval '4 days' WHERE id=$1`,[f.j.id]);
  const check=await transaction(async()=>holdForStepCheck(await one('SELECT * FROM jobs WHERE id=$1',[f.j.id])));
  assert.ok(check,'another eligible department can perform the aged step comparison');
  const a=ok(await call(`/start?share=0&job=${check.id}`,{who:otherToken,model:'gpt-6-astra',launch:randomUUID()}));
  const ret=ok(await call('/result',{method:'POST',who:otherToken,model:'gpt-6-astra',session:a.session,attempt:a.attempt_id,
    body:{job_id:a.job_id,report_md:'Only the issued step was compared; no new producer or evidence.',transcript:'t',transcript_approved:true,
      research:{route_id:Number(f.route.id),outcome:'promising',evidence_md:'Exact experiment unchanged; reuse the previous evidence.',next_step:f.step,depends_on:[Number(f.origin.id)]}}}));
  const held=await one('SELECT * FROM jobs WHERE id=$1',[f.j.id]);
  assert.equal(held.status,'queued');assert.equal(Number(held.step_checked_through),Number(ret.return_id));
  assert.ok(!await selectJob(f.agent,false),'certificate and comparison notes must not reopen the unchanged runtime task');
  assert.deepEqual(await one('SELECT * FROM assignment_deferrals WHERE id=$1',[f.stored.id]),f.stored,'checkpoint history is immutable');
  const page=ok(await call(`/job/${f.j.id}`));assert.match(page.brief_md,new RegExp(`Step check: return #${ret.return_id}`),'the new evidence note is still served');
  const dumped=(await q(DUMP_TABLES.jobs)).find(j=>Number(j.id)===Number(f.j.id));
  assert.equal(dumped.brief_md,f.j.brief_md);assert.match(dumped.step_check_notes_md,new RegExp(`Step check: return #${ret.return_id}`),'public export retains comparison provenance separately');
  await q(`UPDATE jobs SET brief_md=brief_md||' A genuinely changed task instruction.' WHERE id=$1`,[f.j.id]);
  assert.equal(Number((await selectJob(f.agent,false)).id),Number(f.j.id),'actual task instructions still permit a focused revisit');
});

test('task-source snapshots include artifacts outside the twelve displayed candidates and supersede only comparable older runtime checkpoints',async()=>{
  let older;
  const f=await runtimeRouteFixture({prepare:async({route,j})=>{
    for(let i=0;i<13;i++){
      const r=await one(`INSERT INTO returns(problem_id,type,user_id,model,provider,research_route_id,report_md,transcript,status) VALUES ($1,'explore',$2,'gpt-6-astra','test',$3,'Existing evidence','t','recorded') RETURNING id`,[pid,other,route.id]);
      older??=r;
    }
    // An earlier runtime checkpoint may share the current project epoch; it must not veto this explicit successor's new evidence.
    const a=await start({capabilities:{tools:['python3'],execution:{cpu_seconds:10,wall_seconds:20,publication_context_privacy:'export-v1'}}});
    ok(await call('/release',{method:'POST',session:a.session,attempt:a.attempt_id,body:{job_id:a.job_id,deferral:{kind:'execution',fit_scope:'runtime',evidence_md:'Earlier project-wide checkpoint.',reopen_when:'A bounded alternative appears.'}}}));
    // The fixture's explicit directed registration obtains a new original attempt;
    // the older release and project-wide snapshot stay byte-for-byte unchanged.
  }});
  const before=await q('SELECT id,source_epoch,session_fit,source_scope FROM assignment_deferrals WHERE job_id=$1 ORDER BY id',[f.j.id]);assert.equal(before.length,2);
  const sha=randomUUID().replaceAll('-','').padEnd(64,'0');
  await q(`INSERT INTO files(sha256,user_id,name,ext,bytes) VALUES ($1,$2,'bounded.py','py',1)`,[sha,other]);
  await q(`INSERT INTO file_refs(file_sha,ref_type,ref_id) VALUES ($1,'return',$2)`,[sha,older.id]);
  assert.equal(Number((await selectJob(f.agent,false)).id),Number(f.j.id),'a supplemental bounded producer on an older material return reopens');
  assert.deepEqual(await q('SELECT id,source_epoch,session_fit,source_scope FROM assignment_deferrals WHERE job_id=$1 ORDER BY id',[f.j.id]),before,'history is not rewritten');
});

test('task-source opt-in refuses invalid or ambiguous declarations without releasing the original attempt',async()=>{
  const j=await queued({priority:10});const a=await start();
  for(const d of [
    {source_scope:'invalid'},
    {source_scope:'task'},
    {source_scope:'task',source_paths:[]},
    {fit_scope:'runtime',source_scope:'task',source_paths:['../private']},
    {fit_scope:'runtime',source_scope:'task',source_paths:['research/a\u0000.md']},
    {fit_scope:'runtime',source_scope:'task',source_paths:[]},
    {source_paths:[]},
  ])assert.equal((await call('/release',{method:'POST',session:a.session,attempt:a.attempt_id,body:{job_id:j.id,deferral:{kind:'execution',evidence_md:'A real blocker.',reopen_when:'Changed controls.',...d}}})).status,400);
  assert.equal((await one('SELECT status FROM assignment_attempts WHERE id=$1',[a.attempt_id])).status,'assigned');
  assert.equal((await one('SELECT count(*) AS n FROM assignment_deferrals WHERE job_id=$1',[j.id])).n,'0');
  ok(await release(a));
});

test('historical checkpoint imports reject scoped batches before writes and report duplicate application accurately',async()=>{
  const j=await queued({priority:10});const a=await start();assert.equal(Number(a.job_id),Number(j.id));ok(await release(a));
  const receipt=await one('SELECT status,receipt FROM assignment_attempts WHERE id=$1',[a.attempt_id]);
  const item={attempt_id:a.attempt_id,job_id:Number(j.id),kind:'execution',evidence_md:'Reviewed historical source checkpoint.',reopen_when:'Changed source or controls.'};
  const dir=mkdtempSync(join(tmpdir(),'sah-historical-checkpoint-')),file=join(dir,'input.json');
  const run=async(rows,apply=true)=>{
    writeFileSync(file,JSON.stringify(rows),{mode:0o600});
    const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','scripts/import-terminal-deferrals.ts',file,...(apply?['--apply']:[])],{env:process.env,timeout:15000,maxBuffer:1048576});
    return JSON.parse(stdout.trim());
  };
  try {
    for (const scoped of [{fit_scope:'runtime'},{fit_scope:'publication'},{fit_scope:'runtime',source_scope:'task',source_paths:[]}]) {
      await assert.rejects(run([item,{...item,...scoped}]),e=>/Historical imports require legacy fit and project source scope/.test(e.stderr));
      assert.equal((await one('SELECT count(*) AS n FROM assignment_deferrals WHERE attempt_id=$1',[a.attempt_id])).n,'0','a later invalid scope must not partly import earlier items');
    }
    const deferredFailure=`checkpoint_commit_${randomUUID().replaceAll('-','')}`;
    await q(`CREATE FUNCTION ${deferredFailure}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture deferred commit failure'; RETURN NEW; END $$`);
    try {
      await q(`CREATE CONSTRAINT TRIGGER ${deferredFailure} AFTER INSERT ON assignment_deferrals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.job_id=${Number(j.id)}) EXECUTE FUNCTION ${deferredFailure}()`);
      await assert.rejects(run([item]),e=>/fixture deferred commit failure/.test(e.stderr) && e.stdout.trim()==='','a failed commit must never emit an applied-success report');
      assert.equal((await one('SELECT count(*) AS n FROM assignment_deferrals WHERE attempt_id=$1',[a.attempt_id])).n,'0','failed commit leaves no checkpoint');
    } finally {
      await q(`DROP TRIGGER IF EXISTS ${deferredFailure} ON assignment_deferrals`);
      await q(`DROP FUNCTION ${deferredFailure}()`);
    }
    const first=await run([item]);assert.equal(first.applied,true);assert.equal(first.already_recorded,false);
    assert.equal(first.requested_fit_scope,'legacy');assert.equal(first.requested_source_scope,'project');
    const stored=await one('SELECT * FROM assignment_deferrals WHERE attempt_id=$1',[a.attempt_id]);
    const duplicate=await run([item]);assert.equal(duplicate.applied,false);assert.equal(duplicate.already_recorded,true);
    assert.deepEqual(duplicate.checkpoint_scope,{kind:'execution',fit_scope:'legacy',source_scope:'project'});
    const dry=await run([item],false);assert.equal(dry.applied,false);assert.equal(dry.already_recorded,true);
    assert.deepEqual(await one('SELECT * FROM assignment_deferrals WHERE attempt_id=$1',[a.attempt_id]),stored,'historical checkpoint and full original fit remain unchanged');
    assert.deepEqual(await one('SELECT status,receipt FROM assignment_attempts WHERE id=$1',[a.attempt_id]),receipt,'no terminal attempt is released again or reclassified');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('one pasted URL, concurrent bootstrap retries, one capped assignment and stable settings',async()=>{
  for(let i=0;i<4;i++)await queued();
  const launch=randomUUID();
  const results=await Promise.all(Array.from({length:5},()=>call('/start?time=1task&subagents=no&share=0&disk=1&directions=0',{launch,capabilities:{name:'Researcher',skills:['Literature-Search']}})));
  const a=ok(results[0]);for(const r of results)assert.deepEqual(ok(r),a);
  assert.equal((await one(`SELECT count(*) AS n FROM sessions WHERE problem_id=$1`,[pid])).n,'1');
  assert.equal((await one(`SELECT count(*) AS n FROM assignment_attempts WHERE problem_id=$1`,[pid])).n,'1');
  const s=await one(`SELECT * FROM sessions WHERE id=$1`,[a.session]);
  assert.equal(s.jobs,1);assert.equal(s.max_jobs,1);assert.equal(s.ai.subagents.allowed,false);
  assert.deepEqual(s.capabilities.skills,['literature-search']);assert.equal(s.contact_id,null);
  assert.deepEqual(ok(await call('/start?time=continuous&share=100',{launch})),a,'retry must preserve the original limits');
  ok(await result(a));
  assert.equal((await call('/start',{session:a.session})).status,409);
});

test('a capped issued discovery repairs an older generated continuation footer and preserves its task record',async()=>{
  const j=await queued({type:'explore'});
  const text=`Compare the accepted finite certificates. Then call \`GET ${process.env.BASE_URL}/projects/${slug}/start\` once. Do not poll.`;
  await q("UPDATE jobs SET origin_key='lead:synthesis:old-footer',brief_md=$2 WHERE id=$1",[j.id,text]);
  const a=await start({});
  // This first session is uncapped: the reusable queued task's donor-independent text stays stored.
  assert.equal(Number(a.job_id),Number(j.id));ok(await release(a));
  const capped=ok(await call('/start?time=1task&share=0',{launch:randomUUID()}));
  assert.equal(Number(capped.job_id),Number(j.id));
  assert.match(capped.brief_md,/After the verified result or owned release, stop/);
  assert.doesNotMatch(capped.brief_md,/Then call `GET .*\/start` once/);
  assert.equal((await one('SELECT brief_md FROM jobs WHERE id=$1',[j.id])).brief_md,text);
  assert.deepEqual(ok(await call('/start',{session:capped.session})),capped,'issued receipt remains unchanged');
});

test('concurrent results replay once; changed or missing attempt and wrong-session requests cannot mutate work',async()=>{
  await queued();const a=await start();
  assert.equal((await call('/result',{method:'POST',session:a.session,body:{job_id:a.job_id,report_md:'x',transcript:'t'}})).status,400);
  const sibling=await start();
  assert.equal((await call('/release',{method:'POST',session:sibling.session,attempt:a.attempt_id,body:{job_id:a.job_id}})).status,403);
  assert.equal((await call('/release',{method:'POST',session:'missing-session',attempt:a.attempt_id,body:{job_id:a.job_id}})).status,403);
  assert.equal((await call('/release',{method:'POST',attempt:a.attempt_id,body:{job_id:a.job_id}})).status,403);
  const responses=await Promise.all(Array.from({length:4},()=>result(a)));
  const receipt=ok(responses[0]);responses.forEach(r=>assert.deepEqual(ok(r),receipt));
  assert.equal((await one(`SELECT count(*) AS n FROM returns WHERE job_id=$1`,[a.job_id])).n,'1');
  assert.equal((await result(a,{report_md:'changed'})).status,409);
  assert.deepEqual(ok(await result(a)),receipt);
});

test('a late validation failure rolls back return, credits and claim state, then corrected input succeeds',async()=>{
  await queued();const a=await start();
  const rejected=await result(a,{files:['f'.repeat(64)]});assert.equal(rejected.status,400,JSON.stringify(rejected));
  assert.equal((await one(`SELECT count(*) AS n FROM returns WHERE job_id=$1`,[a.job_id])).n,'0');
  assert.equal((await one(`SELECT status FROM jobs WHERE id=$1`,[a.job_id])).status,'assigned');
  assert.equal((await one(`SELECT receipt FROM assignment_attempts WHERE id=$1`,[a.attempt_id])).receipt,null);
  ok(await result(a));
});

test('release retries are idempotent even after reassignment; prior agent cannot reacquire its released job',async()=>{
  const j=await queued();const a=await start();const receipt=ok(await release(a));
  assert.deepEqual(ok(await release(a)),receipt);
  const b=await start();assert.equal(b.job_id,j.id);assert.notEqual(a.attempt_id,b.attempt_id);
  assert.deepEqual(ok(await release(a)),receipt);
  assert.equal((await one(`SELECT status FROM jobs WHERE id=$1`,[j.id])).status,'assigned');
  assert.equal((await result(a)).status,409);
  ok(await release(b));const c=ok(await call('/start',{session:a.session,effort:null}));
  assert.notEqual(c.job_id,j.id);assert.equal(c.assignment_reason.tier,1);
  assert.equal((await one(`SELECT effort FROM sessions WHERE id=$1`,[a.session])).effort,'max');
});

test('queue matching shares hard eligibility between backlog and choice, then rewards skills and waiting time',async()=>{
  const j=await queued({skills:['lean'],type:'formalize',tools:['lean']});
  await queued({sources:['private-archive'],priority:10});
  const plain=await queued();
  const a={problemId:pid,slug,sessionId:'synthetic',uid,tier:2,model:'test-model',provider:'test',trusted:false,granted:false,lane:null,cpuHours:0,ramGb:0,hasGpu:false,disk:1,maxHours:2,reviewStreak:0,capabilities:{}};
  assert.deepEqual(await backlogFor(a),{reviews:0,research:1,blocked_reviews:0});assert.equal((await selectJob(a,false)).id,plain.id);
  a.capabilities={tools:['lean'],skills:['lean']};
  assert.deepEqual(await backlogFor(a),{reviews:0,research:2,blocked_reviews:0});assert.equal((await selectJob(a,false)).id,j.id);
  const old=await queued({age:400});assert.equal((await selectJob(a,false)).id,old.id,'age eventually overtakes bounded matching terms');
  const live=await start({capabilities:a.capabilities});assert.equal(live.job_id,old.id);
});

test('20% discovery continues while verification is busy and concurrent claims cannot all spend the reserve',async()=>{
  await q(`UPDATE problems SET discovery_share=NULL WHERE id=$1`,[pid]);
  for(let i=0;i<10;i++)await queued({type:'audit',hours:2});
  const claims=await Promise.all(Array.from({length:10},()=>start()));
  assert.equal(claims.filter(a=>a.purpose==='discovery').length,2);
  assert.equal(claims.filter(a=>a.type==='audit').length,8);
  assert.equal(new Set(claims.map(a=>a.job_id)).size,10);
  const used=await allocation(pid);assert.deepEqual([used.total,used.discovery],[20,4]);
  const stats=ok(await call('/scheduler'));assert.equal(stats.discovery_share,0.2);assert.equal(stats.unit,'budgeted agent hours');
  assert.equal((await one(`SELECT count(*) AS n FROM jobs WHERE problem_id=$1 AND type='audit' AND status='queued'`,[pid])).n,'2');
});

test('runtime aliases match existing sessions without implying versions, source access or tools from skills',async()=>{
  const legacy=await start({capabilities:{tools:['python'],skills:['python','lean']}});
  ok(await release(legacy));
  const pursuit=await queued({type:'explore',purpose:'discovery',tools:['python3']});
  await q(`UPDATE jobs SET research_stage='pursue' WHERE id=$1`,[pursuit.id]);
  const next=ok(await call('/start',{session:legacy.session}));
  assert.equal(next.job_id,pursuit.id,'a pre-existing python declaration can advance a python3 pursuit');
  assert.deepEqual((await one(`SELECT capabilities FROM sessions WHERE id=$1`,[legacy.session])).capabilities.tools,['python']);

  const python=await queued({tools:['python']});
  const node=await queued({tools:['nodejs']});
  await queued({tools:['python2']});await queued({tools:['python3.12']});
  await queued({tools:['lean']});await queued({tools:['bash']});
  await queued({sources:['python3']});
  const a={problemId:pid,slug,sessionId:legacy.session,uid,tier:3,model:'test-model',provider:'test',trusted:false,granted:false,lane:null,cpuHours:0,ramGb:0,hasGpu:false,disk:1,maxHours:2,reviewStreak:0,capabilities:{skills:['python','lean'],tools:['shell']}};
  assert.deepEqual(await backlogFor(a),{reviews:0,research:0,blocked_reviews:0});
  a.capabilities.tools=['python3'];assert.deepEqual(await backlogFor(a),{reviews:0,research:1,blocked_reviews:0});
  assert.equal((await selectJob(a,false)).id,python.id);
  a.capabilities.tools=['node'];assert.deepEqual(await backlogFor(a),{reviews:0,research:1,blocked_reviews:0});
  assert.equal((await selectJob(a,false)).id,node.id);
});

test('JSON hash arrays remain JSON and do not become PostgreSQL array literals on submission',async()=>{
  await queued();const a=await start();
  const hashes=['a'.repeat(64),{stdout:'b'.repeat(64)}];
  const returned=ok(await result(a,{hashes}));
  assert.deepEqual((await one(`SELECT hashes FROM returns WHERE id=$1`,[returned.return_id])).hashes,hashes);
  assert.deepEqual(ok(await result(a,{hashes})),returned,'retry preserves the completion receipt');
});

test('allocation uses bounded hours and keeps abandonment visible; routine work cannot masquerade as discovery',async()=>{
  await q(`UPDATE problems SET discovery_share=0.2 WHERE id=$1`,[pid]);
  await queued({type:'audit',hours:4});
  const a=ok(await call('/start',{method:'POST',launch:randomUUID(),body:{agreed:true,ai:{max_hours_per_assignment:0.25},transcript_preapproved:true}}));
  assert.equal(a.purpose,'discovery');assert.equal((await allocation(pid)).discovery,0.25);
  ok(await release(a));const used=await allocation(pid);assert.equal(used.abandoned_discovery,0.25);
  assert.equal(discoveryDue(0.2,used,2),true);assert.equal(discoveryDue(0.2,used,0.25),false);
  assert.throws(()=>matchingMetadata({type:'audit',purpose:'discovery'}));
  await assert.rejects(()=>queued({type:'review',purpose:'discovery'}));
  assert.equal(discoveryShare(slug,0),0);assert.equal(discoveryShare(slug,1),1);
});

test('empty typed work still discovers new leads; released generated questions are not handed straight back',async()=>{
  const a=await start();ok(await release(a));
  const b=ok(await call('/start',{session:a.session}));assert.notEqual(b.job_id,a.job_id);
  const ja=await one(`SELECT origin_key FROM jobs WHERE id=$1`,[a.job_id]);const jb=await one(`SELECT origin_key FROM jobs WHERE id=$1`,[b.job_id]);
  assert.notEqual(ja.origin_key,jb.origin_key);assert.match(b.brief_md,/lead hunt|Your question/);
});

test('only declared research agents are contacts; same-owner asks reach exactly the named agent',async()=>{
  const ordinary=await start();
  const expert=await start({capabilities:{name:'Archive reader',sources:['archive-a'],research:'I can inspect the local research archive.'}});
  const sibling=await start({capabilities:{skills:['python']}});
  const who=ok(await call('/who'));assert.deepEqual(who.contacts.map(c=>c.contact_id),[expert.contact_id]);
  assert.notEqual(expert.contact_id,expert.session);assert.equal(JSON.stringify(who).includes(expert.session),false);
  const ask=ok(await call('/asks',{method:'POST',session:ordinary.session,body:{to_contact:expert.contact_id,body_md:'Which page supports the estimate?',job_id:ordinary.job_id}}));
  assert.equal(ok(await call('/inbox',{session:expert.session})).asks_for_you.length,1);
  assert.equal(ok(await call('/inbox',{session:sibling.session})).asks_for_you.length,0);
  assert.equal((await call(`/asks/${ask.id}/answer`,{method:'POST',session:sibling.session,body:{body_md:'Not mine'}})).status,403);
  const answer=ok(await call(`/asks/${ask.id}/answer`,{method:'POST',session:expert.session,body:{body_md:'Page 4, lemma 2, under the stated assumptions.'}}));
  assert.equal(ok(await call('/inbox',{session:ordinary.session})).answers[0].id,answer.message_id);
  assert.equal(ok(await call('/inbox',{session:sibling.session})).answers.length,0);
  assert.equal(JSON.stringify(ok(await call(`/asks/${ask.id}`))).includes(ordinary.session),false);
  ok(await call(`/sessions/${expert.session}/capabilities`,{method:'POST',session:expert.session,body:{capabilities:{skills:['python']}}}));
  assert.equal(ok(await call('/who')).contacts.length,0);
  const unavailable=await call('/asks',{method:'POST',session:ordinary.session,body:{to_contact:expert.contact_id,body_md:'More?'}});
  assert.equal(unavailable.status,409,JSON.stringify(unavailable.body));
});

test('research availability expires with silence, donor deadline, cap or explicit end',async()=>{
  const a=await start({capabilities:{research:'I retain the derivation behind a prior result.'}});
  await q(`UPDATE sessions SET last_seen=now()-interval '121 minutes' WHERE id=$1`,[a.session]);assert.equal(ok(await call('/who')).contacts.length,0);
  await q(`UPDATE sessions SET last_seen=now(),ends_at=now()-interval '1 minute' WHERE id=$1`,[a.session]);assert.equal(ok(await call('/who')).contacts.length,0);
  await q(`UPDATE sessions SET ends_at=NULL,max_jobs=jobs WHERE id=$1`,[a.session]);assert.equal(ok(await call('/who')).contacts.length,1,'held work can finish');
  ok(await release(a));assert.equal(ok(await call('/who')).contacts.length,0);
  assert.equal((await call('/inbox',{session:a.session})).status,403);
});

test('substantial research uses the shared queue, any equivalent source access can answer, and the evidence links back',async()=>{
  const a=await start();const expert=await start({capabilities:{sources:['archive-a']}});
  const ask=ok(await call('/asks',{method:'POST',session:a.session,body:{to_contact:expert.contact_id,body_md:'Investigate the assumptions behind lemma 2.'}}));
  const opts={method:'POST',session:a.session,body:{required_sources:['archive-a'],budget_hours:1}};
  const research=ok(await call(`/asks/${ask.id}/research`,opts));assert.deepEqual(ok(await call(`/asks/${ask.id}/research`,opts)),{ok:true,job_id:research.job_id,status:'queued'});
  const stranger=await start();assert.notEqual(Number(stranger.job_id),research.job_id);
  const equivalent=await start({who:otherToken,capabilities:{sources:['archive-a'],skills:['literature-search']}});
  assert.equal(Number(equivalent.job_id),research.job_id);
  const ret=ok(await call('/result',{method:'POST',who:otherToken,session:equivalent.session,attempt:equivalent.attempt_id,body:{job_id:equivalent.job_id,report_md:'Lemma 2 requires uniformity; page 4 supplies the hypothesis.',transcript:'t',transcript_approved:true}}));
  const answer=ok(await call('/inbox',{session:a.session})).answers[0];assert.match(answer.body_md,new RegExp(`return #${ret.return_id}`));
  assert.equal(ok(await call(`/asks/${ask.id}`)).ask.status,'answered');
});

test('publication effects roll back with DB work and survive a failed flush for ordered replay',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'sah-scheduler-'));const path=join(dir,'paper.md');
  try {
    await assert.rejects(()=>transaction(async()=>{await queueFileEffect(path,'uncommitted');throw new Error('reject');}));
    assert.equal(existsSync(path),false);assert.equal((await one(`SELECT count(*) AS n FROM pending_file_effects WHERE path=$1`,[path])).n,'0');
    await transaction(()=>queueFileEffect(path,'committed'));assert.equal(readFileSync(path,'utf8'),'committed');
    await q(`INSERT INTO pending_file_effects (path,content) VALUES ($1,'retry me')`,[path]);
    await q(`INSERT INTO pending_file_effects (path,content) VALUES ($1,'blocked')`,[join(path,'child')]);
    await assert.rejects(()=>flushFileEffects());
    assert.equal((await one(`SELECT count(*) AS n FROM pending_file_effects WHERE path=$1`,[path])).n,'1');
    await q(`DELETE FROM pending_file_effects WHERE path=$1`,[join(path,'child')]);await flushFileEffects();
    assert.equal(readFileSync(path,'utf8'),'retry me');
    await transaction(()=>queueFileEffect(path,null));assert.equal(existsSync(path),false);
  } finally {await q(`DELETE FROM pending_file_effects WHERE path LIKE $1`,[dir+'%']);rmSync(dir,{recursive:true,force:true});}
});

test('unknown capability reports remain usable and profile parsing rejects malformed declarations',()=>{
  assert.deepEqual(parseCapabilities({}).tools,[]);assert.deepEqual(parseCapabilities({skills:['Lean','lean',' PYTHON ']}).skills,['lean','python']);
  assert.throws(()=>parseCapabilities('{broken'));assert.throws(()=>parseCapabilities({sources:[42]}));
  assert.throws(()=>matchingMetadata({priority:99}));
});

test('release and return racing settle one attempt; stale completion after expiry cannot create a return',async()=>{
  await queued();const a=await start();
  const [returned,released]=await Promise.all([result(a),release(a)]);
  assert.deepEqual([returned.status,released.status].sort(),[200,409]);
  const attempt=await one(`SELECT status,receipt FROM assignment_attempts WHERE id=$1`,[a.attempt_id]);
  assert.ok(['completed','released'].includes(attempt.status));assert.ok(attempt.receipt);
  assert.equal((await one(`SELECT count(*) AS n FROM returns WHERE job_id=$1`,[a.job_id])).n,returned.status===200?'1':'0');
  const b=await start();await q(`UPDATE jobs SET expires_at=now()-interval '1 minute' WHERE id=$1`,[b.job_id]);
  assert.equal((await result(b)).status,409);
  const c=ok(await call('/start',{session:b.session}));assert.notEqual(c.attempt_id,b.attempt_id);assert.notEqual(c.job_id,b.job_id);
  assert.equal((await one(`SELECT status FROM assignment_attempts WHERE id=$1`,[b.attempt_id])).status,'released');
});

test('a shared inbox cursor cannot skip research answers when another stream has newer messages',async()=>{
  const a=await start();const expert=await start({capabilities:{research:'I know the derivation.'}});
  const ask=ok(await call('/asks',{method:'POST',session:a.session,body:{to_contact:expert.contact_id,body_md:'What did you derive?'}}));
  const root=await one(`SELECT id FROM channels WHERE problem_id=$1 AND path=''`,[pid]);
  const original=await one(`SELECT message_id FROM asks WHERE id=$1`,[ask.id]);
  const expected=[];
  for(let i=0;i<25;i++)expected.push(Number((await one(`INSERT INTO messages (channel_id,user_id,model,kind,reply_to,body_md,session) VALUES ($1,$2,'claude-fable-5-1','reply',$3,$4,$5) RETURNING id`,[root.id,uid,original.message_id,`Finding ${i}`,expert.session])).id));
  const parent=await one(`INSERT INTO messages (channel_id,user_id,kind,body_md,session) VALUES ($1,$2,'idea','Separate discussion',$3) RETURNING id`,[root.id,uid,a.session]);
  const latest=await one(`INSERT INTO messages (channel_id,user_id,kind,body_md,reply_to) VALUES ($1,$2,'reply','Later reply',$3) RETURNING id`,[root.id,other,parent.id]);
  const first=ok(await call('/inbox',{session:a.session}));assert.equal(first.answers.length,20);assert.equal(first.replies.length,0);
  const second=ok(await call(`/inbox?since=${first.max_message_id}`,{session:a.session}));assert.equal(second.answers.length,5);assert.equal(Number(second.replies[0].id),Number(latest.id));
  assert.deepEqual([...first.answers,...second.answers].map(m=>Number(m.id)),expected);
});

test('migration backfills legacy attempts and repairs duplicate claims without losing the earliest job',async()=>{
  const sid=randomUUID().replaceAll('-','');
  await transaction(async()=>{
    // Model the old schema's permitted state inside a transaction; migration reinstates both indexes before commit.
    await q(`DROP INDEX jobs_one_per_session_idx`);await q(`DROP INDEX attempts_one_per_session_idx`);
    await q(`INSERT INTO sessions (id,problem_id,user_id,model,ai,jobs) VALUES ($1,$2,$3,'claude-fable-5-1','{"max_hours_per_assignment":1}',2)`,[sid,pid,uid]);
    const first=await queued({hours:4});const second=await queued();
    await q(`UPDATE jobs SET status='assigned',assigned_session=$1,assigned_to=$2,assigned_at=now(),expires_at=now()+interval '2 hours' WHERE id=ANY($3)`,[sid,uid,[first.id,second.id]]);
    await q(readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8'));
    const rows=await q(`SELECT j.id,j.status,a.status AS attempt_status,a.budget_hours FROM jobs j JOIN assignment_attempts a ON a.id=j.attempt_id WHERE j.problem_id=$1 ORDER BY j.id`,[pid]);
    assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>[r.status,r.attempt_status]),[['assigned','assigned'],['queued','released']]);
    assert.equal(Number(rows[0].budget_hours),1);
    assert.match((await one(`SELECT last_release_note FROM jobs WHERE id=$1`,[second.id])).last_release_note,/scheduler migration/);
  });
  await migrate();
  assert.equal((await one(`SELECT count(*) AS n FROM assignment_attempts WHERE problem_id=$1`,[pid])).n,'2','restarting must not duplicate attempt history');
});

test('an old deployment slot can hand off a reassigned legacy job without inheriting the previous receipt',async()=>{
  await queued();const a=await start();ok(await release(a));
  const sid=randomUUID().replaceAll('-','');
  await q(`INSERT INTO sessions (id,problem_id,user_id,model,effort,jobs) VALUES ($1,$2,$3,'claude-fable-5-1','max',1)`,[sid,pid,uid]);
  // Old code updates ownership but knows nothing about attempt_id, so the previous attempt remains on the row.
  await q(`UPDATE jobs SET status='assigned',assigned_session=$2,assigned_to=$3,assigned_at=now(),expires_at=now()+interval '2 hours' WHERE id=$1`,[a.job_id,sid,uid]);
  const opts={method:'POST',session:sid,body:{job_id:a.job_id,report_md:'Evidence from the new holder.',transcript:'t',transcript_approved:true}};
  const receipt=ok(await call('/result',opts));assert.ok(receipt.return_id);
  assert.deepEqual(ok(await call('/result',opts)),receipt);
  const attempts=await q(`SELECT id,status FROM assignment_attempts WHERE job_id=$1 ORDER BY started_at`,[a.job_id]);
  assert.equal(attempts.length,2);assert.deepEqual(attempts.map(a=>a.status),['released','completed']);
});

// Issue #88: the refusal is right, but "fetch /start for current work" is the one thing an agent must not do while it still
// holds an unsubmitted assignment, and every fact needed to say something better is already in the request.
test('a completion whose X-Attempt and job_id name different assignments says which to resend with, and does not send the agent to /start', async () => {
  const first = await start();
  ok(await result(first));
  const second = await start({session: first.session});
  assert.notEqual(String(second.job_id), String(first.job_id), 'a second, different assignment is open on this run');
  const r = await call('/result', {method: 'POST', session: first.session, attempt: first.attempt_id,
    body: {job_id: second.job_id, report_md: 'A bounded evidence note with uncertainty.', transcript: 't', transcript_approved: true}});
  assert.equal(r.status, 409, JSON.stringify(r.body));
  const e = r.body.error;
  assert.match(e, new RegExp(`job #${first.job_id}`), 'it names the assignment the header points at');
  assert.match(e, new RegExp(`job_id is ${second.job_id}`), 'and the assignment the body points at');
  assert.match(e, new RegExp(`X-Attempt: ${second.attempt_id}`), 'and the attempt to resend with');
  assert.match(e, /nothing was submitted/i);
  assert.match(e, /Do not fetch \/start/, 'following the old advice would have taken a third assignment');
  assert.doesNotMatch(e, /fetch \/start for current work/);
  ok(await result(second));   // and the run can still finish the work it actually holds
});

// Issue #82: an operator running one model kind stacks review jobs of its own returns that no agent of theirs can take. The
// brief printed the count; the scheduler recorded eligible_backlog.reviews = 0, because it counts only what this agent may
// take. Both were true and both described the same queue, so "no review debt" and "debt nobody here can serve" read alike.
test('review jobs blocked only by the same-kind rule are counted as blocked, not as an empty backlog',async()=>{
  const ret=await one(`INSERT INTO returns (problem_id,type,user_id,model,provider,report_md,transcript,status) VALUES ($1,'measure',$2,'claude-fable-5-1','anthropic','A measured table.','t','pending') RETURNING id`,[pid,uid]);
  await one(`INSERT INTO jobs (problem_id,type,title,brief_md,git_ref,budget_hours,min_tier,parent_return_id) VALUES ($1,'review',$2,'Check it.','main',1,99,$3) RETURNING id`,[pid,`Review return #${ret.id}`,ret.id]);
  const a={problemId:pid,slug,sessionId:'synthetic-82',uid,tier:1,model:'claude-fable-5-1',provider:'anthropic',trusted:true,granted:true,lane:null,cpuHours:4,ramGb:8,hasGpu:false,disk:1,maxHours:2,reviewStreak:0,capabilities:{}};
  const mine=await backlogFor(a);
  assert.equal(mine.reviews,0,'a model is never offered a review of its own kind');
  assert.equal(mine.blocked_reviews,1,`the debt is visible instead of reading as an empty queue: ${JSON.stringify(mine)}`);
  const other=await backlogFor({...a,model:'gpt-6-astra',provider:'openai'});
  assert.equal(other.reviews,1,'another model can take it');
  assert.equal(other.blocked_reviews,0,'and has nothing blocked by kind');
  await q(`DELETE FROM jobs WHERE parent_return_id=$1`,[ret.id]);
  await q(`DELETE FROM returns WHERE id=$1`,[ret.id]);
});

// Review 4163 (#1820): a return stored as "claude-opus-5.5" went to one "claude-opus-5-5" reviewer after another, each releasing
// it as its own kind. canon_model() folds the dotted spelling at start, like the server does with X-Model on the way in.
test('a dotted Claude label is folded at start and is the same kind as the dashed id for review selection',async()=>{
  const {canonicalModel}=await import('../src/lib/model-id.ts');
  for (const raw of ['claude-opus-5.5','claude-opus-5.5[1m]','anthropic/claude-opus-5.5','claude-haiku-4.5-20251001','gpt-5.1','gemini-3.5-flash','claude-opus-5']) {
    const row=await one(`SELECT canon_model($1) AS m`,[raw]);
    assert.equal(row.m,canonicalModel(raw),`the SQL twin agrees with model-id.ts on ${raw}`);
  }
  const ret=await one(`INSERT INTO returns (problem_id,type,user_id,model,provider,report_md,transcript,status) VALUES ($1,'explore',$2,'claude-opus-5.5','anthropic','A result.','t','pending') RETURNING id`,[pid,other]);
  const j=await one(`INSERT INTO jobs (problem_id,type,title,brief_md,git_ref,budget_hours,min_tier,parent_return_id,avoid_model) VALUES ($1,'review',$2,'Check it.','main',1,99,$3,'claude-opus-5.5') RETURNING id`,[pid,`Review return #${ret.id}`,ret.id]);
  await migrate();
  assert.equal((await one(`SELECT model FROM returns WHERE id=$1`,[ret.id])).model,'claude-opus-5-5','the stored return is folded');
  assert.equal((await one(`SELECT avoid_model FROM jobs WHERE id=$1`,[j.id])).avoid_model,'claude-opus-5-5','and so is the job\'s avoided model');
  await q(`UPDATE jobs SET avoid_model=NULL WHERE id=$1`,[j.id]);   // a review job carries no avoided model; only the return's kind decides below
  const a={problemId:pid,slug,sessionId:'synthetic-4163',uid,tier:1,model:'claude-opus-5-5',provider:'anthropic',trusted:true,granted:true,lane:null,cpuHours:4,ramGb:8,hasGpu:false,disk:1,maxHours:2,reviewStreak:0,capabilities:{}};
  const mine=await backlogFor(a);
  assert.equal(mine.reviews,0,'an Opus 5.5 reviewer is not offered its own kind under another spelling');
  assert.equal(mine.blocked_reviews,1,JSON.stringify(mine));
  assert.equal((await backlogFor({...a,model:'gpt-6-astra',provider:'openai'})).reviews,1,'another model takes it');
  await q(`DELETE FROM jobs WHERE id=$1`,[j.id]);
  await q(`DELETE FROM returns WHERE id=$1`,[ret.id]);
});

test('a research job on a route this handle and model worked recently ranks lower but is never refused; the board names the busiest handle and model',async()=>{
  const origin=await one(`INSERT INTO returns (problem_id,type,user_id,model,provider,report_md,transcript,status) VALUES ($1,'explore',$2,'claude-fable-5-1','test','Origin.','t','accepted') RETURNING id`,[pid,other]);
  const route=async title=>Number((await one(`INSERT INTO research_routes (problem_id,origin_return_id,title,contribution_md,prior_art_md,uncertainty_md,state) VALUES ($1,$2,$3,'c','p','u','active') RETURNING id`,[pid,origin.id,title])).id);
  const worked=await route('worked'),fresh=await route('fresh');
  const onRoute=async(routeId,age)=>{const j=await queued({type:'explore',age});await q(`UPDATE jobs SET research_route_id=$2 WHERE id=$1`,[j.id,routeId]);return j;};
  // Older by far less than the penalty: without history the worked route's job wins on waiting time.
  const onWorked=await onRoute(worked,5),onFresh=await onRoute(fresh,0);
  assert.ok(ROUTE_REPEAT_PENALTY>5);
  const a={problemId:pid,slug,sessionId:'synthetic',uid,tier:2,model:'claude-fable-5-1',provider:'test',trusted:false,granted:false,lane:null,cpuHours:0,ramGb:0,hasGpu:false,disk:1,maxHours:2,reviewStreak:0,capabilities:{}};
  assert.equal((await selectJob(a,false)).id,onWorked.id,'no history: plain ranking');
  // This handle and model worked the route in a recent assignment (from another session: several sessions of one model under one handle count as one).
  const past=await onRoute(worked,0);await q(`UPDATE jobs SET status='returned' WHERE id=$1`,[past.id]);
  await q(`INSERT INTO assignment_attempts (id,job_id,problem_id,session_id,user_id,model,budget_hours,status,ended_at) VALUES ($1,$2,$3,'synthetic-earlier',$4,'claude-fable-5-1',2,'returned',now())`,[randomUUID(),past.id,pid,uid]);
  const picked=await selectJob(a,false);assert.equal(picked.id,onFresh.id,'the route worked recently ranks lower');assert.equal(picked.route_repeat,false);
  assert.equal((await selectJob({...a,model:'claude-sonnet-5'},false)).id,onWorked.id,'another model of the same handle is a different view and keeps the plain order');
  // A preference, never a refusal: with nothing else eligible the same route is handed out, and the reason says so.
  await q(`UPDATE jobs SET status='expired' WHERE id=$1`,[onFresh.id]);
  const only=await selectJob(a,false);assert.equal(only.id,onWorked.id);assert.equal(only.route_repeat,true);
  const live=await start();assert.equal(Number(live.job_id),Number(onWorked.id));
  assert.match(live.assignment_reason?.route_repeat ?? '',/ranked lower to spread work across routes/);
  // The board's concentration figure: this handle and model hold every budgeted hour of the week; no trusted decision yet.
  const c=await workConcentration(pid);
  assert.equal(c.window_days,7);assert.equal(c.hours.handle.name,tag);assert.equal(c.hours.handle.share,1);assert.equal(c.hours.model.name,'claude-fable-5-1');
  assert.equal(c.trusted_decisions.total,0);assert.equal(c.trusted_decisions.handle,null);
  const b=ok(await call('/board'));assert.equal(b.research.concentration.hours.handle.name,tag);
});

test('operational deferrals survive new sessions, reopen on changes, and keep human overrides',async()=>{
  const j=await queued({priority:10}); const a=await start();assert.equal(Number(a.job_id),Number(j.id));
  const d={kind:'execution',evidence_md:'Eight-worker census cannot run under the tested one-core controls; reuse certificate 2186.',reopen_when:'Available execution controls or a decisive bounded substitute change.'};
  const opts={method:'POST',session:a.session,attempt:a.attempt_id,body:{job_id:a.job_id,note:'Execution fit, not a mathematical refutation',deferral:d}};
  ok(await call('/release',opts));ok(await call('/release',opts));
  assert.equal((await one('SELECT count(*) AS n FROM assignment_deferrals WHERE job_id=$1',[j.id])).n,'1');
  const b=await start();assert.notEqual(Number(b.job_id),Number(j.id),'fresh session reuses the deferral');ok(await release(b));
  const agent={problemId:pid,slug,sessionId:b.session,uid,tier:1,model:'claude-fable-5-1',provider:'anthropic',trusted:true,granted:true,lane:null,cpuHours:0,ramGb:0,hasGpu:false,disk:5,maxHours:2,reviewStreak:0,capabilities:{}};
  assert.ok(!await selectJob(agent,false));
  await q(`UPDATE sessions SET model='claude-opus-5',capabilities=capabilities || '{"name":"Another agent","skills":["research"]}' WHERE id=$1`,[b.session]);
  assert.ok(!await selectJob({...agent,model:'claude-opus-5'},false),'a new model alone is not new source or execution evidence');
  await q(`UPDATE sessions SET model='claude-fable-5-1' WHERE id=$1`,[b.session]);
  assert.equal(Number((await selectJob({...agent,jobId:Number(j.id)},false)).id),Number(j.id),'explicit job direction still allowed');
  await q(`UPDATE sessions SET capabilities=capabilities || '{"execution":{"cores":8}}' WHERE id=$1`,[b.session]);
  assert.equal(Number((await selectJob(agent,false)).id),Number(j.id),'different actual controls reopen work');
  await q(`UPDATE sessions SET capabilities=(SELECT capabilities FROM sessions WHERE id=$1) WHERE id=$2`,[a.session,b.session]);
  assert.ok(!await selectJob(agent,false));
  await q(`UPDATE jobs SET brief_md=brief_md || ' A bounded substitute is now supplied.' WHERE id=$1`,[j.id]);
  assert.equal(Number((await selectJob(agent,false)).id),Number(j.id),'changed requirements reopen work');
});

test('generated index waits for co-origin source findings without erasing corrections',async()=>{
  const j=await queued({type:'audit'});await q(`UPDATE jobs SET title='Fix research/QUESTIONS.md',requires_trust=true,min_tier=1 WHERE id=$1`,[j.id]);
  const r=await one(`INSERT INTO returns(problem_id,type,user_id,model,provider,report_md,transcript,status) VALUES ($1,'audit',$2,'claude-opus-5','anthropic','Source correction evidence','t','accepted') RETURNING id`,[pid,other]);
  await q(`INSERT INTO findings(problem_id,path,return_id,note,scope,job_id) VALUES ($1,'research/QUESTIONS.md',$2,'Regenerate after source correction','before_circulation',$3)`,[pid,r.id,j.id]);
  const f=await one(`INSERT INTO findings(problem_id,path,return_id,note,scope) VALUES ($1,'research/source.md',$2,'Repair the missing ledger verdict','before_circulation') RETURNING id`,[pid,r.id]);
  const agent={problemId:pid,slug,sessionId:'prereq-fixture',uid,tier:1,model:'claude-fable-5-1',provider:'anthropic',trusted:true,granted:true,lane:null,cpuHours:0,ramGb:8,hasGpu:false,disk:5,maxHours:2,reviewStreak:0,capabilities:{}};
  assert.equal(await selectRequiredCorrection(agent),null);
  assert.equal(Number((await selectJob({...agent,jobId:Number(j.id)},false)).id),Number(j.id));
  await q(`UPDATE findings SET status='resolved' WHERE id=$1`,[f.id]);
  assert.equal(Number((await selectRequiredCorrection(agent)).id),Number(j.id));
  const dependency=await one(`INSERT INTO findings(problem_id,path,return_id,note,scope) VALUES ($1,'research/another-source.md',$2,'Explicit maintenance prerequisite','before_circulation') RETURNING id`,[pid,r.id]);
  await q('INSERT INTO job_correction_prerequisites(job_id,finding_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[j.id,dependency.id]);
  await q('INSERT INTO job_correction_prerequisites(job_id,finding_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[j.id,dependency.id]);
  assert.equal(await selectRequiredCorrection(agent),null,'explicit derived prerequisites also hold regeneration');
  await q(`UPDATE findings SET status='resolved' WHERE id=$1`,[dependency.id]);
  assert.equal(Number((await selectRequiredCorrection(agent)).id),Number(j.id));
  assert.ok(!(await selectJob({...agent,tier:2},false)),'explicit selection never weakens tier');
  assert.ok(!(await selectJob({...agent,trusted:false,jobId:Number(j.id)},false)),'human override never weakens trust');
});

test('explicit runtime deferrals ignore publication changes and retain the original release and fit',async()=>{
  const j=await queued({priority:10});
  const capabilities={tools:['python3'],execution:{cpu_seconds:10,wall_seconds:20,publication_context_privacy:'export-v1'}};
  const a=await start({capabilities});assert.equal(Number(a.job_id),Number(j.id));
  const opts={method:'POST',session:a.session,attempt:a.attempt_id,body:{job_id:a.job_id,note:'Producer does not fit runtime limits',deferral:{kind:'execution',fit_scope:'runtime',evidence_md:'The producer has no resumable path within the process limit.',reopen_when:'A bounded substitute or relevant runtime control changes.'}}};
  const receipt=ok(await call('/release',opts));assert.deepEqual(ok(await call('/release',opts)),receipt);
  const stored=await one('SELECT * FROM assignment_deferrals WHERE job_id=$1',[j.id]);
  assert.equal(stored.fit_scope,'runtime');assert.deepEqual(stored.session_fit[3],capabilities.execution);
  const next={...capabilities,execution:{...capabilities.execution,publication_context_privacy:'export-v2'}};
  const b=await start({capabilities:next});assert.notEqual(Number(b.job_id),Number(j.id));ok(await release(b));
  const agent={problemId:pid,slug,sessionId:b.session,uid,tier:1,model:'claude-fable-5-1',provider:'anthropic',trusted:true,granted:true,lane:null,cpuHours:0,ramGb:0,hasGpu:false,disk:5,maxHours:2,reviewStreak:0,capabilities:next};
  assert.ok(!await selectJob(agent,false),'unrelated publication update does not reopen runtime work');
  assert.equal(Number((await selectJob({...agent,jobId:Number(j.id)},false)).id),Number(j.id),'explicit human direction still works');
  await q(`UPDATE sessions SET capabilities=jsonb_set(capabilities,'{execution,cpu_seconds}','20') WHERE id=$1`,[b.session]);
  assert.equal(Number((await selectJob(agent,false)).id),Number(j.id),'an actual runtime control change permits a focused check');
  assert.deepEqual((await one('SELECT session_fit FROM assignment_deferrals WHERE id=$1',[stored.id])).session_fit,stored.session_fit,'the historical snapshot is never rewritten');
  assert.deepEqual((await one('SELECT receipt FROM assignment_attempts WHERE id=$1',[a.attempt_id])).receipt,receipt,'no terminal release is resent or replaced');
});

test('publication deferrals reopen only for publication controls; old clients keep legacy matching',async()=>{
  const capabilities={execution:{cpu_seconds:10,publication_context_privacy:'export-v1'}};
  const j=await queued({priority:10});const a=await start({capabilities});
  const body={job_id:a.job_id,note:'Export prerequisite',deferral:{kind:'execution',fit_scope:'publication',evidence_md:'The actual export fails its publication guard.',reopen_when:'A validated successor exporter is available.'}};
  for(const fit_scope of ['invalid',{}]) {
    assert.equal((await call('/release',{method:'POST',session:a.session,attempt:a.attempt_id,body:{...body,deferral:{...body.deferral,fit_scope}}})).status,400);
  }
  assert.equal((await one('SELECT status FROM assignment_attempts WHERE id=$1',[a.attempt_id])).status,'assigned');
  assert.equal((await one('SELECT count(*) AS n FROM assignment_deferrals WHERE job_id=$1',[j.id])).n,'0');
  assert.equal((await call('/release',{method:'POST',session:a.session,attempt:a.attempt_id,body:{...body,deferral:{...body.deferral,kind:'source'}}})).status,400,'source evidence never silently drops its runtime/access fit');
  ok(await call('/release',{method:'POST',session:a.session,attempt:a.attempt_id,body}));
  const b=await start({capabilities:{execution:{cpu_seconds:20,publication_context_privacy:'export-v1'}}});
  assert.notEqual(Number(b.job_id),Number(j.id),'more CPU does not fix the exporter');ok(await release(b));
  const agent={problemId:pid,slug,sessionId:b.session,uid,tier:1,model:'claude-fable-5-1',provider:'anthropic',trusted:true,granted:true,lane:null,cpuHours:0,ramGb:0,hasGpu:false,disk:5,maxHours:2,reviewStreak:0,capabilities:{}};
  await q(`UPDATE sessions SET capabilities=jsonb_set(capabilities,'{execution,publication_context_privacy}','"export-v2"') WHERE id=$1`,[b.session]);
  assert.equal(Number((await selectJob(agent,false)).id),Number(j.id),'validated publication change permits new ownership normally');
  assert.equal((await one('SELECT fit_scope FROM assignment_deferrals WHERE job_id=$1',[j.id])).fit_scope,'publication');
  await q(`UPDATE jobs SET status='expired' WHERE id=$1`,[j.id]);
  const old=await queued({priority:10});const c=await start({capabilities});
  ok(await call('/release',{method:'POST',session:c.session,attempt:c.attempt_id,body:{job_id:c.job_id,deferral:{kind:'execution',evidence_md:'Historical unclassified checkpoint.',reopen_when:'Compare the original controls and sources.'}}}));
  assert.equal((await one('SELECT fit_scope FROM assignment_deferrals WHERE job_id=$1',[old.id])).fit_scope,'legacy');
  const d=await start({capabilities:{execution:{cpu_seconds:10,publication_context_privacy:'export-v2'}}});
  assert.equal(Number(d.job_id),Number(old.id),'legacy checkpoint behavior is not retroactively changed');
});

test('runtime scope treats omitted, empty and publication-only execution metadata as the same runtime',async()=>{
  for(const [before,after] of [[{}, {execution:{publication_context_privacy:'export-v2'}}], [{execution:{publication_context_privacy:'export-v1'}}, {}], [{execution:{}}, {execution:{publication_context_privacy:'export-v2'}}]]) {
    const j=await queued({priority:10});const a=await start({capabilities:before});assert.equal(Number(a.job_id),Number(j.id));
    ok(await call('/release',{method:'POST',session:a.session,attempt:a.attempt_id,body:{job_id:a.job_id,deferral:{kind:'execution',fit_scope:'runtime',evidence_md:'Runtime limits are not yet declared and validated.',reopen_when:'Actual runtime controls or a bounded substitute become available.'}}}));
    const b=await start({capabilities:after});assert.notEqual(Number(b.job_id),Number(j.id),'publication-only presence or absence is not a runtime change');ok(await release(b));
    const agent={problemId:pid,slug,sessionId:b.session,uid,tier:1,model:'claude-fable-5-1',provider:'anthropic',trusted:true,granted:true,lane:null,cpuHours:0,ramGb:0,hasGpu:false,disk:5,maxHours:2,reviewStreak:0,capabilities:after};
    assert.ok(!await selectJob(agent,false));
    await q(`UPDATE jobs SET status='expired' WHERE problem_id=$1 AND status='queued'`,[pid]);
  }
});

test('named handoffs isolate one task, preserve human direction and resume without judging science',async()=>{
  const target=await queued({type:'audit',priority:10});await q('UPDATE jobs SET min_tier=1,requires_trust=true WHERE id=$1',[target.id]);
  const alternate=await queued();
  const author=await one(`INSERT INTO returns(problem_id,type,user_id,model,provider,report_md,transcript,status) VALUES ($1,'audit',$2,'claude-opus-5','anthropic','Accepted source evidence','t','accepted') RETURNING id`,[pid,other]);
  const finding=await one(`INSERT INTO findings(problem_id,path,return_id,note,scope,job_id) VALUES ($1,'research/QUESTIONS.md',$2,'Needs genuine source history','before_circulation',$3) RETURNING id`,[pid,author.id,target.id]);
  const body={recipient:{kind:'person',handle:'@'+tag+'-other'},reason_md:'Original author chronology is missing.',required_access_md:'A matching complete source repository and accepted source-ledger corrections.',resume_when:'Supply verified author chronology and corrected source ledgers.'};
  const path=`/job/${target.id}/handoff`;
  assert.equal((await call(path,{method:'POST',body})).status,403,'a random contributor cannot park work');
  await q(`INSERT INTO project_roles(problem_id,user_id,role,note) VALUES ($1,$2,'trusted','handoff fixture')`,[pid,uid]);
  assert.equal((await call(path,{method:'POST',body:{...body,recipient:{kind:'person',handle:'missing-person'}}})).status,404);
  assert.equal((await call(path,{method:'POST',body:{...body,required_access_md:'/Users/private/research'}})).status,400,'public handoffs do not publish private paths');
  const h=ok(await call(path,{method:'POST',body}));assert.equal(h.notification_sent,false);
  assert.equal((await call(path,{method:'POST',body})).status,409,'no duplicate waiting handoff');
  assert.equal(ok(await call(`/job/${target.id}?format=json`)).handoffs[0].recipient_handle,tag+'-other');
  assert.equal(ok(await call(`/job/${target.id}?format=json`)).dispatch_state,'waiting_for_named_recipient');
  assert.equal(ok(await call('/job-handoffs?to=me',{who:otherToken})).handoffs.length,1);
  assert.equal(ok(await call('/job-handoffs?to=me')).handoffs.length,0);
  const assigned=await start();assert.equal(Number(assigned.job_id),Number(alternate.id),'unrelated work continues');
  const agent={problemId:pid,slug,sessionId:assigned.session,uid,tier:1,model:'claude-fable-5-1',provider:'anthropic',trusted:true,granted:true,lane:null,cpuHours:0,ramGb:8,hasGpu:false,disk:5,maxHours:2,reviewStreak:0,capabilities:{}};
  assert.equal(await selectRequiredCorrection(agent),null,'the repair reserve also skips the handoff');
  assert.equal(Number((await selectJob({...agent,jobId:Number(target.id)},false)).id),Number(target.id),'human may direct an explicit revisit');
  assert.equal(await selectJob({...agent,tier:2,jobId:Number(target.id)},false),undefined,'tier stays required');
  assert.equal(await selectJob({...agent,trusted:false,jobId:Number(target.id)},false),undefined,'trust stays required');
  const close=`${path}/${h.handoff_id}/close`;
  const payload={status:'resolved',resolution_md:'Matching source history and source-ledger evidence supplied; scientific repair remains open.'};
  ok(await call(close,{method:'POST',who:otherToken,body:payload}));
  ok(await call(close,{method:'POST',who:otherToken,body:payload}));
  assert.equal((await call(close,{method:'POST',body:{...payload,resolution_md:'Changed history'}})).status,409);
  assert.equal(Number((await selectRequiredCorrection(agent)).id),Number(target.id));
  assert.equal((await one('SELECT status FROM findings WHERE id=$1',[finding.id])).status,'open');
  assert.equal((await one('SELECT status FROM returns WHERE id=$1',[author.id])).status,'accepted');
  assert.equal((await one('SELECT status,assigned_session FROM jobs WHERE id=$1',[target.id])).assigned_session,null,'no ownership was transferred');
  const rendered=await (await fetch(`${base}/job/${target.id}`,{headers:{accept:'text/html'}})).text();
  assert.match(rendered,/Closed handoff history/);
  assert.doesNotMatch(rendered,/<h2>Specific person or agent needed/,'closed prerequisites do not instruct agents to wait');
});

test('an agent handoff targets a real contact and cannot be closed by a sibling or unrelated person',async()=>{
  await queued();
  const recipient=await start({who:otherToken,capabilities:{research:'Original source provenance'}});
  const contact=(await one('SELECT contact_id FROM sessions WHERE id=$1',[recipient.session])).contact_id;
  const target=await queued();
  await q(`INSERT INTO project_roles(problem_id,user_id,role,note) VALUES ($1,$2,'trusted','handoff fixture')`,[pid,uid]);
  const body={recipient:{kind:'agent',contact_id:contact},reason_md:'Only this contact holds the provenance.',required_access_md:'Original author-date history.',resume_when:'Pinned chronology is supplied.'};
  const path=`/job/${target.id}/handoff`;
  assert.equal((await call(path,{method:'POST',body:{...body,recipient:{kind:'agent',contact_id:'unavailable'}}})).status,404);
  const h=ok(await call(path,{method:'POST',body}));
  const notice=await call('/start',{who:otherToken,session:recipient.session});
  assert.equal(notice.status,200,'a bound launch replays its original assignment receipt');
  assert.deepEqual(notice.body,recipient,'handoff notices never rewrite an immutable assignment receipt');
  assert.equal(Number(notice.body.job_id),Number(recipient.job_id));
  ok(await call('/result',{method:'POST',who:otherToken,session:recipient.session,attempt:recipient.attempt_id,body:{job_id:recipient.job_id,report_md:'A bounded source note.',transcript:'t',transcript_approved:true}}));
  const next=ok(await call('/start',{who:otherToken,session:recipient.session}));
  assert.equal(next.inbox.job_handoffs.length,1,'the contact sees its prerequisite with its next new assignment');
  assert.notEqual(Number(next.job_id),Number(target.id),'the prerequisite never silently assigns the parked task');
  const sibling=await start({who:otherToken});
  assert.equal(sibling.inbox.job_handoffs.length,0,'a sibling is not given responsibility for the named contact');
  const close=`${path}/${h.handoff_id}/close`,payload={status:'cancelled',resolution_md:'The person chose another source expert.'};
  assert.equal((await call(close,{method:'POST',who:otherToken,body:payload})).status,403,'same handle is not that particular agent');
  await q('UPDATE sessions SET ended_at=now() WHERE id=$1',[recipient.session]);
  assert.equal((await call(close,{method:'POST',who:otherToken,session:recipient.session,body:payload})).status,403,'an ended contact has no new recipient authority');
  await q('UPDATE sessions SET ended_at=NULL WHERE id=$1',[recipient.session]);
  ok(await call('/release',{method:'POST',who:otherToken,session:next.session,attempt:next.attempt_id,body:{job_id:next.job_id,note:'Fixture task completed by release'}}));
  await q('UPDATE sessions SET max_jobs=jobs WHERE id=$1',[recipient.session]);
  assert.equal((await call(close,{method:'POST',who:otherToken,session:recipient.session,body:payload})).status,403,'an exhausted contact cannot act beyond its task cap');
  await q('UPDATE sessions SET max_jobs=NULL WHERE id=$1',[recipient.session]);
  ok(await call(close,{method:'POST',who:otherToken,session:recipient.session,body:payload}));
  assert.equal(ok(await call(`/job/${target.id}`)).handoffs[0].status,'cancelled');
});
