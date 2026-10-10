// Synthetic authorization records only: these tests run no Lean and assert no mathematical result.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {leanV2Fixture} from './fixtures/lean-v2.mjs';
import {leanKernelFixture,kernelEvidence} from './fixtures/lean-kernel.mjs';
import {leanFixture,digest} from './fixtures/lean.mjs';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database.');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
const temp=mkdtempSync(join(tmpdir(),'lean-kernel-db-'));process.env.FILES_DIR=join(temp,'files');process.env.PROJECTS_DIR=join(temp,'projects');
const {q,one,pool,migrate}=await import('../src/db/index.ts');
const {modelTier}=await import('../src/lib/auth.ts');
const {TERMS_VERSION}=await import('../src/lib/terms.ts');
const {parseVerificationPlan,fingerprint,leanExecutionReviewed,validateLeanIdentityArtifacts,queueCheck,leanStatementReviewed,saveCheckReceipt,verificationRuns,leanVerificationSummary}=await import('../src/lib/verification.ts');
const {leanStatementBinding,leanScientificBinding,leanExecutionBinding}=await import('../src/lib/lean-verification.ts');
const {leanExecutionFixture}=await import('./fixtures/lean-execution.mjs');
const {blobPath}=await import('../src/lib/files.ts');
const {executionIdentityV2}=await import('../src/lib/lean-identity-v2.ts');
const {whyNotEligible}=await import('../src/lib/scheduler.ts');
const AUTHOR='claude-opus-5-5',OTHER='gpt-6.1-sol';
let pid,slug,owner,worker,base;
before(async()=>{
  await migrate();await migrate();
  for (const m of [AUTHOR,OTHER]) await modelTier(m);
  const user=async name=>Number((await one(`INSERT INTO users(github_id,handle,terms_version,terms_accepted_at) VALUES($1,$2,$3,now()) RETURNING id`,
    [700000000+Math.floor(Math.random()*1e8),'lean-kernel-'+name+'-'+randomUUID().slice(0,8),TERMS_VERSION])).id);
  owner=await user('owner');worker=await user('worker');slug='lean-kernel-'+randomUUID().slice(0,8);
  pid=Number((await one(`INSERT INTO problems(slug,name,repo_url,status_md,researcher_user_id) VALUES($1,'Identity contract fixture','https://example.org/identity','open',$2) RETURNING id`,[slug,owner])).id);
  await q(`INSERT INTO project_roles(problem_id,user_id,role,note) VALUES($1,$2,'trusted','Synthetic fixture')`,[pid,worker]);
  base=parseVerificationPlan(leanV2Fixture().plan);
});
after(async()=>{
  if(pid) {
    await q(`DELETE FROM verification_runs WHERE subject_return_id IN(SELECT id FROM returns WHERE problem_id=$1) OR result_return_id IN(SELECT id FROM returns WHERE problem_id=$1)`,[pid]);
    await q(`DELETE FROM reviews WHERE return_id IN(SELECT id FROM returns WHERE problem_id=$1)`,[pid]);
    await q(`DELETE FROM file_refs WHERE ref_type='return' AND ref_id IN(SELECT id FROM returns WHERE problem_id=$1)`,[pid]);
    await q(`UPDATE returns SET job_id=NULL WHERE problem_id=$1`,[pid]);
    await q(`DELETE FROM jobs WHERE problem_id=$1`,[pid]);
    await q(`DELETE FROM research_routes WHERE problem_id=$1`,[pid]);
    await q(`DELETE FROM papers WHERE problem_id=$1`,[pid]);
    await q(`DELETE FROM returns WHERE problem_id=$1`,[pid]);
    await q(`DELETE FROM assignment_attempts WHERE problem_id=$1`,[pid]);
    await q(`DELETE FROM sessions WHERE problem_id=$1`,[pid]);
    await q(`DELETE FROM project_roles WHERE problem_id=$1`,[pid]);
    await q(`DELETE FROM problems WHERE id=$1`,[pid]);
    await q(`DELETE FROM files WHERE user_id=ANY($1::bigint[])`,[[owner,worker]]);
    await q(`DELETE FROM users WHERE id=ANY($1::bigint[])`,[[owner,worker]]);
  }
  await pool.end();
  rmSync(temp,{recursive:true,force:true});
});
const clone=x=>structuredClone(x);
async function uploadArtifacts(artifacts) {
  for(const [path,content] of artifacts) {
    const hash=digest(content),bytes=Buffer.byteLength(content),stored=blobPath(hash);
    await q(`INSERT INTO files(sha256,user_id,model,name,ext,bytes) VALUES($1,$2,$3,$4,'txt',$5) ON CONFLICT DO NOTHING`,[hash,owner,AUTHOR,path,bytes]);
    mkdirSync(dirname(stored),{recursive:true});writeFileSync(stored,content);
  }
}
const ret=async(plan,status='accepted')=>one(`INSERT INTO returns(problem_id,type,user_id,model,provider,report_md,transcript,status,verification_plan,verification_fingerprint,effort)
  VALUES($1,'formalize',$2,$3,'fixture','Synthetic contract fixture','t',$4,$5,$6,'high') RETURNING *`,[pid,owner,AUTHOR,status,JSON.stringify(plan),fingerprint(plan)]);
