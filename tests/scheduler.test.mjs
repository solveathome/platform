import assert from 'node:assert/strict';
import {before, beforeEach, after, afterEach, test} from 'node:test';
import express from 'express';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, existsSync, readFileSync, rmSync} from 'node:fs';
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
const {backlogFor, selectJob, allocation, discoveryDue, discoveryShare} = await import('../src/lib/scheduler.ts');
const {parseCapabilities, matchingMetadata} = await import('../src/lib/agent-profile.ts');
let server, base, uid, other, token, otherToken, pid, slug;
const tag = `scheduler-${Date.now().toString(36)}`;

before(async () => {
  await migrate(); await migrate(); // additive migration also supports subsequent starts
  uid = Number((await one(`INSERT INTO users (github_id,handle,terms_version,terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000+Math.floor(Math.random()*1e8),tag,TERMS_VERSION])).id);
  other = Number((await one(`INSERT INTO users (github_id,handle,terms_version,terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000+Math.floor(Math.random()*1e8),tag+'-other',TERMS_VERSION])).id);
  token = await issueToken(uid); otherToken = await issueToken(other);
  const app = express(); app.use(express.json()); app.use('/projects/:slug',job,asks);
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
  assert.deepEqual(await backlogFor(a),{reviews:0,research:1});assert.equal((await selectJob(a,false)).id,plain.id);
  a.capabilities={tools:['lean'],skills:['lean']};
  assert.deepEqual(await backlogFor(a),{reviews:0,research:2});assert.equal((await selectJob(a,false)).id,j.id);
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
  assert.notEqual(ja.origin_key,jb.origin_key);assert.match(b.brief_md,/Leads|Explore/);
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
  assert.equal((await call('/asks',{method:'POST',session:ordinary.session,body:{to_contact:expert.contact_id,body_md:'More?'}})).status,409);
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
