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
