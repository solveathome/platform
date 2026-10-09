import {test} from 'node:test';
import assert from 'node:assert/strict';
import {leanFixture,leanEvidence,digest} from './fixtures/lean.mjs';
import {leanStatementBinding,summarizeLean} from '../src/lib/lean-verification.ts';
import {mainTheoremDesignation,mainTheoremEvidence,mainTheoremCallout,leanEvidencePanel} from '../src/lib/lean-display.ts';

// Synthetic summary and UI fixtures; no Lean execution and no mathematical result.
function fixture({status='accepted',provisional=false,current=true,trusted=true,reviewed=true,coverage='full',assumptions=[],claim='main',outcome='pass'}={}) {
  const {plan}=leanFixture();const p=plan.lean;
  p.claims[0]={...p.claims[0],id:claim,coverage,assumptions};p.statement_review_id=10;
  const binding=leanStatementBinding(p),e=leanEvidence(p,binding);
  const runs=[{id:20,result_return_id:30,trusted_execution:trusted,receipt_status:'recorded',outcome,details:{exit_code:0,lean:e}}];
  const r={return_id:40,fingerprint:digest('package'),...summarizeLean(p,runs,[20],reviewed,current?p.manuscript_sha256:digest('new version'),{status,provisional})};
  if(r.judged_receipt_id)r.current_evidence={receipt_id:20,execution_return_id:30,statement_review_id:10,semantic_review_ids:[50]};
  const mapping={paper_slug:'example',manuscript_sha256:p.manuscript_sha256,statement_binding:binding,required_claim_ids:['main'],unproved_claims:[{id:'open-a',locator:'An unproved obligation in the manuscript'}]};
  return {r,p,mapping};
}