async function reviewed(plan=base) {
  const source=await ret(plan);
  const review=await one(`INSERT INTO reviews(return_id,user_id,model,provider,verdict,notes_md,trusted,effort,lean_statement_review,lean_execution_review)
    VALUES($1,$2,$3,'fixture','accept','Synthetic source review',true,'high',$4,$5) RETURNING *`,
    [source.id,owner,OTHER,JSON.stringify({binding_sha256:leanStatementBinding(plan.lean),meaning_md:'Synthetic assessment of the exact claims and definitions.'}),
      JSON.stringify({binding_sha256:executionIdentityV2(plan.lean.execution_identity),correctness_md:'Synthetic assessment of the exact portable execution contract: validator and tool source, invocation, isolation, resource bounds and scope.'})]);
  const proofPlan=clone(plan);proofPlan.lean.statement_review_id=Number(review.id);proofPlan.lean.execution_review_id=Number(review.id);
  return {source,review,proof:await ret(proofPlan)};
}
const sqlScience=async proof=>(await one(`SELECT lean_statement_review_current($1) AS ok`,[proof.id])).ok;
const sqlExecution=async proof=>(await one(`SELECT lean_execution_review_current($1) AS ok`,[proof.id])).ok;
const science=async proof=>[await sqlScience(proof),await leanStatementReviewed(proof)];
async function check(proof,user=owner) {
  const session=randomUUID(),attempt=randomUUID();
  await q(`INSERT INTO sessions(id,problem_id,user_id,model,effort) VALUES($1,$2,$3,$4,'high')`,[session,pid,user,AUTHOR]);
  const job=await one(`INSERT INTO jobs(problem_id,type,title,brief_md,min_tier,budget_hours,evidence_return_id,status,assigned_to,assigned_session)
    VALUES($1,'check','Synthetic identity check','No execution.',99,0.5,$2,'returned',$3,$4) RETURNING *`,[pid,proof.id,user,session]);
  await q(`INSERT INTO assignment_attempts(id,job_id,problem_id,session_id,user_id,model,tier,budget_hours,status) VALUES($1,$2,$3,$4,$5,$6,1,0.5,'completed')`,[attempt,job.id,pid,session,user,AUTHOR]);
  await q(`UPDATE jobs SET attempt_id=$2 WHERE id=$1`,[job.id,attempt]);
  const result=await one(`INSERT INTO returns(job_id,problem_id,type,user_id,model,provider,report_md,transcript,status,session,effort)
    VALUES($1,$2,'check',$3,$4,'fixture','Synthetic authorization fixture','t','recorded',$5,'high') RETURNING *`,[job.id,pid,user,AUTHOR,session]);
  return {job,result,authenticated:{userId:user,sessionId:session},attempt};
}
async function dispatchReasons(proof) {
  const job=await one(`INSERT INTO jobs(problem_id,type,title,brief_md,min_tier,budget_hours,evidence_return_id,required_tools)
    VALUES($1,'check','Synthetic dispatch check','No execution.',99,0.5,$2,ARRAY['lean']) RETURNING id`,[pid,proof.id]);
  return whyNotEligible({problemId:pid,slug,sessionId:'',uid:owner,tier:1,model:AUTHOR,provider:'fixture',trusted:true,granted:true,lane:null,
    cpuHours:8,ramGb:32,hasGpu:false,disk:10,maxHours:4,reviewStreak:0,capabilities:{tools:['lean','lean-comparator-linux']}},job.id);
}


