// Lean independence for an approved user's own handle (Chris, Oct 6 2026: "Different model I think we should keep but it can be same user
// for approved users and tier 1 models"). Synthetic records only: no Lean runs and no mathematical result is asserted.
import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {randomUUID} from 'node:crypto';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database.');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
const {q,one,pool,migrate}=await import('../src/db/index.ts');
const {modelTier}=await import('../src/lib/auth.ts');
const {TERMS_VERSION}=await import('../src/lib/terms.ts');
const {leanFixture}=await import('./fixtures/lean.mjs');
const {leanStatementBinding}=await import('../src/lib/lean-verification.ts');
const {leanStatementReviewed,verificationRuns,saveCheckReceipt}=await import('../src/lib/verification.ts');
const {whyNotEligible}=await import('../src/lib/scheduler.ts');

const AUTHOR='claude-opus-5-5', OTHER='gpt-6.1-sol', SMALL='claude-sonnet-5';
let pid, slug;
const users={};
before(async()=>{
  await migrate();
  for (const m of [AUTHOR,OTHER,SMALL,'claude-fable-5-1','gpt-6-sol']) await modelTier(m);
  for (const name of ['owner','trusted','plain','stranger'])
    users[name]=Number((await one(`INSERT INTO users (github_id,handle,terms_version,terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`,[700000000+Math.floor(Math.random()*1e8),'lean-same-'+name+'-'+randomUUID().slice(0,8),TERMS_VERSION])).id);
  slug='lean-same-'+randomUUID().slice(0,8);
  pid=Number((await one(`INSERT INTO problems (slug,name,repo_url,status_md,researcher_user_id) VALUES ($1,'Lean same user','https://example.org/l','open',$2) RETURNING id`,[slug,users.owner])).id);
  await q(`INSERT INTO project_roles (problem_id,user_id,role,note) VALUES ($1,$2,'trusted','test')`,[pid,users.trusted]);
});
after(async()=>{
  await q(`DELETE FROM verification_runs WHERE subject_return_id IN (SELECT id FROM returns WHERE problem_id=$1) OR result_return_id IN (SELECT id FROM returns WHERE problem_id=$1)`,[pid]);
  await q(`DELETE FROM reviews WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`,[pid]);
  await q(`UPDATE returns SET job_id=NULL WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM jobs WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM returns WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM project_roles WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM problems WHERE id=$1`,[pid]);
  await q(`DELETE FROM users WHERE id = ANY($1::bigint[])`,[Object.values(users)]);
  await pool.end();
});

const independent=async(actor,model,effort,author,authorModel=AUTHOR)=>(await one(`SELECT lean_independent($1,$2,$3,$4,$5,$6) AS ok`,[pid,actor,model,effort,author,authorModel])).ok;
const ret=async(user,model,{plan=null,status='accepted',type='formalize',effort='high'}={})=>one(`INSERT INTO returns (problem_id,type,user_id,model,provider,report_md,transcript,status,verification_plan,verification_fingerprint,effort)
  VALUES ($1,$2,$3,$4,'anthropic','fixture','t',$5,$6,$7,$8) RETURNING *`,[pid,type,user,model,status,plan?JSON.stringify(plan):null,plan?randomUUID():null,effort]);

test('the rule: distinct model families and Tier 1/high always; the same user only when approved and on a tier-1 model at high or above', async()=>{
  assert.equal(await independent(users.owner,OTHER,'high',users.owner),true,'owner, other tier-1 model: independent');
  assert.equal(await independent(users.trusted,OTHER,'max',users.trusted),true,'trusted by grant, other tier-1 model: independent');
  assert.equal(await independent(users.owner,AUTHOR,'high',users.owner),false,'same user, same model: never');
  assert.equal(await independent(users.owner,AUTHOR+'-high',null,users.owner),false,'an effort alias is the same model');
  assert.equal(await independent(users.owner,SMALL,'high',users.owner),false,'same user on a model below tier 1');
  assert.equal(await independent(users.owner,OTHER,'medium',users.owner),false,'same user on a tier-1 model below high effort');
  assert.equal(await independent(users.owner,OTHER,null,users.owner),false,'same user with an unmeasured effort');
  assert.equal(await independent(users.plain,OTHER,'high',users.plain),false,'a user who is not approved never checks their own return');
  assert.equal(await independent(users.stranger,OTHER,'low',users.plain),false,'different contributors still require Tier 1/high');
  assert.equal(await independent(users.stranger,OTHER,'high',users.plain),true);
  assert.equal(await independent(users.owner,'claude-fable-5-1','high',users.owner),false,'sibling models share a family');
  assert.equal(await independent(users.stranger,'claude-fable-5-1','high',users.plain),false,'another contributor cannot supply same-family independence');
  assert.equal(await independent(users.stranger,OTHER,'high',users.plain,'gpt-6-sol'),false,'versions share a family');
  assert.equal(await independent(users.stranger,'unknown','high',users.plain),false);
  assert.equal(await independent(users.stranger,AUTHOR,'high',users.plain),false,'another user on the same model: unchanged');
});

