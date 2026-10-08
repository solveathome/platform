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
const {leanExecutionFixture}=await import('./fixtures/lean-execution.mjs');
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
  await q(`DELETE FROM file_refs WHERE ref_type='return' AND ref_id IN (SELECT id FROM returns WHERE problem_id=$1)`,[pid]);
  await q(`DELETE FROM returns WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM project_roles WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM assignment_attempts WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM sessions WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM files WHERE user_id=ANY($1::bigint[])`,[Object.values(users)]);
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

  // Historical observations never acquire authenticated execution provenance, even for an approved owner.
  const receipt=async(subject,model)=>{const r=await ret(users.owner,model,{type:'check',status:'recorded'});
    await q(`INSERT INTO verification_runs (subject_return_id,result_return_id,fingerprint,outcome,observed,elapsed_seconds,details) VALUES ($1,$2,$3,'pass','{}',1,'{}')`,[subject.id,r.id,subject.verification_fingerprint]);};
  await receipt(own,OTHER);
  assert.equal((await verificationRuns(own.id))[0].trusted_execution,false,'old owner receipt has no attestation');
  assert.equal((await verificationRuns(own.id))[0].independent,true,'historical cross-family metadata remains truthful');
  assert.equal((await verificationRuns(own.id))[0].execution_eligible,false,'independence metadata cannot promote old execution');
  await receipt(same,AUTHOR);
  assert.equal((await verificationRuns(same.id))[0].independent,false,'Lean receipt on the author model');
  const plainPkg=await ret(users.owner,AUTHOR,{plan:{...plan,lean:undefined}});
  await receipt(plainPkg,OTHER);
  assert.equal((await verificationRuns(plainPkg.id))[0].independent,false,'non-Lean packages keep the different-user rule');

  // Check intake and assignment.
  const job=await one(`INSERT INTO jobs (problem_id,type,title,brief_md,min_tier,budget_hours,evidence_return_id,required_tools) VALUES ($1,'check','Check fixture','Replay.',99,0.5,$2,ARRAY['lean','lean-comparator-linux']) RETURNING *`,[pid,own.id]);
  const intake=async(user,model,effort)=>saveCheckReceipt({problem_id:pid,user_id:user,model,effort},job,{fingerprint:own.verification_fingerprint}).catch(e=>e.message);
  assert.match(String(await intake(users.owner,OTHER,'high')),/execution_policy/);
  assert.match(String(await intake(users.owner,AUTHOR,'high')),/execution_policy/,'same model can execute, but cannot bypass authenticated intake');
  assert.match(String(await intake(users.owner,SMALL,'high')),/currently approved project contributor/);
  const agent={problemId:pid,slug,sessionId:'',uid:users.owner,tier:1,model:OTHER,provider:'openai',trusted:true,granted:true,lane:null,cpuHours:8,ramGb:32,hasGpu:false,disk:10,maxHours:4,reviewStreak:0,capabilities:{tools:['lean','lean-comparator-linux']}};
  const reasons=async(a)=>(await whyNotEligible(a,job.id)).join(' | ');
  assert.doesNotMatch(await reasons(agent),/own handle or model/,'the approved owner on another tier-1 model may take the check');
  assert.doesNotMatch(await reasons({...agent,model:AUTHOR}),/own handle or model/,'same model may execute; correctness review remains cross-family');
  assert.match(await reasons({...agent,tier:2}),/own handle or model/,'never below tier 1');
  assert.match(await reasons({...agent,uid:users.plain,granted:false,trusted:true}),/own handle or model/,'trust by model alone does not authorize execution');
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