async function kernelSubject({descriptor=false}={}) {
  const original=await reviewed(),fixture=leanKernelFixture({descriptor});await uploadArtifacts(fixture.artifacts);
  fixture.plan.lean.statement_review_id=Number(original.review.id);
  const proof=await ret(parseVerificationPlan(fixture.plan));return {proof,fixture,review:original.review,source:original.source};
}
async function kernelReceipt(proof,user=owner) {
 const f=await check(proof,user),lean=kernelEvidence(proof.verification_plan.lean),stdout=digest('Synthetic kernel stdout');
 for(const h of [stdout,lean.audit_sha256,lean.axioms_sha256,lean.custody_sha256])await q(`INSERT INTO files(sha256,user_id,model,name,ext,bytes) VALUES($1,$2,$3,'fixture.txt','txt',1) ON CONFLICT DO NOTHING`,[h,user,AUTHOR]);
 const raw={fingerprint:proof.verification_fingerprint,execution_policy:'authenticated-contributor-v1',outcome:'pass',observed:'Synthetic kernel observation; no actual kernel execution.',elapsed_seconds:1,
  attestation_md:'Synthetic personally observed test fixture only: authenticated assignment, artifact pins, controls and explicit limits.',stdout_sha256:stdout,exit_code:0,environment:'Synthetic bounded fixture',coverage_md:'One fixture mapped target',method:'rerun',shared_components_md:'Synthetic source fixture only.',controls_md:'Synthetic rejection outcomes.',controls:[{name:'wrong target',detected:true,note:'Synthetic detection'}],limits_md:'No real mathematical or compiler result is asserted.',lean};
 const submit=async()=>{await saveCheckReceipt(f.result,f.job,raw,f.authenticated);return Number((await one(`SELECT id FROM verification_runs WHERE result_return_id=$1 ORDER BY id DESC LIMIT 1`,[f.result.id])).id);};return {...f,raw,submit};
}
const current=async(run,proof)=>(await one(`SELECT lean_execution_current($1,$2) AS ok`,[run,proof.id])).ok;

test('kernel reuses independently reviewed exact v2 science without execution approval; SQL digest matches JS transport',async()=>{
 const {proof}=await kernelSubject();assert.deepEqual(await science(proof),[true,true]);assert.equal(await sqlExecution(proof),false);assert.equal(await leanExecutionReviewed(proof),true);
 const sql=await one(`SELECT lean_identity_binding('solveathome-verification-v1',$1::jsonb-'cost') AS fp`,[JSON.stringify(proof.verification_plan)]);assert.equal(sql.fp,proof.verification_fingerprint);
 await queueCheck(proof);const job=await one(`SELECT * FROM jobs WHERE type='check' AND evidence_return_id=$1 ORDER BY id DESC LIMIT 1`,[proof.id]);assert.deepEqual(job.required_tools,['lean']);assert.match(job.brief_md,/policy lean-kernel-v1/);assert.doesNotMatch(job.brief_md,/must validate a regenerated export/);const reasons=await dispatchReasons(proof);assert.ok(!reasons.some(r=>/statement review|execution.*review|execution.*contract/i.test(r)));
});