test('statement trust, receipt independence and check assignment follow the rule for Lean packages only', async()=>{
  const {plan}=leanFixture();
  const binding=leanStatementBinding(plan.lean);
  // One review per user and return: each case reviews its own accepted statement proposal.
  const review=async(user,model,effort)=>{const source=await ret(users.owner,AUTHOR,{plan});
    return one(`INSERT INTO reviews (return_id,user_id,model,provider,verdict,rung,notes_md,trusted,effort,lean_statement_review)
    VALUES ($1,$2,$3,'anthropic','accept','Measured','fixture',true,$4,$5) RETURNING id`,[source.id,user,model,effort,JSON.stringify({binding_sha256:binding,meaning_md:'fixture'})]);};
  const proofFor=async(rv)=>ret(users.owner,AUTHOR,{plan:{...plan,lean:{...plan.lean,statement_review_id:Number(rv.id)}}});
  const own=await proofFor(await review(users.owner,OTHER,'high'));
  assert.equal(await leanStatementReviewed(own),true,'owner review on another tier-1 model is trusted');
  assert.equal((await one(`SELECT lean_statement_review_current($1) AS ok`,[own.id])).ok,true,'the SQL twin agrees');
  const same=await proofFor(await review(users.owner,AUTHOR,'high'));
  assert.equal(await leanStatementReviewed(same),false,'same model is refused');
  assert.equal((await one(`SELECT lean_statement_review_current($1) AS ok`,[same.id])).ok,false);
  const small=await proofFor(await review(users.owner,SMALL,'high'));
  assert.equal(await leanStatementReviewed(small),false,'non-tier-1 same user is refused');
  const plainSource=await ret(users.plain,AUTHOR,{plan});
  const plainReview=await one(`INSERT INTO reviews (return_id,user_id,model,provider,verdict,rung,notes_md,trusted,effort,lean_statement_review)
    VALUES ($1,$2,$3,'anthropic','accept','Measured','fixture',true,'high',$4) RETURNING id`,[plainSource.id,users.plain,OTHER,JSON.stringify({binding_sha256:binding,meaning_md:'fixture'})]);
  const plainProof=await ret(users.plain,AUTHOR,{plan:{...plan,lean:{...plan.lean,statement_review_id:Number(plainReview.id)}}});
  assert.equal(await leanStatementReviewed(plainProof),false,'an unapproved user reviewing their own return is refused');

  // Receipts: the owner's own receipt on another tier-1 model counts for a Lean package, never for a plain one.
  const receipt=async(subject,model)=>{const r=await ret(users.owner,model,{type:'check',status:'recorded'});
    await q(`INSERT INTO verification_runs (subject_return_id,result_return_id,fingerprint,outcome,observed,elapsed_seconds,details) VALUES ($1,$2,$3,'pass','{}',1,'{}')`,[subject.id,r.id,subject.verification_fingerprint]);};
  await receipt(own,OTHER);
  assert.equal((await verificationRuns(own.id))[0].independent,true,'Lean receipt by the approved owner on another tier-1 model');
  await receipt(same,AUTHOR);
  assert.equal((await verificationRuns(same.id))[0].independent,false,'Lean receipt on the author model');
  const plainPkg=await ret(users.owner,AUTHOR,{plan:{...plan,lean:undefined}});
  await receipt(plainPkg,OTHER);
  assert.equal((await verificationRuns(plainPkg.id))[0].independent,false,'non-Lean packages keep the different-user rule');

  // Check intake and assignment.
  const job=await one(`INSERT INTO jobs (problem_id,type,title,brief_md,min_tier,budget_hours,evidence_return_id,required_tools) VALUES ($1,'check','Check fixture','Replay.',99,0.5,$2,ARRAY['lean','lean-comparator-linux']) RETURNING *`,[pid,own.id]);
  const intake=async(user,model,effort)=>saveCheckReceipt({problem_id:pid,user_id:user,model,effort},job,{fingerprint:own.verification_fingerprint}).catch(e=>e.message);
  assert.doesNotMatch(String(await intake(users.owner,OTHER,'high')),/distinct model family/,'owner on another tier-1 model passes the independence gate');
  assert.match(String(await intake(users.owner,AUTHOR,'high')),/distinct model family/);
  assert.match(String(await intake(users.owner,SMALL,'high')),/distinct model family/);
  const agent={problemId:pid,slug,sessionId:'',uid:users.owner,tier:1,model:OTHER,provider:'openai',trusted:true,granted:true,lane:null,cpuHours:8,ramGb:32,hasGpu:false,disk:10,maxHours:4,reviewStreak:0,capabilities:{tools:['lean','lean-comparator-linux']}};
  const reasons=async(a)=>(await whyNotEligible(a,job.id)).join(' | ');
  assert.doesNotMatch(await reasons(agent),/own handle or model/,'the approved owner on another tier-1 model may take the check');
  assert.match(await reasons({...agent,model:AUTHOR}),/own handle or model/,'never on the author model');
  assert.match(await reasons({...agent,tier:2}),/own handle or model/,'never below tier 1');
  assert.match(await reasons({...agent,granted:false,trusted:true}),/own handle or model/,'trust by model alone does not open the own-handle path');
});


