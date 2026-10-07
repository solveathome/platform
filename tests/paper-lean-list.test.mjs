// The paper page's Lean list shows each package's decided state (Oct 6 2026: rejected kk-lower-bound packages read "awaiting review").
// Synthetic records only: no Lean runs and no mathematical result is asserted.
import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {randomUUID} from 'node:crypto';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database.');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
const {q,one,pool,migrate}=await import('../src/db/index.ts');
const {modelTier}=await import('../src/lib/auth.ts');
const {TERMS_VERSION}=await import('../src/lib/terms.ts');
const {leanFixture,leanEvidence}=await import('./fixtures/lean.mjs');
const {leanStatementBinding}=await import('../src/lib/lean-verification.ts');
const {paperLeanVerification}=await import('../src/lib/verification.ts');

let pid, author, reviewer;
before(async()=>{
  await migrate();
  for (const m of ['claude-opus-5-5','gpt-6.1-sol']) await modelTier(m);
  const user=async(n)=>Number((await one(`INSERT INTO users (github_id,handle,terms_version,terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`,[600000000+Math.floor(Math.random()*1e8),'paper-lean-'+n+'-'+randomUUID().slice(0,8),TERMS_VERSION])).id);
  author=await user('author'); reviewer=await user('reviewer');
  pid=Number((await one(`INSERT INTO problems (slug,name,repo_url,status_md) VALUES ($1,'Paper Lean list','https://example.org/p','open') RETURNING id`,['paper-lean-'+randomUUID().slice(0,8)])).id);
  await q(`INSERT INTO project_roles (problem_id,user_id,role,note) VALUES ($1,$2,'trusted','test')`,[pid,reviewer]);
});
after(async()=>{
  await q(`DELETE FROM verification_runs WHERE subject_return_id IN (SELECT id FROM returns WHERE problem_id=$1) OR result_return_id IN (SELECT id FROM returns WHERE problem_id=$1)`,[pid]);
  await q(`DELETE FROM reviews WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`,[pid]);
  await q(`UPDATE returns SET superseded_by=NULL WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM returns WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM project_roles WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM problems WHERE id=$1`,[pid]);
  await q(`DELETE FROM users WHERE id = ANY($1::bigint[])`,[[author,reviewer]]);
  await pool.end();
});

test('rejected and superseded packages show their decision; a rejected one names the later accepted package with the same statements', async()=>{
  const {plan}=leanFixture(); const binding=leanStatementBinding(plan.lean);
  const ret=async(status,p,extra='')=>one(`INSERT INTO returns (problem_id,type,user_id,model,provider,report_md,transcript,status,verification_plan,verification_fingerprint,effort)
    VALUES ($1,'formalize',$2,'claude-opus-5-5','anthropic','fixture','t',$3,$4,$5,'high') RETURNING *`,[pid,author,status,JSON.stringify(p),randomUUID()]);
  // The accepted statement proposal and its trusted statement review.
  const source=await ret('accepted',plan);
  const sreview=await one(`INSERT INTO reviews (return_id,user_id,model,provider,verdict,rung,notes_md,trusted,effort,lean_statement_review) VALUES ($1,$2,'gpt-6.1-sol','openai','accept','heuristic','fixture',true,'high',$3) RETURNING id`,
    [source.id,reviewer,JSON.stringify({binding_sha256:binding,meaning_md:'fixture'})]);
  const proofPlan={...plan,lean:{...plan.lean,statement_review_id:Number(sreview.id)}};
  // A receipt that passes, on every package below.
  const receipt=async(subject)=>{const w=await one(`INSERT INTO returns (problem_id,type,user_id,model,provider,report_md,transcript,status,effort) VALUES ($1,'check',$2,'gpt-6.1-sol','openai','check','t','recorded','high') RETURNING id`,[pid,reviewer]);
    return one(`INSERT INTO verification_runs (subject_return_id,result_return_id,fingerprint,outcome,observed,elapsed_seconds,details) VALUES ($1,$2,$3,'pass','{}',1,$4) RETURNING id`,[subject.id,w.id,subject.verification_fingerprint,JSON.stringify({exit_code:0,lean:leanEvidence(plan.lean,binding)})]);};
  const rejected=await ret('rejected',proofPlan); await receipt(rejected);
  const older=await ret('rejected',proofPlan); await receipt(older);
  const accepted=await ret('accepted',proofPlan); const run=await receipt(accepted);
  await q(`INSERT INTO reviews (return_id,user_id,model,provider,verdict,rung,notes_md,trusted,effort,verification_receipt_id,verification_sufficiency_md) VALUES ($1,$2,'gpt-6.1-sol','openai','accept','verified','fixture',true,'high',$3,'The receipt suffices.')`,[accepted.id,reviewer,run.id]);
  const folded=await ret('superseded',proofPlan); await q(`UPDATE returns SET superseded_by=$2 WHERE id=$1`,[folded.id,accepted.id]); await receipt(folded);
  const later=await ret('rejected',proofPlan); await receipt(later);   // rejected after the accepted one: nothing later replaces it
  const list=await paperLeanVerification(pid,'example',plan.lean.manuscript_sha256);
  const by=Object.fromEntries(list.map(r=>[r.return_id,r]));
  assert.equal(by[accepted.id].status,'checked'); assert.equal(by[accepted.id].checked_claims.length,1);
  for (const r of [rejected,older]) { assert.equal(by[r.id].status,'rejected'); assert.equal(by[r.id].superseded_by,Number(accepted.id)); assert.deepEqual(by[r.id].checked_claims,[]); assert.notEqual(by[r.id].label,'Lean evidence awaits trusted review'); }
  assert.equal(by[folded.id].status,'superseded'); assert.equal(by[folded.id].superseded_by,Number(accepted.id));
  assert.equal(by[later.id].status,'rejected'); assert.equal(by[later.id].superseded_by,undefined);
  assert.equal(by[source.id].status,'no_proof','the accepted statement proposal keeps its own status');
  // Historical same-family acceptance remains historical acceptance, but cannot satisfy the current independent Lean gate.
  await q(`UPDATE returns SET model='claude-fable-5-1',provider='anthropic' WHERE id IN (SELECT result_return_id FROM verification_runs WHERE subject_return_id=$1)`,[accepted.id]);
  const legacy=(await paperLeanVerification(pid,'example',plan.lean.manuscript_sha256)).find(r=>r.return_id===Number(accepted.id));
  assert.equal(legacy.return_status,'accepted');assert.equal(legacy.status,'no_proof');assert.deepEqual(legacy.checked_claims,[]);
  assert.equal((await one('SELECT status FROM returns WHERE id=$1',[accepted.id])).status,'accepted');

});