test('completed kernel receipt binds exact actual upload pins, object and custody without a raw export requirement',async()=>{
 const {proof}=await kernelSubject({descriptor:true});await validateLeanIdentityArtifacts(proof.verification_plan);
 const p=proof.verification_plan.lean;assert.equal(await one(`SELECT 1 FROM files WHERE sha256=$1`,[p.kernel_objects[0].artifact.sha256]),undefined,'external object descriptor never pretends raw object uploaded');
 const f=await kernelReceipt(proof),id=await f.submit();assert.equal(await current(id,proof),true);
 assert.equal((await leanVerificationSummary(proof.id,p.manuscript_sha256)).status,'awaiting_review');
 const rv=await one(`INSERT INTO reviews(return_id,user_id,model,provider,verdict,notes_md,trusted,effort,verification_receipt_id,verification_sufficiency_md) VALUES($1,$2,$3,'fixture','accept','Synthetic finished judgment',true,'high',$4,$5) RETURNING id`,[proof.id,owner,AUTHOR,id,'Synthetic assessment of mathematical claim match and correctness, replay source/object custody, axiom closure, isolation, controls and explicit limits.']);
 assert.equal((await leanVerificationSummary(proof.id,p.manuscript_sha256)).status,'awaiting_review');await q(`UPDATE reviews SET model=$2 WHERE id=$1`,[rv.id,OTHER]);const summary=await leanVerificationSummary(proof.id,p.manuscript_sha256);assert.equal(summary.status,'checked');assert.equal(summary.policy,'lean-kernel-v1');assert.equal(summary.current_evidence.execution_review_id,undefined);
 await q(`DELETE FROM file_refs WHERE ref_type='return' AND ref_id=$1 AND file_sha=$2`,[f.result.id,f.raw.lean.custody_sha256]);assert.equal(await current(id,proof),false);await q(`INSERT INTO file_refs(file_sha,ref_type,ref_id) VALUES($1,'return',$2)`,[f.raw.lean.custody_sha256,f.result.id]);assert.equal(await current(id,proof),true);
 const unused=p.scientific_identity.proof_artifacts[0].artifact.sha256;await q(`UPDATE files SET deleted_at=now() WHERE sha256=$1`,[unused]);assert.equal(await current(id,proof),true,'supplemental export is not a kernel assurance input');await q(`UPDATE files SET deleted_at=NULL WHERE sha256=$1`,[unused]);
});

test('kernel intake rejects relabelled comparator evidence, wrong objects, foreign identities and missing custody bytes',async()=>{
 const {proof}=await kernelSubject(),f=await kernelReceipt(proof);
 for(const mutate of [e=>e.policy='lean-comparator-v2',e=>e.claims[0].proof_sha256=digest('export'),e=>e.claims[0].object_sha256=digest('substitute'),e=>e.execution_identity=digest('foreign'),e=>e.scientific_identity=digest('foreign')]){const raw=clone(f.raw);mutate(raw.lean);await assert.rejects(saveCheckReceipt(f.result,f.job,raw,f.authenticated));}
 const sha=proof.verification_plan.lean.kernel_custody.sources.sha256;await q(`UPDATE files SET bytes=bytes+1 WHERE sha256=$1`,[sha]);await assert.rejects(f.submit(),/bytes|size/i);await q(`UPDATE files SET bytes=bytes-1 WHERE sha256=$1`,[sha]);assert.equal(await current(await f.submit(),proof),true);
});

test('kernel SQL rejects wrong object/policy identity even if an attacker synthesizes a matching observation snapshot',async()=>{
 const {proof}=await kernelSubject(),f=await kernelReceipt(proof),id=await f.submit(),saved=await one(`SELECT * FROM verification_runs WHERE id=$1`,[id]);
 for(const mutate of [e=>e.policy='lean-comparator-v2',e=>e.claims[0].object_sha256=digest('foreign'),e=>e.claims[0].proof_sha256=digest('export'),e=>e.execution_identity=digest('foreign'),e=>e.scientific_identity=digest('foreign')]){const details=clone(saved.details);mutate(details.lean);await q(`UPDATE verification_runs SET details=$2 WHERE id=$1`,[id,JSON.stringify(details)]);await q(`UPDATE verification_runs SET execution_attestation=jsonb_set(execution_attestation,'{receipt}',lean_execution_snapshot(id)) WHERE id=$1`,[id]);assert.equal(await current(id,proof),false);}
 await q(`UPDATE verification_runs SET details=$2 WHERE id=$1`,[id,JSON.stringify(saved.details)]);await q(`UPDATE verification_runs SET execution_attestation=jsonb_set(execution_attestation,'{receipt}',lean_execution_snapshot(id)) WHERE id=$1`,[id]);assert.equal(await current(id,proof),true);
 const changed=clone(proof.verification_plan);changed.lean.execution_identity.resources.cpu_count=1;await q(`UPDATE returns SET verification_plan=$2 WHERE id=$1`,[proof.id,JSON.stringify(changed)]);assert.equal(await current(id,proof),false,'tampered execution cannot retain the old full fingerprint');await q(`UPDATE returns SET verification_plan=$2 WHERE id=$1`,[proof.id,JSON.stringify(proof.verification_plan)]);
});

