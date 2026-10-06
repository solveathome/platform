import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseVerificationPlan,fingerprint} from '../src/lib/verification.ts';
import {LEAN_POLICY,parseLeanEvidence,assessLeanEvidence,leanStatementBinding,summarizeLean} from '../src/lib/lean-verification.ts';
import {leanFixture,leanEvidence,digest} from './fixtures/lean.mjs';
const fixture=()=>{const p=parseVerificationPlan(leanFixture().plan);return {p,e:leanEvidence(p.lean,leanStatementBinding(p.lean))}};
const run=(e,extra={})=>({id:1,independent:true,receipt_status:'recorded',outcome:'pass',details:{exit_code:0,lean:e},...extra});

test('Lean packages pin manuscript, claims, dependencies and versioned policy without changing old packages',()=>{
  const {p}=fixture();assert.equal(p.lean.policy,LEAN_POLICY);
  const old=leanFixture().plan;delete old.lean;const legacy=parseVerificationPlan(old);
  assert.equal('lean' in legacy,false);
  assert.equal(fingerprint(legacy),fingerprint(parseVerificationPlan({...old,ignored:'not semantic'})));
  for(const mutate of [p=>p.lean.toolchain='nightly',p=>p.lean.policy='relaxed-v1',p=>p.lean.manuscript_sha256=digest('missing'),p=>p.lean.dependencies=[{name:'mathlib',revision:'main',sha256:p.lean.lakefile_sha256}],p=>p.lean.claims[0].declaration='unqualified',p=>p.targets.push('paper.md')]) {
    const raw=leanFixture().plan;mutate(raw);assert.throws(()=>parseVerificationPlan(raw));
  }
  for(const mutate of [p=>p.lean.manuscript_sha256=p.lean.statement_bundle_sha256,p=>p.lean.claims[0].locator='Claim 2',p=>p.lean.claims[0].assumptions=['Unproved H'],p=>p.lean.comparator_revision='c'.repeat(40),p=>p.lean.external_checker.revision='d'.repeat(40)]) {
    const next=structuredClone(p);mutate(next);assert.notEqual(fingerprint(next),fingerprint(p));assert.notEqual(leanStatementBinding(next.lean),leanStatementBinding(p.lean));
  }
  const reference=structuredClone(p);reference.lean.statement_review_id=42;
  assert.notEqual(fingerprint(reference),fingerprint(p));assert.equal(leanStatementBinding(reference.lean),leanStatementBinding(p.lean));
});

test('strict transitive axiom evidence rejects hidden sorry, custom and native axioms',()=>{
  const {p,e}=fixture();assert.deepEqual(assessLeanEvidence(p.lean,parseLeanEvidence(e)).checked,['claim1']);
  for(const axiom of ['sorryAx','Custom.assumption','Lean.trustCompiler','Example._native.1','Lean.ofReduceBool']) {
    const bad=structuredClone(e);bad.claims[0].axioms.push(axiom);
    assert.deepEqual(assessLeanEvidence(p.lean,bad).checked,[],axiom);
  }
  const empty=structuredClone(e);empty.claims[0].axioms=[];assert.deepEqual(assessLeanEvidence(p.lean,empty).checked,['claim1']);
});

test('wrong statements, omitted targets, untrusted environments and forged pass flags do not become checked',()=>{
  const {p,e}=fixture();
  for(const mutate of [e=>e.claims=[],e=>e.claims[0].declaration='Other.theorem',e=>e.claims[0].statement_matches=false,e=>e.claims[0].result='missing',e=>e.claims[0].proof_sha256=null,e=>e.export_validated=false,e=>e.outside_sandbox=false,e=>e.sandbox=false,e=>e.external_checked=false,e=>e.kernel_checked=false,e=>e.pinned_inputs=false,e=>e.toolchain='wrong',e=>e.policy='compile-and-grep',e=>e.statement_binding=digest('wrong')]) {
    const bad=structuredClone(e);mutate(bad);
    assert.notEqual(summarizeLean(p.lean,[run(bad)],[1],true,p.lean.manuscript_sha256).status,'checked');
  }
  assert.equal(summarizeLean(p.lean,[run(null)],[1],true,p.lean.manuscript_sha256).status,'no_proof');
  assert.notEqual(summarizeLean(p.lean,[run(e,{details:{exit_code:1,lean:e}})],[1],true,p.lean.manuscript_sha256).status,'checked');
});

test('status requires trusted statement and receipt judgment; conflicts, stale manuscripts and withdrawal stay visible',()=>{
  const {p,e}=fixture(), summary=(runs,ids=[1],reviewed=true,sha=p.lean.manuscript_sha256)=>summarizeLean(p.lean,runs,ids,reviewed,sha);
  assert.equal(summary([run(e)]).status,'checked');
  assert.equal(summary([run(e)],[]).status,'awaiting_review');
  assert.equal(summary([run(e)],[1],false).status,'awaiting_review');
  assert.equal(summary([run(e,{independent:false})]).status,'no_proof');
  assert.equal(summary([run(e,{receipt_status:'withdrawn'})]).status,'no_proof');
  assert.equal(summary([]).status,'no_proof');
  assert.equal(summary([run(null,{outcome:'unable'})]).status,'unable');
  assert.equal(summary([run(e,{outcome:'fail'})]).status,'failed');
  assert.equal(summary([run(e),run(e,{id:2,outcome:'fail'})]).status,'conflicting');
  assert.equal(summary([run(e)],[1],true,digest('revised paper')).status,'stale');
  p.lean.claims[0].assumptions=['Input S remains unproved'];e.statement_binding=leanStatementBinding(p.lean);assert.equal(summary([run(e)]).status,'conditional');
  p.lean.claims[0].coverage='partial';e.statement_binding=leanStatementBinding(p.lean);assert.equal(summary([run(e)]).status,'partial');
});

test('a rejected or superseded return shows its decision, never a pending or checked Lean status',()=>{
  const {p,e}=fixture(), summary=(decision)=>summarizeLean(p.lean,[run(e)],[1],true,p.lean.manuscript_sha256,decision);
  assert.equal(summary({status:'accepted'}).status,'checked');
  const rejected=summary({status:'rejected'});
  assert.equal(rejected.status,'rejected');assert.deepEqual(rejected.checked_claims,[]);assert.match(rejected.label,/rejected/);
  const superseded=summary({status:'superseded',superseded_by:'7'});
  assert.equal(superseded.status,'superseded');assert.equal(superseded.superseded_by,7);assert.deepEqual(superseded.checked_claims,[]);
  // A rejected package with no trusted judgment no longer reads as awaiting review.
  assert.equal(summarizeLean(p.lean,[run(e)],[],true,p.lean.manuscript_sha256,{status:'rejected'}).status,'rejected');
  assert.equal(summarizeLean(p.lean,[run(e)],[],true,p.lean.manuscript_sha256,{status:'pending'}).status,'awaiting_review');
});