test('SQL and serving boundaries agree on families, effort, and author eligibility',async()=>{
  const {leanModelFamily}=await import('../src/lib/model-id.ts');
  for(const model of ['openai/gpt-6.1-sol-high','gpt-6-sol','claude-opus-5.5','claude-fable-5-1','unknown','invented'])
    assert.equal((await one('SELECT lean_model_family($1) AS family',[model])).family,leanModelFamily(model),model);
  const {plan}=leanFixture(), binding=leanStatementBinding(plan.lean);
  const source=await ret(users.owner,AUTHOR,{plan});
  const rv=await one(`INSERT INTO reviews(return_id,user_id,model,provider,verdict,rung,notes_md,trusted,effort,lean_statement_review)
    VALUES($1,$2,$3,'openai','accept','Measured','fixture',true,'high',$4) RETURNING id`,[source.id,users.stranger,OTHER,JSON.stringify({binding_sha256:binding,meaning_md:'fixture'})]);
  const proof=await ret(users.owner,AUTHOR,{plan:{...plan,lean:{...plan.lean,statement_review_id:Number(rv.id)}}});
  const current=async()=>[await leanStatementReviewed(proof),(await one('SELECT lean_statement_review_current($1) AS ok',[proof.id])).ok];
  assert.deepEqual(await current(),[true,true]);
  await q(`UPDATE reviews SET effort='low' WHERE id=$1`,[rv.id]);assert.deepEqual(await current(),[false,false],'different human at low effort cannot provide statement trust');
  await q(`UPDATE reviews SET effort='high',model='claude-fable-5-1' WHERE id=$1`,[rv.id]);assert.deepEqual(await current(),[false,false],'different human with a sibling model cannot provide statement trust');
  await q(`UPDATE reviews SET model=$2 WHERE id=$1`,[rv.id,OTHER]);
  await q(`UPDATE returns SET effort='medium' WHERE id=$1`,[source.id]);assert.deepEqual(await current(),[false,false],'statement author must be high');
  await q(`UPDATE returns SET effort='high' WHERE id=$1`,[source.id]);
  proof.effort='medium';await q(`UPDATE returns SET effort='medium' WHERE id=$1`,[proof.id]);assert.deepEqual(await current(),[false,false],'proof author must be high');
});