test('kernel current receipts preserve authenticated assignment, immutable observations, exact fingerprint and current grants',async()=>{
 const {proof}=await kernelSubject(),f=await kernelReceipt(proof,worker),id=await f.submit(),saved=await one(`SELECT * FROM verification_runs WHERE id=$1`,[id]);assert.equal(await current(id,proof),true);
 const changed=clone(proof.verification_plan);changed.environment='Synthetic changed observation declaration';const other=await ret(changed);assert.deepEqual(await science(other),[true,true]);assert.equal(await current(id,other),false);
 await q(`UPDATE verification_runs SET observed='tampered observation' WHERE id=$1`,[id]);assert.equal(await current(id,proof),false);await q(`UPDATE verification_runs SET observed=$2 WHERE id=$1`,[id,saved.observed]);assert.equal(await current(id,proof),true);
 await q(`UPDATE assignment_attempts SET model=$2 WHERE id=$1`,[f.attempt,OTHER]);assert.equal(await current(id,proof),false);await q(`UPDATE assignment_attempts SET model=$2 WHERE id=$1`,[f.attempt,AUTHOR]);
 await q(`UPDATE sessions SET user_id=$2 WHERE id=$1`,[f.authenticated.sessionId,owner]);assert.equal(await current(id,proof),false);await q(`UPDATE sessions SET user_id=$2 WHERE id=$1`,[f.authenticated.sessionId,worker]);assert.equal(await current(id,proof),true);
 await q(`UPDATE project_roles SET revoked_at=now() WHERE problem_id=$1 AND user_id=$2`,[pid,worker]);assert.equal(await current(id,proof),false);await q(`UPDATE project_roles SET revoked_at=NULL,granted_at=now() WHERE problem_id=$1 AND user_id=$2`,[pid,worker]);assert.equal(await current(id,proof),false);
});

test('mathematical/source changes invalidate kernel review; stronger comparator-v2 still requires independent execution review',async()=>{
 const {proof,review}=await kernelSubject();for(const mutate of [s=>s.manuscript.sha256=digest('math change'),s=>s.claims[0].assumptions.push('hidden assumption'),s=>s.source_artifacts[0].sha256=digest('source change'),s=>s.semantic_dependencies[0].revision='f'.repeat(40)]){const p=clone(proof.verification_plan);mutate(p.lean.scientific_identity);const changed=await ret(p);assert.equal(await sqlScience(changed),false);assert.ok((await dispatchReasons(changed)).some(r=>/statement|science/i.test(r)));}
 await q(`UPDATE reviews SET effort='medium' WHERE id=$1`,[review.id]);assert.deepEqual(await science(proof),[false,false]);await q(`UPDATE reviews SET effort='high' WHERE id=$1`,[review.id]);
 const {proof:strong}=await reviewed();const plan=clone(strong.verification_plan);plan.lean.execution_review_id=null;const blocked=await ret(plan);assert.equal(await sqlExecution(blocked),false);assert.equal(await leanExecutionReviewed(blocked),false);assert.ok((await dispatchReasons(blocked)).some(r=>/execution.*review|execution.*contract/i.test(r)));
});


