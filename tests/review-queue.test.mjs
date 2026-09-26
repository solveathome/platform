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
process.env.REVIEW_QUEUE_NOTE_FROM = '2'; // read once at import: two pending returns are a long queue here
process.env.OWN_WAITING_NOTE_FROM = '2'; // and two of a handle's own pending returns are a full queue behind it
const {migrate, q, one, pool, transaction, queueFileEffect, flushFileEffects} = await import('../src/db/index.ts');
const {issueToken} = await import('../src/lib/auth.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {job, NEXT_STEP_BRIEF, NEW_GROUND_HEADING} = await import('../src/routes/job.ts');
const {asks} = await import('../src/routes/asks.ts');
const {backlogFor, selectJob, reviewPressure, unmetRequirements} = await import('../src/lib/scheduler.ts');
const {parseCapabilities, matchingMetadata} = await import('../src/lib/agent-profile.ts');
let server, base, uid, other, token, otherToken, pid, slug;
const tag = `revqueue-${Date.now().toString(36)}`;

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


// Platform issue #94 (Sep 18 2026): with a long review queue an agent asking for work still gets a meaningful assignment,
// and the two review rules do not move: trusted reviewers only, never one's own return.
const agentOf = (over={}) => ({problemId:pid,slug,sessionId:'synthetic-94',uid,tier:3,model:'deepseek-v4-flash',provider:'deepseek',trusted:false,granted:false,lane:null,cpuHours:4,ramGb:8,hasGpu:false,disk:1,maxHours:2,reviewStreak:0,capabilities:{},...over});
async function pursuit({tools=[],sources=[],age=0,stage='pursue',type='explore'}={}) {
  const j=await queued({type,purpose:'discovery',tools,sources,age});
  await q(`UPDATE jobs SET research_stage=$2 WHERE id=$1`,[j.id,stage]);
  return j;
}
async function pendingReturn(author,model='deepseek-v4-flash',provider='deepseek') {
  const ret=await one(`INSERT INTO returns (problem_id,type,user_id,model,provider,report_md,transcript,status) VALUES ($1,'measure',$2,$3,$4,'A measured table.','t','pending') RETURNING id`,[pid,author,model,provider]);
  await q(`INSERT INTO jobs (problem_id,type,title,brief_md,git_ref,budget_hours,min_tier,parent_return_id) VALUES ($1,'review',$2,'Check it.','main',1,99,$3)`,[pid,`Review return #${ret.id}`,ret.id]);
  return Number(ret.id);
}

test('a pursuit step held only by names nobody has ever declared is served after a day; a declared capability still holds it',async()=>{
  // Somebody in this project declares lean and python3: those are real capabilities here.
  const holder=await start({who:otherToken,model:'claude-opus-5',capabilities:{tools:['lean','python3']}}); await release(holder);
  const fresh=await pursuit({tools:['job1934-blockgrain.py'],sources:['return-660']});
  const stale=await pursuit({tools:['job1934-blockgrain.py'],sources:['return-660'],age:2});
  const lean=await pursuit({tools:['lean'],age:2});
  const python=await pursuit({tools:['python'],age:2});                       // alias of a declared python3
  const source=await queued({type:'source',sources:['scanned-book'],age:2});    // not a pursuit step: requirements stay hard
  await q(`UPDATE jobs SET status='expired' WHERE id=$1`,[holder.job_id]);
  const a=agentOf();
  const ids=async agent=>{const out=[];for(const j of [fresh,stale,lean,python,source]){const r=await selectJob({...agent,jobId:Number(j.id)},true);if(r)out.push(String(r.id));}return out;};
  assert.deepEqual(await ids(a),[String(stale.id)],'only the day-old step with undeclared names is open to an agent without them');
  assert.deepEqual(await ids(agentOf({capabilities:{tools:['lean']}})),[String(stale.id),String(lean.id)],'an agent with the declared tool takes that step as before');
  assert.equal((await backlogFor({...a,tier:1})).research,1,'the backlog counts exactly what selection offers');
  assert.deepEqual(unmetRequirements(stale,{}),{tools:['job1934-blockgrain.py'],sources:['return-660']});
  assert.deepEqual(unmetRequirements({required_tools:['python'],required_sources:[]},{tools:['python3']}),{tools:[],sources:[]});
});

// Sep 26 2026: every session of the week declared no tools while older ones had declared python3, and 93 of 96 pursuit steps
// fitted nobody. A declaration counts only from a session seen in the last DECLARED_CAPABILITY_DAYS.
test('a tool declared only by sessions not seen this week stops holding a pursuit step after a day',async()=>{
  const old=await start({who:otherToken,model:'claude-opus-5',capabilities:{tools:['sage']}}); await release(old);
  await q(`UPDATE jobs SET status='expired' WHERE id=$1`,[old.job_id]);
  const sage=await pursuit({tools:['sage'],age:2});
  const pick=async()=>(await selectJob({...agentOf(),jobId:Number(sage.id)},true))?.id;
  assert.equal(await pick(),undefined,'a tool a live session declared still holds the step');
  await q(`UPDATE sessions SET last_seen=now()-interval '8 days' WHERE id=$1`,[old.session]);
  assert.equal(String(await pick()),String(sage.id),'once nobody seen this week declares it, the step is served with the name as a note');
});

test('the served brief names the proposer\'s requirements as notes and the assignment records what was relaxed',async()=>{
  const stale=await pursuit({tools:['job1934-blockgrain.py'],sources:['return-660'],age:2});
  const a=await start({model:'deepseek-v4-flash'});
  assert.equal(String(a.job_id),String(stale.id));
  assert.match(a.brief_md,/## Names the proposer used for what this step needs/);
  assert.match(a.brief_md,/`job1934-blockgrain\.py`/); assert.match(a.brief_md,/`return-660`/);
  assert.match(a.brief_md,/Do not return `blocked` for a missing tool/);
  assert.deepEqual(a.assignment_reason.relaxed_requirements,{tools:['job1934-blockgrain.py'],sources:['return-660']});
  await release(a);
});

test('under review pressure a session that may review reviews first, by need; below the threshold and for everyone else nothing changes',async()=>{
  await q(`UPDATE problems SET research_allocation=$2 WHERE id=$1`,[pid,JSON.stringify({discover:0.3,pursue:0.4,rescue:0.15,consolidate:0.15})]);
  for(let i=0;i<3;i++) await pendingReturn(other);
  const own=await pendingReturn(uid,'claude-opus-5','anthropic');               // the reviewing handle's own return
  await pursuit(); await pursuit(); await pursuit(); await pursuit();
  assert.equal(reviewPressure(slug),null,'off unless the project or the environment sets it');
  // Without pressure the portfolio sends a trusted Astra session to research (pursuit leads the allocation).
  const calm=await start({model:'gpt-6-astra'}); assert.equal(calm.type,'explore'); assert.equal(calm.assignment_reason.policy,'research portfolio'); await release(calm);
  process.env.REVIEW_PRESSURE='3';
  try {
    const pressed=await start({model:'gpt-6-astra'});
    assert.equal(pressed.type,'review'); assert.equal(pressed.assignment_reason.policy,'review pressure');
    assert.deepEqual(pressed.assignment_reason.review_pressure,{threshold:3,waiting:3});
    const parent=await one(`SELECT parent_return_id FROM jobs WHERE id=$1`,[pressed.job_id]);
    assert.notEqual(Number(parent.parent_return_id),own,'never the reviewing handle\'s own return: that stays a grant\'s power');
    await release(pressed);
    // A session that is not trusted gets research under the same pressure, never a review.
    const opus=await start({model:'claude-opus-5'}); assert.equal(opus.type,'explore'); assert.equal(opus.assignment_reason.policy,'research portfolio'); await release(opus);
    const flash=await start({model:'deepseek-v4-flash'}); assert.equal(flash.type,'explore'); await release(flash);
    // The author's other model, trusted by model, is not offered the author's returns either.
    const ownJob=Number((await one(`SELECT id FROM jobs WHERE parent_return_id=$1`,[own])).id);
    const astra=agentOf({tier:1,model:'gpt-6-astra',provider:'openai',trusted:true,jobId:ownJob});
    assert.ok(!(await selectJob(astra,false,false,undefined,false,true)),'trusted by model never reviews its own handle\'s return, pressed or not');
    assert.ok(!(await selectJob({...astra,trusted:false},false,false,undefined,false,true)),'and an untrusted session reviews nothing');
    process.env.REVIEW_PRESSURE='50';
    const below=await start({model:'gpt-6-astra',who:otherToken}); assert.notEqual(below.assignment_reason.policy,'review pressure'); await release(below);
  } finally { delete process.env.REVIEW_PRESSURE; }
});

test('after its run of reviews a pressed session goes back to research',async()=>{
  await q(`UPDATE problems SET research_allocation=$2 WHERE id=$1`,[pid,JSON.stringify({discover:0.3,pursue:0.4,rescue:0.15,consolidate:0.15})]);
  for(let i=0;i<6;i++) await pendingReturn(other);
  for(let i=0;i<6;i++) await pursuit();
  process.env.REVIEW_PRESSURE='2';
  try {
    const first=await start({model:'gpt-6-astra'}); assert.equal(first.type,'review');
    // Six reviews to six research: the run is one review, then research.
    await q(`UPDATE jobs SET status='returned' WHERE id=$1`,[first.job_id]); await q(`UPDATE assignment_attempts SET status='completed' WHERE id=$1`,[first.attempt_id]);
    const next=await ok(await call('/start',{session:first.session,model:'gpt-6-astra'}));
    assert.equal(next.type,'explore',JSON.stringify(next.assignment_reason)); assert.equal(next.assignment_reason.prefer_research,true);
    await release(next);
  } finally { delete process.env.REVIEW_PRESSURE; }
});

test('a session that cannot review is told who reviews, why it holds its assignment and what helps; a reviewer is not',async()=>{
  await pendingReturn(other); await pendingReturn(other);
  await pursuit();
  const a=await start({model:'deepseek-v4-flash'});
  assert.match(a.brief_md,/## The review queue, and why this is your assignment/);
  assert.match(a.brief_md,/2 returns wait for a verdict/);
  assert.match(a.brief_md,/releasing this assignment will not get you a review/);
  assert.match(a.brief_md,/verification_plan/);
  await release(a);
  const r=await start({model:'gpt-6-astra'});
  assert.doesNotMatch(r.brief_md,/why this is your assignment/,'a session that can review is handed reviews, not an explanation');
  await release(r);
});

test('a short review queue adds nothing to the brief',async()=>{
  await pendingReturn(other); await pursuit();
  const a=await start({model:'deepseek-v4-flash'});
  assert.doesNotMatch(a.brief_md,/why this is your assignment/); await release(a);
});

// Chris, Sep 18 2026 (#sah-meaningful-work-new-opportunities): a full queue behind an agent means look for new opportunities,
// and nothing about it is handed to its person. Until then the brief listed every model at the tier as if one could review.
test('a handle whose own returns wait reads who decides and that nothing is asked of its person; from a full queue, where its work goes now, once',async()=>{
  await pursuit(); await pursuit(); await pursuit();
  await pendingReturn(uid,'deepseek-v4-flash','deepseek');
  const first=await start({model:'deepseek-v4-flash'});
  assert.match(first.brief_md,/## Your handle's returns waiting for a verdict/);
  assert.match(first.brief_md,/1 of @\S+'s returns waits for a verdict/);
  assert.match(first.brief_md,/No agent of your person's can decide them, on any model/);
  assert.match(first.brief_md,/there is nothing for them to do/);
  assert.doesNotMatch(first.brief_md,/tell your person|tier \d or above \(|Reviews waiting for your person/);
  assert.doesNotMatch(first.brief_md,new RegExp(NEW_GROUND_HEADING),'one pending return is not a full queue');
  await release(first);
  await pendingReturn(uid,'claude-opus-5','anthropic');   // two own returns: a full queue here; the project queue is long too (2)
  const full=await start({model:'deepseek-v4-flash'});
  assert.match(full.brief_md,/2 of @\S+'s returns wait for a verdict \(1 made on deepseek-v4-flash\)/);
  assert.equal((full.brief_md.match(new RegExp(NEW_GROUND_HEADING,'g'))??[]).length,1,'the new-ground list is written once even when the review-queue note fires as well');
  assert.match(full.brief_md,/## The review queue, and why this is your assignment/);
  assert.match(full.brief_md,/research\.proposal/); assert.match(full.brief_md,/GET \S+\/questions/); assert.match(full.brief_md,/as a `direction` return/);
  assert.ok(full.brief_md.indexOf(NEW_GROUND_HEADING)<full.brief_md.indexOf('## The review queue'),'the list sits in the own-returns note');
  await release(full);
});

test('when only the project queue is long the review-queue note carries the new-ground list, once; a granted handle reads what its grant allows',async()=>{
  await pendingReturn(other); await pendingReturn(other); await pursuit(); await pursuit();
  const a=await start({model:'deepseek-v4-flash'});
  assert.doesNotMatch(a.brief_md,/## Your handle's returns waiting/);
  assert.equal((a.brief_md.match(new RegExp(NEW_GROUND_HEADING,'g'))??[]).length,1);
  await release(a);
  await q(`INSERT INTO project_roles (problem_id,user_id,role,note) VALUES ($1,$2,'trusted','test')`,[pid,other]);
  const g=await start({model:'deepseek-v4-flash',who:otherToken});
  assert.match(g.brief_md,/2 of @\S+'s returns wait for a verdict/);
  assert.match(g.brief_md,/Your person holds a grant on this project/);
  assert.doesNotMatch(g.brief_md,/No agent of your person's can decide them/);
  await release(g);
});

test('a run with a saved direction and no queued step is told that returns waiting for a verdict are no blocker',()=>{
  assert.match(NEXT_STEP_BRIEF,/not a blocker and need nothing from your person/);
  assert.match(NEXT_STEP_BRIEF,/record it complete rather than padding it/);
  assert.match(NEXT_STEP_BRIEF,/POST \/run\/next-step/);
});
