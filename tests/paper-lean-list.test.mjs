// The paper page's Lean list shows each package's decided state (Oct 6 2026: rejected kk-lower-bound packages read "awaiting review").
// Synthetic records only: no Lean runs and no mathematical result is asserted.
import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import express from 'express';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database.');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
const ownRoot=mkdtempSync(join(tmpdir(),'lean-display-test-'));
process.env.PROJECTS_DIR=join(ownRoot,'projects');
process.env.FILES_DIR=join(ownRoot,'files');
const {q,one,pool,migrate}=await import('../src/db/index.ts');
const {modelTier}=await import('../src/lib/auth.ts');
const {TERMS_VERSION}=await import('../src/lib/terms.ts');
const {leanFixture,leanEvidence}=await import('./fixtures/lean.mjs');
const {leanExecutionFixture}=await import('./fixtures/lean-execution.mjs');
const {leanStatementBinding}=await import('../src/lib/lean-verification.ts');
const {paperLeanVerification}=await import('../src/lib/verification.ts');
const {mainTheoremEvidence}=await import('../src/lib/lean-display.ts');
const files=await import('../src/lib/files.ts');
const {papers,listPapers}=await import('../src/routes/papers.ts');
const {board}=await import('../src/routes/board.ts');
const {responseCache}=await import('../src/lib/cache.ts');