test('current Lean authority invalidates route certificates on external statement, custody and manuscript changes',async()=>{
 const {proof,review}=await kernelSubject();const f=await kernelReceipt(proof),id=await f.submit();
 await q(`INSERT INTO reviews(return_id,user_id,model,provider,verdict,notes_md,trusted,effort,verification_receipt_id,verification_sufficiency_md) VALUES($1,$2,$3,'fixture','accept','Synthetic judgment',true,'high',$4,$5)`,[proof.id,owner,OTHER,id,'Synthetic assessment of mathematical claim match and correctness, replay source/object custody, axiom closure, isolation, controls and explicit limits.']);
 const p=proof.verification_plan.lean;
 const paper=await one(`INSERT INTO papers(problem_id,slug,title,current_file_sha) VALUES($1,$2,'Synthetic manuscript',$3) RETURNING id`,[pid,p.paper_slug,p.manuscript_sha256]);
 mkdirSync(join(process.env.PROJECTS_DIR,slug),{recursive:true});writeFileSync(join(process.env.PROJECTS_DIR,slug,'project.json'),JSON.stringify({slug,research_collaboration:{enabled:true,topics:[]}}));
 const {stepInputVector,holdForStepCheck}=await import('../src/lib/research.ts');
 const {verificationSummary}=await import('../src/lib/verification.ts');
 assert.equal((await verificationSummary(Number(proof.id))).lean.status,'checked');
 const route=await one(`INSERT INTO research_routes(problem_id,origin_return_id,title,contribution_md,prior_art_md,uncertainty_md,state,next_step) VALUES($1,$2,'Gate','C','P','U','active',$3) RETURNING *`,[pid,proof.id,JSON.stringify({question:'Is the remaining gate open?',method:'Inspect the evidence.',success:'Gate holds.',failure:'Gate fails.',budget_hours:.5})]);
 await q('UPDATE returns SET research_route_id=$2 WHERE id=$1',[proof.id,route.id]);
 const cert=await stepInputVector(pid,Number(route.id));
 assert.deepEqual(await stepInputVector(pid,Number(route.id)),cert,'unchanged authority reuses certificate');
 const job=await one(`INSERT INTO jobs(problem_id,type,title,brief_md,min_tier,budget_hours,purpose,research_stage,research_route_id,research_source_return_id,step_checked_through,step_checked_vector) VALUES($1,'explore','Pursuit','Pursuit',1,.5,'discovery','pursue',$2,$3,$3,$4) RETURNING *`,[pid,route.id,proof.id,JSON.stringify(cert)]);
 await q('UPDATE reviews SET needs_reassessment=true WHERE id=$1',[review.id]);
 assert.equal((await verificationSummary(Number(proof.id))).lean.status,'no_proof');
 assert.notDeepEqual(await stepInputVector(pid,Number(route.id)),cert);
 const held=await holdForStepCheck(job);assert.equal(Number(held.step_check_of),Number(job.id));
 await q('UPDATE reviews SET needs_reassessment=false WHERE id=$1',[review.id]);
 assert.deepEqual(await stepInputVector(pid,Number(route.id)),cert,'restoring unchanged authority restores its scientific digest');
 await q(`DELETE FROM file_refs WHERE ref_type='return' AND ref_id=$1 AND file_sha=$2`,[f.result.id,f.raw.lean.custody_sha256]);
 assert.notDeepEqual(await stepInputVector(pid,Number(route.id)),cert);
 await q(`INSERT INTO file_refs(file_sha,ref_type,ref_id) VALUES($1,'return',$2)`,[f.raw.lean.custody_sha256,f.result.id]);
 assert.deepEqual(await stepInputVector(pid,Number(route.id)),cert);
 const changed='Synthetic manuscript: changed claim.';await uploadArtifacts([['changed.md',changed]]);
 await q(`UPDATE papers SET current_file_sha=$2 WHERE id=$1`,[paper.id,digest(changed)]);
 assert.equal((await verificationSummary(Number(proof.id))).lean.status,'stale');
 assert.notDeepEqual(await stepInputVector(pid,Number(route.id)),cert);
});