test('new authenticated execution allows approved author/same family; binds evidence, trust and exact package',async()=>{
  const {plan}=leanFixture(), binding=leanStatementBinding(plan.lean);
  const source=await ret(users.owner,AUTHOR,{plan});
  const rv=await one(`INSERT INTO reviews(return_id,user_id,model,provider,verdict,rung,notes_md,trusted,effort,lean_statement_review)
    VALUES($1,$2,$3,'openai','accept','Measured','fixture',true,'high',$4) RETURNING id`,[source.id,users.owner,OTHER,JSON.stringify({binding_sha256:binding,meaning_md:'fixture'})]);
  const proof=await ret(users.owner,AUTHOR,{plan:{...plan,lean:{...plan.lean,statement_review_id:Number(rv.id)}}});
  // An old unable report is retained but must not exhaust/suppress the new authenticated attempt.
  const legacy=await ret(users.owner,AUTHOR,{type:'check',status:'recorded'});
  const oldRun=await one(`INSERT INTO verification_runs(subject_return_id,result_return_id,fingerprint,outcome,observed,elapsed_seconds,details) VALUES($1,$2,$3,'unable','Historical package blocker',1,$4) RETURNING id`,[proof.id,legacy.id,proof.verification_fingerprint,JSON.stringify({blocker:{kind:'package',required_tools:[],required_sources:[]}})]);
  const {queueCheck,verificationState}=await import('../src/lib/verification.ts');
  assert.equal(await queueCheck(proof),true,'unattested legacy unable cannot suppress a new check');
  const freshJob=await one(`SELECT id FROM jobs WHERE evidence_return_id=$1 AND type='check' AND status='queued'`,[proof.id]);
  const freshAgent={problemId:pid,slug,sessionId:'',uid:users.owner,tier:1,model:AUTHOR,provider:'anthropic',trusted:true,granted:true,lane:null,cpuHours:8,ramGb:32,hasGpu:false,disk:10,maxHours:4,reviewStreak:0,capabilities:{tools:['lean','lean-comparator-linux']}};
  assert.ok(!(await whyNotEligible(freshAgent,freshJob.id)).some(reason=>reason.includes('already reported this package as unable')),'legacy unable cannot block the approved owner assignment');
  assert.ok((await verificationRuns(proof.id)).some(r=>Number(r.id)===Number(oldRun.id)),'historical unable remains visible');
  await q(`UPDATE jobs SET status='expired' WHERE id=$1`,[freshJob.id]);
  const f=await leanExecutionFixture(proof,users.owner,AUTHOR);
  await assert.rejects(saveCheckReceipt(f.ret,f.job,f.raw),/authenticated account and session/);
  await assert.rejects(saveCheckReceipt(f.ret,f.job,f.raw,{...f.authenticated,userId:users.plain}),/authenticated account and session/);
  await assert.rejects(saveCheckReceipt(f.ret,f.job,f.raw,{...f.authenticated,sessionId:randomUUID()}),/authenticated account and session/);
  await assert.rejects(saveCheckReceipt(f.ret,f.job,{...f.raw,execution_policy:'legacy'},f.authenticated),/execution_policy/);
  await assert.rejects(saveCheckReceipt(f.ret,f.job,{...f.raw,attestation_md:true},f.authenticated),/nonempty text/);
  await assert.rejects(saveCheckReceipt(f.ret,f.job,{...f.raw,controls:[]},f.authenticated),/controls/);
  const saved=await f.submit();
  assert.equal(await queueCheck(proof),false,'one eligible execution suffices; no second family replay is queued');
  const {researchSummary}=await import('../src/lib/research.ts');
  assert.equal((await researchSummary(pid)).checks.first_attempt_completed,1,'board metrics use current execution eligibility, including an authenticated author receipt');
  const current=async(subject=proof)=>(await verificationRuns(subject.id)).find(r=>Number(r.id)===Number(saved.id));
  assert.equal((await current()).trusted_execution,true,'one authenticated author execution is eligible');
  assert.equal((await current()).execution_eligible,true);
  assert.equal((await current()).independent,false,'same-family execution is not falsely labelled model-independent');
  const {leanVerificationSummary,verificationSummary}=await import('../src/lib/verification.ts');
  assert.equal((await leanVerificationSummary(proof.id,plan.lean.manuscript_sha256)).status,'awaiting_review','execution alone is not mathematical correctness review');
  const correctness=await one(`INSERT INTO reviews(return_id,user_id,model,provider,verdict,rung,notes_md,trusted,effort,verification_receipt_id,verification_sufficiency_md)
    VALUES($1,$2,$3,'fixture','accept','Measured','Synthetic review',true,'high',$4,$5) RETURNING id`,[proof.id,users.owner,AUTHOR,saved.id,'Synthetic independent correctness assessment: mapped identity follows from its hypothesis; proof reasoning, assumptions, artifacts, isolation, controls and limits assessed.']);
  assert.equal((await leanVerificationSummary(proof.id,plan.lean.manuscript_sha256)).status,'awaiting_review','same-family semantic self-approval is ineligible');
  await q(`UPDATE reviews SET model=$2 WHERE id=$1`,[correctness.id,OTHER]);
  assert.equal((await leanVerificationSummary(proof.id,plan.lean.manuscript_sha256)).status,'checked','one author execution plus same-human cross-family correctness review suffices');
  const summary=await verificationSummary(proof.id);
  assert.equal(summary.receipts.eligible,1);assert.equal(summary.receipts.trusted_execution,1);assert.equal(summary.receipts.independent,0);
  assert.equal(await independent(users.owner,AUTHOR,'high',users.owner),false,'same-family correctness self-approval stays prohibited');
  const identical=await ret(users.owner,AUTHOR,{plan:proof.verification_plan});
  await q(`UPDATE returns SET verification_fingerprint=$2 WHERE id=$1`,[identical.id,proof.verification_fingerprint]);
  assert.equal((await current(identical)).trusted_execution,true,'same exact package reuses this one receipt');
  await q(`UPDATE returns SET verification_fingerprint='changed' WHERE id=$1`,[identical.id]);
  assert.equal((await current(identical)),undefined,'different package cannot reuse the receipt');
  await q(`UPDATE verification_runs SET details=jsonb_set(details,'{exit_code}','1') WHERE id=$1`,[saved.id]);
  assert.equal((await current()).trusted_execution,false,'receipt edits invalidate provenance');
  await q(`UPDATE verification_runs SET details=$2 WHERE id=$1`,[saved.id,JSON.stringify(saved.details)]);
  assert.equal((await current()).trusted_execution,true,'exact original observation remains bound');
  await q(`UPDATE files SET deleted_at=now() WHERE sha256=$1`,[f.raw.stdout_sha256]);
  assert.equal((await current()).trusted_execution,false,'missing/deleted evidence invalidates');
  await q(`UPDATE files SET deleted_at=NULL WHERE sha256=$1`,[f.raw.stdout_sha256]);
  await q(`UPDATE returns SET effort='medium' WHERE id=$1`,[f.ret.id]);
  assert.equal((await current()).trusted_execution,false,'low effort invalidates');
  await q(`UPDATE returns SET effort='high',status='withdrawn' WHERE id=$1`,[f.ret.id]);
  const {validateReceiptUse}=await import('../src/lib/verification.ts');
  await assert.rejects(validateReceiptUse(proof.id,saved.id),/valid receipt/);
  await q(`UPDATE returns SET status='recorded' WHERE id=$1`,[f.ret.id]);
  const trusted=await leanExecutionFixture(proof,users.trusted,AUTHOR), trustedRun=await trusted.submit();
  const trustedCurrent=async()=>(await verificationRuns(proof.id)).find(r=>Number(r.id)===Number(trustedRun.id)).trusted_execution;
  assert.equal(await trustedCurrent(),true,'approved external same-family executor is also eligible');
  await q(`UPDATE project_roles SET revoked_at=now() WHERE problem_id=$1 AND user_id=$2`,[pid,users.trusted]);
  assert.equal(await trustedCurrent(),false,'revoked trust is not current');
  await q(`UPDATE project_roles SET revoked_at=NULL,granted_at=now() WHERE problem_id=$1 AND user_id=$2`,[pid,users.trusted]);
  assert.equal(await trustedCurrent(),false,'a replacement grant cannot retrospectively promote an old attestation');
  const unapproved=await leanExecutionFixture(proof,users.plain,OTHER);
  await assert.rejects(unapproved.submit(),/currently approved project contributor/);
  const failed=await leanExecutionFixture(proof,users.owner,AUTHOR);
  failed.raw.outcome='fail';failed.raw.exit_code=1;failed.raw.observed='Synthetic detected failure.';
  await failed.submit();
  assert.equal((await verificationState(proof.id)).unresolved_conflict,true,'new authenticated failures remain visible beside a pass');
});