let pid, author, reviewer, slug,server,base;
before(async()=>{
  await migrate();
  for (const m of ['claude-opus-5-5','gpt-6.1-sol']) await modelTier(m);
  const user=async(n)=>Number((await one(`INSERT INTO users (github_id,handle,terms_version,terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`,[600000000+Math.floor(Math.random()*1e8),'paper-lean-'+n+'-'+randomUUID().slice(0,8),TERMS_VERSION])).id);
  author=await user('author'); reviewer=await user('reviewer');
  pid=Number((await one(`INSERT INTO problems (slug,name,repo_url,status_md) VALUES ($1,'Paper Lean list','https://example.org/p','open') RETURNING id`,['paper-lean-'+randomUUID().slice(0,8)])).id);
  await q(`INSERT INTO project_roles (problem_id,user_id,role,note) VALUES ($1,$2,'trusted','test')`,[pid,reviewer]);
  slug=(await one(`SELECT slug FROM problems WHERE id=$1`,[pid])).slug;
  const app=express();app.use(responseCache([/^\/projects\/[a-z0-9-]+\/?$/]));app.use('/projects/:slug',papers,board);
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  base=`http://127.0.0.1:${server.address().port}/projects/${slug}`;
});
after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  await q(`DELETE FROM papers WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM verification_runs WHERE subject_return_id IN (SELECT id FROM returns WHERE problem_id=$1) OR result_return_id IN (SELECT id FROM returns WHERE problem_id=$1)`,[pid]);
  await q(`DELETE FROM reviews WHERE return_id IN (SELECT id FROM returns WHERE problem_id=$1)`,[pid]);
  await q(`UPDATE returns SET superseded_by=NULL WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM file_refs WHERE ref_type='return' AND ref_id IN (SELECT id FROM returns WHERE problem_id=$1)`,[pid]);
  await q(`UPDATE returns SET job_id=NULL WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM jobs WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM returns WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM sessions WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM files WHERE user_id=ANY($1::bigint[])`,[[author,reviewer]]);
  await q(`DELETE FROM project_roles WHERE problem_id=$1`,[pid]);
  await q(`DELETE FROM problems WHERE id=$1`,[pid]);
  await q(`DELETE FROM users WHERE id = ANY($1::bigint[])`,[[author,reviewer]]);
  await pool.end();
  rmSync(ownRoot,{recursive:true,force:true});
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
  const receipt=async(subject)=>(await leanExecutionFixture(subject,reviewer,'gpt-6.1-sol')).submit();
  const rejected=await ret('rejected',proofPlan); await receipt(rejected);
  const older=await ret('rejected',proofPlan); await receipt(older);
  const accepted=await ret('accepted',proofPlan); const run=await receipt(accepted);
  await q(`INSERT INTO reviews (return_id,user_id,model,provider,verdict,rung,notes_md,trusted,effort,verification_receipt_id,verification_sufficiency_md) VALUES ($1,$2,'gpt-6.1-sol','openai','accept','verified','fixture',true,'high',$3,'Synthetic review: the mapped identity follows from its hypothesis; assumptions, proof reasoning, exact claim match, provenance, isolation and controls were assessed.')`,[accepted.id,reviewer,run.id]);
  const folded=await ret('superseded',proofPlan); await q(`UPDATE returns SET superseded_by=$2 WHERE id=$1`,[folded.id,accepted.id]); await receipt(folded);
  const later=await ret('rejected',proofPlan); await receipt(later);   // rejected after the accepted one: nothing later replaces it
  const list=await paperLeanVerification(pid,'example',plan.lean.manuscript_sha256);
  const by=Object.fromEntries(list.map(r=>[r.return_id,r]));
  assert.equal(by[accepted.id].status,'checked'); assert.equal(by[accepted.id].checked_claims.length,1);
  const designation={paper_slug:'example',manuscript_sha256:plan.lean.manuscript_sha256,statement_binding:binding,required_claim_ids:['claim1'],unproved_claims:[]};
  assert.equal(mainTheoremEvidence(list,designation).return_id,Number(accepted.id));
  assert.equal(by[accepted.id].current_evidence.receipt_id,Number(run.id));
  assert.equal(by[accepted.id].current_evidence.statement_review_id,Number(sreview.id));
  assert.equal(by[accepted.id].current_evidence.semantic_review_ids.length,1);
  const {artifacts}=leanFixture();
  await files.store(author,'claude-opus-5-5','paper.md','md',artifacts.find(([name])=>name==='paper.md')[1]);
  await q(`INSERT INTO papers(problem_id,slug,title,kind,current_file_sha) VALUES($1,'example','Example main theorem','draft',$2)`,[pid,plan.lean.manuscript_sha256]);
  const projectRoot=join(process.env.PROJECTS_DIR,slug);mkdirSync(projectRoot,{recursive:true});
  const configure=entries=>writeFileSync(join(projectRoot,'project.json'),JSON.stringify({slug,name:'Synthetic project',lean_main_theorems:entries}));
  const currentCallout=async()=>{
    const response=await fetch(base+'/papers/example?lean_request=current-fixture-read');
    assert.equal(response.headers.get('cache-control'),'no-store');
    const body=await response.json();assert.equal(body.lean_milestone_request,'current-fixture-read');return body.lean_milestone_html;
  };
  configure([designation]);assert.match(await currentCallout(),/Main theorem proven with Lean/);
  await q(`INSERT INTO papers(problem_id,slug,title,kind,status,grade,updated_at) VALUES($1,'new-draft','Newest draft','draft','reviewed','Proven with Lean',now()+interval '1 day')`,[pid]);
  const ordered=async()=>listPapers(pid,slug);
  let ranked=await ordered();assert.equal(ranked[0].slug,'example','current main proof outranks a fresher registry claim');assert.equal(ranked[0].research_status,'proven_with_lean');assert.equal(ranked[0].status_label,'Main theorem proven with Lean');assert.notEqual(ranked.find(p=>p.slug==='new-draft').research_status,'proven_with_lean');
  const listResponse=await fetch(base+'/papers');assert.equal(listResponse.headers.get('cache-control'),'no-store');assert.equal((await listResponse.json()).papers[0].slug,'example');

  const rootPage=await fetch(base,{headers:{accept:'text/html'}});
  const rootHtml=await rootPage.text();assert.doesNotMatch(rootHtml,/lean-milestones|__LEAN_CANDIDATES__/);
  assert.doesNotMatch(rootHtml,/Main theorem proven with Lean/,'cached HTML carries no positive verdict');
  const cached=await fetch(base,{headers:{accept:'text/html'}});assert.equal(cached.headers.get('x-cache'),'hit');
  configure([]);assert.equal(await currentCallout(),'','removed config invalidates an already cached candidate list');assert.notEqual((await ordered()).find(p=>p.slug==='example').research_status,'proven_with_lean','removed designation downgrades list rank');
  configure([{...designation,statement_binding:'0'.repeat(64)}]);assert.equal(await currentCallout(),'','mismatched designation has no main callout');
  configure([designation]);

  const judgmentId=by[accepted.id].current_evidence.semantic_review_ids[0];
  await q(`UPDATE reviews SET needs_reassessment=true WHERE id=$1`,[judgmentId]);
  assert.equal(mainTheoremEvidence(await paperLeanVerification(pid,'example',plan.lean.manuscript_sha256),designation),null,'reopened correctness judgment invalidates the milestone');
  assert.equal(await currentCallout(),'');
  await q(`UPDATE reviews SET needs_reassessment=false WHERE id=$1`,[judgmentId]);
  await q(`UPDATE reviews SET needs_reassessment=true WHERE id=$1`,[sreview.id]);
  assert.equal(mainTheoremEvidence(await paperLeanVerification(pid,'example',plan.lean.manuscript_sha256),designation),null,'reopened statement review invalidates the milestone');
  assert.equal(await currentCallout(),'');
  await q(`UPDATE reviews SET needs_reassessment=false WHERE id=$1`,[sreview.id]);
  const stale=await paperLeanVerification(pid,'example','0'.repeat(64));
  assert.equal(mainTheoremEvidence(stale,designation),null,'a historical checked-claim array cannot create a milestone');
  await q(`UPDATE returns SET status='pending' WHERE id=$1`,[accepted.id]);
  assert.equal(mainTheoremEvidence(await paperLeanVerification(pid,'example',plan.lean.manuscript_sha256),designation),null,'a reopened decision stops celebration');
  assert.equal(await currentCallout(),'');
  await q(`UPDATE returns SET status='accepted',provisional=true WHERE id=$1`,[accepted.id]);
  assert.equal(mainTheoremEvidence(await paperLeanVerification(pid,'example',plan.lean.manuscript_sha256),designation),null,'provisional acceptance is insufficient');
  await q(`UPDATE returns SET provisional=false WHERE id=$1`,[accepted.id]);
  for (const r of [rejected,older]) { assert.equal(by[r.id].status,'rejected'); assert.equal(by[r.id].superseded_by,Number(accepted.id)); assert.deepEqual(by[r.id].checked_claims,[]); assert.notEqual(by[r.id].label,'Lean evidence awaits trusted review'); }
  assert.equal(by[folded.id].status,'superseded'); assert.equal(by[folded.id].superseded_by,Number(accepted.id));
  assert.equal(by[later.id].status,'rejected'); assert.equal(by[later.id].superseded_by,undefined);
  assert.equal(by[source.id].status,'no_proof','the accepted statement proposal keeps its own status');
  // Changing the executor model after attestation invalidates its binding, while the historical acceptance remains.
  await q(`UPDATE returns SET model='claude-fable-5-1',provider='anthropic' WHERE id IN (SELECT result_return_id FROM verification_runs WHERE subject_return_id=$1)`,[accepted.id]);
  const legacy=(await paperLeanVerification(pid,'example',plan.lean.manuscript_sha256)).find(r=>r.return_id===Number(accepted.id));
  assert.equal(legacy.return_status,'accepted');assert.equal(legacy.status,'no_proof');assert.deepEqual(legacy.checked_claims,[]);
  assert.equal(legacy.current_evidence,undefined);assert.equal(mainTheoremEvidence([legacy],designation),null,'revoked execution invalidates the milestone');
  assert.equal(await currentCallout(),'');
  ranked=await ordered();assert.notEqual(ranked.find(p=>p.slug==='example').research_status,'proven_with_lean','revoked execution removes highest list status');assert.notEqual(ranked.find(p=>p.slug==='example').status_label,'Main theorem proven with Lean');
  assert.equal(ranked[0].slug,'new-draft','recency breaks equal downgraded status ties');
  assert.equal((await one('SELECT status FROM returns WHERE id=$1',[accepted.id])).status,'accepted');

});
