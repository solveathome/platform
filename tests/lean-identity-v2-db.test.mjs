// Synthetic authorization records only: these tests run no Lean and assert no mathematical result.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {leanV2Fixture} from './fixtures/lean-v2.mjs';
import {leanFixture,digest} from './fixtures/lean.mjs';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database.');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
const temp=mkdtempSync(join(tmpdir(),'lean-v2-db-'));process.env.FILES_DIR=join(temp,'files');
const {q,one,pool,migrate}=await import('../src/db/index.ts');
const {modelTier}=await import('../src/lib/auth.ts');
const {TERMS_VERSION}=await import('../src/lib/terms.ts');
const {parseVerificationPlan,fingerprint,leanStatementReviewed,saveCheckReceipt,verificationRuns,leanVerificationSummary}=await import('../src/lib/verification.ts');
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
    [700000000+Math.floor(Math.random()*1e8),'identity-v2-'+name+'-'+randomUUID().slice(0,8),TERMS_VERSION])).id);
  owner=await user('owner');worker=await user('worker');slug='identity-v2-'+randomUUID().slice(0,8);
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
function encodedProofFixture() {
  const {plan,artifacts}=leanV2Fixture(),artifact=plan.lean.scientific_identity.proof_artifacts[0].artifact;
  // Declared large decoded bytes are inert test data. These small inputs do not encode a real mathematical proof.
  artifact.sha256=digest('Synthetic declared large decoded proof');artifact.bytes=6*1024**2+123;
  const chunks=[['proof.part-1.txt','Synthetic encoded chunk one','certificate'],['proof.part-2.txt','Synthetic encoded chunk two','certificate']];
  const inputs=chunks.map(([path,content])=>({path,sha256:digest(content),bytes:Buffer.byteLength(content)}));
  const recipe=clone(plan.lean.execution_identity.invocation),path='proof-descriptor.json';
  const descriptor={schema:'solveathome-lean-artifact-descriptor-v2',artifacts:[{artifact:clone(artifact),category:'proof',representation:{inputs:clone(inputs),recipe:clone(recipe)}}]};
  const content=JSON.stringify(descriptor),descriptorArtifact={path,sha256:digest(content),bytes:Buffer.byteLength(content)};
  plan.manifest=plan.manifest.filter(f=>f.path!==artifact.path);
  plan.manifest.push({path,sha256:descriptorArtifact.sha256,role:'dependency'},...inputs.map(a=>({path:a.path,sha256:a.sha256,role:'certificate'})));
  plan.lean.artifact_roles=plan.lean.artifact_roles.filter(r=>r.path!==artifact.path);
  plan.lean.artifact_roles.push({path,kind:'provenance'},...inputs.map(a=>({path:a.path,kind:'scientific'})));
  const binding=plan.lean.artifact_bindings.find(b=>b.artifact.path===artifact.path);
  binding.artifact=clone(artifact);binding.representation={kind:'descriptor',path};
  plan.lean.proof_representations=[{artifact:clone(artifact),descriptor:descriptorArtifact,inputs,recipe}];
  return {plan:parseVerificationPlan(plan),artifacts:[...artifacts.filter(a=>a[0]!==artifact.path),[path,content,'dependency'],...chunks]};
}
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
    VALUES($1,'check','Synthetic dispatch check','No execution.',99,0.5,$2,ARRAY['lean','lean-comparator-linux']) RETURNING id`,[pid,proof.id]);
  return whyNotEligible({problemId:pid,slug,sessionId:'',uid:owner,tier:1,model:AUTHOR,provider:'fixture',trusted:true,granted:true,lane:null,
    cpuHours:8,ramGb:32,hasGpu:false,disk:10,maxHours:4,reviewStreak:0,capabilities:{tools:['lean','lean-comparator-linux']}},job.id);
}

test('v2 SQL bindings agree with canonical JavaScript, including Unicode, escapes and reordered object keys',async()=>{
  const value={z:['δ\n"\\',true,1,null],a:{meaning:'é\t数学',empty:{},list:[]}};
  const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
  const row=await one(`SELECT lean_identity_canonical($1::jsonb) AS value,lean_identity_binding($2,$1::jsonb) AS binding`,[JSON.stringify(value),'fixture-domain']);
  assert.equal(row.value,JSON.stringify(canonical(value)));
  assert.equal(row.binding,digest('fixture-domain\n'+JSON.stringify(canonical(value))));
});

test('v2 machine observations and proof exports preserve meaning review; full package identity still changes',async()=>{
  const {proof}=await reviewed();assert.deepEqual(await science(proof),[true,true]);assert.equal(await sqlExecution(proof),true);
  for(const mutate of [p=>p.environment='Synthetic observed host B',p=>p.command='Synthetic portable invocation on host B',
    p=>p.lean.scientific_identity.proof_artifacts[0].artifact.sha256=digest('Synthetic revised proof export')]) {
    const plan=clone(proof.verification_plan);mutate(plan);const other=await ret(plan);
    assert.deepEqual(await science(other),[true,true]);assert.equal(await sqlExecution(other),true);
    assert.notEqual(other.verification_fingerprint,proof.verification_fingerprint,'full package receipt reuse remains exact');
  }
});

test('v2 execution mutations preserve valid science but block dispatch and new receipts until independently reviewed',async()=>{
  const {proof}=await reviewed();
  for(const mutate of [e=>e.validator.sha256=digest('Synthetic revised validator'),e=>e.tools[0].binary_sha256=digest('Synthetic revised binary'),
    e=>e.invocation.sha256=digest('Synthetic revised invocation'),e=>e.runtime_paths.tools='/tools/released',
    e=>e.isolation.policy_sha256=digest('Synthetic revised isolation policy'),e=>e.resources.cpu_count=1]) {
    const plan=clone(proof.verification_plan);mutate(plan.lean.execution_identity);const changed=await ret(plan);
    assert.deepEqual(await science(changed),[true,true]);assert.equal(await sqlExecution(changed),false);
    assert.ok((await dispatchReasons(changed)).some(reason=>/execution|contract/i.test(reason)),'SQL dispatch refuses stale execution review');
    const f=await check(changed);
    await assert.rejects(saveCheckReceipt(f.result,f.job,{fingerprint:changed.verification_fingerprint,execution_policy:'authenticated-contributor-v1',
      attestation_md:'Synthetic personally observed test execution, artifacts and limits.'},f.authenticated),/execution|contract/i);
  }
});

test('a new independently accepted execution review restores dispatch while retaining the original meaning review',async()=>{
  const {proof}=await reviewed(),plan=clone(proof.verification_plan);
  plan.lean.execution_identity.resources.cpu_count=1;
  const changed=await reviewed(plan),restored=clone(changed.proof.verification_plan);
  restored.lean.statement_review_id=proof.verification_plan.lean.statement_review_id;
  const ready=await ret(restored);
  assert.deepEqual(await science(ready),[true,true]);assert.equal(await sqlExecution(ready),true);
  assert.ok(!(await dispatchReasons(ready)).some(reason=>/statement review|execution.*review|execution.*contract/i.test(reason)));
  const f=await check(ready);
  await saveCheckReceipt(f.result,f.job,{fingerprint:ready.verification_fingerprint,execution_policy:'authenticated-contributor-v1',outcome:'unable',
    observed:'Synthetic local fixture could not execute; no mathematical result is asserted.',elapsed_seconds:1,
    attestation_md:'Synthetic personally observed inability, authenticated account/session and explicit execution limits.',
    method:'rerun',exit_code:null,environment:'Synthetic host B',coverage_md:'No claims executed.',shared_components_md:'Synthetic fixture only.',
    controls_md:'No controls executed.',limits_md:'No actual Lean execution occurred.'},f.authenticated);
  const saved=await one(`SELECT id,lean_execution_current(id,$2) AS current FROM verification_runs WHERE result_return_id=$1`,[f.result.id,ready.id]);
  assert.equal(saved.current,true,'intake and SQL agree on an authenticated inability under the newly reviewed contract');
});

test('v2 manuscript, statements, claim assumptions, source inventory and semantic dependencies invalidate science',async()=>{
  const {proof}=await reviewed();
  for(const mutate of [s=>s.manuscript.sha256=digest('Synthetic revised manuscript'),s=>s.statement_bundle.sha256=digest('Synthetic revised definitions'),
    s=>s.claims[0].assumptions.push('Synthetic additional hypothesis'),s=>s.claims[0].declaration='Fixture.other',
    s=>s.source_artifacts[0].sha256=digest('Synthetic revised authored source'),s=>s.semantic_dependencies[0].revision='b'.repeat(40),
    s=>s.semantic_dependencies[0].source.sha256=digest('Synthetic revised dependency source'),s=>s.axiom_policy.push('sorryAx')]) {
    const plan=clone(proof.verification_plan);mutate(plan.lean.scientific_identity);const changed=await ret(plan);
    assert.equal(await sqlScience(changed),false);assert.equal(await sqlExecution(changed),true);
    assert.ok((await dispatchReasons(changed)).some(reason=>/statement|science/i.test(reason)),'dispatch requires current mathematical review');
  }
});

test('a completed v2 synthetic receipt needs separate independent mathematical judgment to count',async()=>{
  await uploadArtifacts(leanV2Fixture().artifacts);
  const {proof}=await reviewed(),p=proof.verification_plan.lean,f=await leanExecutionFixture(proof,owner,AUTHOR);
  f.raw.lean.scientific_identity=leanScientificBinding(p);f.raw.lean.execution_identity=leanExecutionBinding(p);
  f.raw.lean.proof_files=clone(p.proof_representations);
  for(const claim of f.raw.lean.claims) {
    claim.proof_sha256=p.scientific_identity.proof_artifacts.find(a=>a.claim_ids.includes(claim.id)).artifact.sha256;
    await q(`INSERT INTO files(sha256,user_id,model,name,ext,bytes) VALUES($1,$2,$3,'fixture.export','export',$4) ON CONFLICT DO NOTHING`,[claim.proof_sha256,owner,AUTHOR,p.scientific_identity.proof_artifacts.find(a=>a.claim_ids.includes(claim.id)).artifact.bytes]);
  }
  const receipt=await f.submit();
  assert.equal((await verificationRuns(proof.id)).find(r=>Number(r.id)===Number(receipt.id)).trusted_execution,true);
  assert.equal((await leanVerificationSummary(proof.id,p.manuscript_sha256)).status,'awaiting_review','synthetic pass cannot self-approve mathematics');
  const correctness=await one(`INSERT INTO reviews(return_id,user_id,model,provider,verdict,notes_md,trusted,effort,verification_receipt_id,verification_sufficiency_md)
    VALUES($1,$2,$3,'fixture','accept','Synthetic mathematical judgment',true,'high',$4,$5) RETURNING id`,[proof.id,owner,AUTHOR,receipt.id,
      'Synthetic assessment of mathematical correctness, mapped claims, proof reasoning and assumptions, and of receipt authenticity, isolation, negative controls and limits.']);
  assert.equal((await leanVerificationSummary(proof.id,p.manuscript_sha256)).status,'awaiting_review','same-family semantic judgment never counts');
  await q(`UPDATE reviews SET model=$2 WHERE id=$1`,[correctness.id,OTHER]);
  const summary=await leanVerificationSummary(proof.id,p.manuscript_sha256);
  assert.equal(summary.status,'checked','this checks classification of synthetic records, never an actual mathematical result');
  assert.equal(summary.current_evidence.execution_review_id,p.execution_review_id);
});

test('v2 large decoded proof observations bind exact uploaded encoded chunks, descriptor and reviewed recipe',async()=>{
  const fixture=encodedProofFixture();await uploadArtifacts(fixture.artifacts);
  const {proof}=await reviewed(fixture.plan),p=proof.verification_plan.lean,f=await leanExecutionFixture(proof,owner,AUTHOR);
  f.raw.lean.scientific_identity=leanScientificBinding(p);f.raw.lean.execution_identity=leanExecutionBinding(p);f.raw.lean.proof_files=clone(p.proof_representations);
  const representation=p.proof_representations[0];f.raw.lean.claims[0].proof_sha256=representation.artifact.sha256;
  assert.ok(representation.artifact.bytes>5*1024**2,'declared decoded fixture exceeds the existing upload cap');
  assert.equal(await one(`SELECT 1 FROM files WHERE sha256=$1`,[representation.artifact.sha256]),undefined,'decoded proof is never physically uploaded');
  const saved=await f.submit();
  const current=async()=>(await one(`SELECT lean_execution_current($1,$2) AS ok`,[saved.id,proof.id])).ok;
  assert.equal(await current(),true,'exact encoded representation permits an authenticated observation without raw upload');
  const chunk=representation.inputs[0];
  await q(`DELETE FROM file_refs WHERE file_sha=$1 AND ref_type='return' AND ref_id=$2`,[chunk.sha256,f.ret.id]);
  assert.equal(await current(),false,'each encoded chunk must be attached to the authenticated execution return');
  await q(`INSERT INTO file_refs(file_sha,ref_type,ref_id) VALUES($1,'return',$2)`,[chunk.sha256,f.ret.id]);assert.equal(await current(),true);
  await q(`UPDATE files SET deleted_at=now() WHERE sha256=$1`,[chunk.sha256]);assert.equal(await current(),false,'deleted chunk is unavailable');
  await assert.rejects(f.submit(),/not available|upload/i);
  await q(`UPDATE files SET deleted_at=NULL,bytes=bytes+1 WHERE sha256=$1`,[chunk.sha256]);assert.equal(await current(),false,'physical encoded lengths remain exact');
  await q(`UPDATE files SET bytes=bytes-1 WHERE sha256=$1`,[chunk.sha256]);assert.equal(await current(),true);
  const replacement=clone(f.raw);replacement.lean.proof_files[0].descriptor.sha256=digest('Synthetic replaced descriptor');
  await assert.rejects(saveCheckReceipt(f.ret,f.job,replacement,f.authenticated),/transport|representation/i);
  const wrongDecoded=clone(f.raw);wrongDecoded.lean.claims[0].proof_sha256=digest('Synthetic wrong decoded bytes');
  await assert.rejects(saveCheckReceipt(f.ret,f.job,wrongDecoded,f.authenticated),/proof hash|transport|claim/i);
  for(const mutate of [e=>e.proof_files[0].descriptor.sha256=digest('Synthetic replaced descriptor'),
    e=>e.claims[0].proof_sha256=digest('Synthetic wrong decoded bytes'),e=>e.proof_files[0].inputs.pop(),
    e=>e.scientific_identity=digest('Synthetic different scientific identity'),e=>e.execution_identity=digest('Synthetic different execution identity')]) {
    const details=clone(saved.details);mutate(details.lean);
    await q(`UPDATE verification_runs SET details=$2 WHERE id=$1`,[saved.id,JSON.stringify(details)]);
    // Even a freshly synthesized test snapshot cannot authorize references that differ from the pinned representation.
    await q(`UPDATE verification_runs SET execution_attestation=jsonb_set(execution_attestation,'{receipt}',lean_execution_snapshot(id)) WHERE id=$1`,[saved.id]);
    assert.equal(await current(),false,'exact representation gates apply independently of the observation snapshot');
  }
  await q(`UPDATE verification_runs SET details=$2 WHERE id=$1`,[saved.id,JSON.stringify(saved.details)]);
  await q(`UPDATE verification_runs SET execution_attestation=jsonb_set(execution_attestation,'{receipt}',lean_execution_snapshot(id)) WHERE id=$1`,[saved.id]);
  assert.equal(await current(),true);
});

test('v2 accepted distinct-family Tier1/high source reviews and exact binding hashes are current requirements',async()=>{
  const {source,review,proof}=await reviewed();
  for(const change of ["model='claude-opus-5-5'","effort='medium'","trusted=false","verdict='reject'","needs_reassessment=true"]) {
    await q(`UPDATE reviews SET ${change} WHERE id=$1`,[review.id]);
    assert.equal(await sqlScience(proof),false);assert.equal(await sqlExecution(proof),false);
    await q(`UPDATE reviews SET model=$2,effort='high',trusted=true,verdict='accept',needs_reassessment=false WHERE id=$1`,[review.id,OTHER]);
  }
  await q(`UPDATE reviews SET lean_statement_review=jsonb_set(lean_statement_review,'{binding_sha256}',to_jsonb($2::text)) WHERE id=$1`,[review.id,digest('Synthetic wrong meaning binding')]);
  assert.equal(await sqlScience(proof),false);assert.equal(await sqlExecution(proof),true);
  await q(`UPDATE reviews SET lean_statement_review=$2 WHERE id=$1`,[review.id,JSON.stringify(review.lean_statement_review)]);
  await q(`UPDATE reviews SET lean_execution_review=jsonb_set(lean_execution_review,'{binding_sha256}',to_jsonb($2::text)) WHERE id=$1`,[review.id,digest('Synthetic wrong contract binding')]);
  assert.equal(await sqlScience(proof),true);assert.equal(await sqlExecution(proof),false);
  await q(`UPDATE reviews SET lean_execution_review=$2 WHERE id=$1`,[review.id,JSON.stringify(review.lean_execution_review)]);
  await q(`UPDATE returns SET provisional=true WHERE id=$1`,[source.id]);
  assert.equal(await sqlScience(proof),false);assert.equal(await sqlExecution(proof),false);
});

test('v2 current receipts retain exact fingerprint, immutable observations, authenticated assignment and current grant checks',async()=>{
  const {proof}=await reviewed(),f=await check(proof,worker);
  const receipt=await one(`INSERT INTO verification_runs(subject_return_id,result_return_id,fingerprint,outcome,observed,elapsed_seconds,details)
    VALUES($1,$2,$3,'unable','Synthetic machine A observation',1,$4) RETURNING *`,[proof.id,f.result.id,proof.verification_fingerprint,
      JSON.stringify({execution_policy:'authenticated-contributor-v1',attestation_md:'Synthetic fixture observation with actual recorded account/session and explicit inability limits.',environment:'Synthetic host A',namespace_inode:10})]);
  const current=async(subject=proof)=>(await one(`SELECT lean_execution_current($1,$2) AS ok`,[receipt.id,subject.id])).ok;
  assert.equal(await current(),false,'historical receipt has no authenticated provenance');
  await q(`UPDATE verification_runs SET execution_attestation=jsonb_build_object('version','authenticated-contributor-v1','authority',lean_execution_authority($2,$3),'receipt',lean_execution_snapshot(id)) WHERE id=$1`,[receipt.id,pid,worker]);
  assert.equal(await current(),true,'an authenticated inability is eligible evidence, never a completed proof');
  const identical=await ret(proof.verification_plan);assert.equal(await current(identical),true,'only exact full packages reuse receipts');
  const changedPlan=clone(proof.verification_plan);changedPlan.environment='Synthetic host B package';const changed=await ret(changedPlan);
  assert.deepEqual(await science(changed),[true,true]);assert.equal(await current(changed),false,'same mathematical review never relaxes full fingerprint equality');
  await q(`UPDATE verification_runs SET observed='Synthetic machine B observation' WHERE id=$1`,[receipt.id]);assert.equal(await current(),false,'observation tampering invalidates attestation');
  await q(`UPDATE verification_runs SET observed=$2 WHERE id=$1`,[receipt.id,receipt.observed]);assert.equal(await current(),true);
  await q(`UPDATE assignment_attempts SET model=$2 WHERE id=$1`,[f.attempt,OTHER]);assert.equal(await current(),false,'assignment/model mismatch fails');
  await q(`UPDATE assignment_attempts SET model=$2 WHERE id=$1`,[f.attempt,AUTHOR]);assert.equal(await current(),true);
  await q(`UPDATE sessions SET user_id=$2 WHERE id=$1`,[f.authenticated.sessionId,owner]);assert.equal(await current(),false,'authenticated account/session mismatch fails');
  await q(`UPDATE sessions SET user_id=$2 WHERE id=$1`,[f.authenticated.sessionId,worker]);assert.equal(await current(),true);
  const tampered=clone(proof.verification_plan);tampered.lean.execution_identity.resources.cpu_count=1;
  await q(`UPDATE returns SET verification_plan=$2 WHERE id=$1`,[proof.id,JSON.stringify(tampered)]);
  assert.equal(await sqlScience(proof),true);assert.equal(await current(),false,'execution contract tampering cannot retain an old attestation');
  await q(`UPDATE returns SET verification_plan=$2 WHERE id=$1`,[proof.id,JSON.stringify(proof.verification_plan)]);assert.equal(await current(),true);
  await q(`UPDATE project_roles SET revoked_at=now() WHERE problem_id=$1 AND user_id=$2`,[pid,worker]);assert.equal(await current(),false);
  await q(`UPDATE project_roles SET revoked_at=NULL,granted_at=now() WHERE problem_id=$1 AND user_id=$2`,[pid,worker]);assert.equal(await current(),false,'replacement grant cannot revive old attestation');
});

test('v1 exact profile equality and historical receipts retain their existing behavior',async()=>{
  const plan=parseVerificationPlan(leanFixture().plan),source=await ret(plan);
  const review=await one(`INSERT INTO reviews(return_id,user_id,model,provider,verdict,notes_md,trusted,effort,lean_statement_review)
    VALUES($1,$2,$3,'fixture','accept','Synthetic legacy review',true,'high',$4) RETURNING id`,[source.id,owner,OTHER,JSON.stringify({binding_sha256:leanStatementBinding(plan.lean),meaning_md:'Synthetic legacy meaning.'})]);
  plan.lean.statement_review_id=Number(review.id);const proof=await ret(plan);
  assert.deepEqual(await science(proof),[true,true]);
  const f=await leanExecutionFixture(proof,owner,AUTHOR),originalLean=clone(f.raw.lean);
  f.raw.lean={...originalLean,policy:'lean-comparator-v2',scientific_identity:leanScientificBinding(base.lean),
    execution_identity:leanExecutionBinding(base.lean),proof_files:clone(base.lean.proof_representations)};
  await assert.rejects(f.submit(),/v2.*v1|v1.*v2|assigned.*profile|policy/i,'a claimed v2 receipt cannot relax the v1 raw-proof upload contract');
  f.raw.lean=originalLean;
  const rawProof=originalLean.claims[0].proof_sha256;
  await q(`UPDATE files SET deleted_at=now() WHERE sha256=$1`,[rawProof]);
  await assert.rejects(f.submit(),/upload actual Lean audit, axiom and proof exports/i,'v1 still requires uploaded raw decoded proof bytes');
  await q(`UPDATE files SET deleted_at=NULL WHERE sha256=$1`,[rawProof]);
  const changed=clone(plan);changed.lean.comparator_revision='c'.repeat(40);assert.deepEqual(await science(await ret(changed)),[false,false]);
  const legacyResult=await ret(plan,'recorded');
  const historical=await one(`INSERT INTO verification_runs(subject_return_id,result_return_id,fingerprint,outcome,observed,elapsed_seconds,details)
    VALUES($1,$2,$3,'unable','Synthetic historical inability',1,'{}') RETURNING id`,[proof.id,legacyResult.id,proof.verification_fingerprint]);
  await migrate();
  const preserved=await one(`SELECT execution_attestation,lean_execution_current(id,$2) AS current FROM verification_runs WHERE id=$1`,[historical.id,proof.id]);
  assert.equal(preserved.execution_attestation,null,'migration never backfills authenticated provenance');
  assert.equal(preserved.current,false,'historical observations never become trusted execution');
});