test('only a canonical exact designation plus accepted current reviewed execution shows the main badge',()=>{
  const {r,p,mapping}=fixture();const d=mainTheoremDesignation([mapping],'example',p.manuscript_sha256);
  assert.equal(mainTheoremEvidence([r],d),r);
  const panel=leanEvidencePanel([r],'example-project',d);
  assert.match(panel,/Main theorem verified in Lean/);
  for(const path of ['return/40','return/30','review/10','review/50'])assert.match(panel,new RegExp(path));
  assert.match(panel,/currently checked/);assert.match(panel,/Other claims remain unproved/);assert.match(panel,/open-a/);
  assert.match(panel,/Package fingerprint/);assert.match(panel,/does not authenticate physical computation/);
  const callout=mainTheoremCallout(r,d,'example-project','example','Example');
  assert.match(callout,/papers\/example#lean-evidence/);assert.match(callout,/not a proof of the project/);
});

test('checked helpers alone never establish the designated main theorem',()=>{
  const {r,mapping}=fixture({claim:'helper'});assert.equal(r.status,'checked');
  assert.equal(mainTheoremEvidence([r],mapping),null);
  assert.equal(mainTheoremCallout(r,mapping,'project','example','Example'),'');
  assert.doesNotMatch(leanEvidencePanel([r],'project',mapping),/Main theorem verified in Lean/);
});

test('partial, conditional, pending, provisional, revoked, stale and unreviewed evidence cannot celebrate',()=>{
  for(const options of [{coverage:'partial'},{assumptions:['Unproved input']},{status:'pending'},{provisional:true},{trusted:false},{current:false},{reviewed:false},{outcome:'fail'},{status:'rejected'},{status:'superseded'}]){
    const {r,mapping}=fixture(options);assert.equal(mainTheoremEvidence([r],mapping),null,JSON.stringify(options));
    assert.equal(mainTheoremCallout(r,mapping,'project','example','Example'),'');
    assert.doesNotMatch(leanEvidencePanel([r],'project',mapping),/Main theorem verified in Lean/);
  }
});

test('missing, malformed, duplicate or mismatched designations fail closed, including claimed approval flags',()=>{
  const {r,p,mapping}=fixture();
  for(const raw of [undefined,[],{},[mapping,mapping],[{...mapping,required_claim_ids:[]}],[{...mapping,required_claim_ids:['main','main']}],[{...mapping,statement_binding:'bad'}],[{...mapping,approved:true}],[{...mapping,approved_by:123}],[{...mapping,unproved_claims:[{id:'main',locator:'contradictory'}]}],[{...mapping,unproved_claims:[{id:'open',locator:''}]}]]){
    const d=mainTheoremDesignation(raw,'example',p.manuscript_sha256);assert.equal(d,null);assert.equal(mainTheoremEvidence([r],d),null);
  }
  assert.equal(mainTheoremDesignation([mapping],'another-paper',p.manuscript_sha256),null);
  assert.equal(mainTheoremDesignation([mapping],'example',digest('another manuscript')),null);
  assert.equal(mainTheoremEvidence([r],{...mapping,statement_binding:digest('another binding')}),null);
});

test('incomplete provenance and self-asserted receipt flags never replace server-selected evidence',()=>{
  const {r,mapping}=fixture();
  for(const changes of [{current_evidence:undefined},{judged_receipt_id:undefined},{current_evidence:{...r.current_evidence,semantic_review_ids:[]}},{current_evidence:{...r.current_evidence,receipt_id:99}},{current_evidence:{...r.current_evidence,statement_review_id:0}}])assert.equal(mainTheoremEvidence([{...r,...changes}],mapping),null);
});

test('stale checked-claim arrays are visibly unverified, and metadata is escaped',()=>{
  const {r,mapping}=fixture();const stale={...r,status:'stale',current_evidence:undefined};
  assert.deepEqual(stale.checked_claims,['main']);
  const panel=leanEvidencePanel([stale],'project',{...mapping,unproved_claims:[{id:'<script>',locator:'<img onerror="bad">'}]});
  assert.match(panel,/not currently verified/);assert.doesNotMatch(panel,/; currently checked/);
  assert.match(panel,/&lt;script&gt;/);assert.doesNotMatch(panel,/<script>|<img/);
});

test('kernel profile names its narrower method on scoped evidence and milestone without claiming Nanoda checking',()=>{
  // Renderer-only synthetic summary: this does not authenticate a kernel receipt.
  const {r,mapping}=fixture();r.policy='lean-kernel-v1';
  const panel=leanEvidencePanel([r],'project',mapping);
  assert.match(panel,/<b>Lean kernel verification<\/b>/);
  assert.match(panel,/Independent export comparison and Nanoda checking are not claimed/);
  assert.doesNotMatch(panel,/claims checked against an independently regenerated export/);
  assert.match(mainTheoremCallout(r,mapping,'project','example','Example'),/Lean kernel verification/);
  assert.match(panel,/open-a/);assert.match(panel,/not verification of the main theorem or the entire paper/);
});

test('comparator profiles retain their independent export and external kernel checking scope',()=>{
  for(const policy of ['lean-comparator-v1','lean-comparator-v2']){
    const {r,mapping}=fixture();r.policy=policy;
    const panel=leanEvidencePanel([r],'project',mapping);
    assert.match(panel,/<b>Independent export and external kernel checking<\/b>/);
    assert.match(panel,/independently regenerated export with the Lean kernel and a pinned external checker/);
    assert.doesNotMatch(panel,/not claimed by this profile|<b>Lean kernel verification<\/b>/);
    assert.equal(r.label,'All mapped Lean claims checked');
  }
});

test('kernel label cannot upgrade pending, helper-only, revoked or stale evidence; unknown policy claims no checking method',()=>{
  for(const options of [{status:'pending'},{claim:'helper'},{trusted:false},{current:false},{reviewed:false},{coverage:'partial'}]){
    const {r,mapping}=fixture(options);r.policy='lean-kernel-v1';
    assert.equal(mainTheoremEvidence([r],mapping),null);
    assert.doesNotMatch(leanEvidencePanel([r],'project',mapping),/Main theorem verified in Lean/);
  }
  const {r,mapping}=fixture();delete r.policy;
  const panel=leanEvidencePanel([r],'project',mapping);
  assert.match(panel,/Lean verification profile not specified/);
  assert.doesNotMatch(panel,/claims checked against an independently regenerated export|<b>Lean kernel verification<\/b>/);
});

test('three finite mapped claims do not verify the original seven open obligations',()=>{
  const {r,mapping}=fixture();r.policy='lean-kernel-v1';
  const ids=['main_eq1','integer_maximum','integer_main_eq1'];
  r.claims=ids.map(id=>({...r.claims[0],id,declaration:`Example.${id}`}));r.checked_claims=ids;r.total_claims=3;
  mapping.required_claim_ids=ids;
  mapping.unproved_claims=Array.from({length:7},(_,i)=>({id:`O${i+1}`,locator:`Original manuscript obligation ${i+1}`}));
  const panel=leanEvidencePanel([r],'project',mapping);
  for(const id of ids)assert.match(panel,new RegExp(`${id}.*currently checked`));
  for(let i=1;i<=7;i++)assert.match(panel,new RegExp(`O${i}: Original manuscript obligation`));
  assert.match(panel,/Other claims remain unproved/);
  assert.match(mainTheoremCallout(r,mapping,'project','example','Finite claims'),/not a proof of the project/);
});
