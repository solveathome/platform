// Strict data/schema tests; no Lean execution or mathematical result is claimed.
import assert from 'node:assert/strict';import {test}from'node:test';
import {leanKernelFixture,kernelEvidence,artifactFiles}from'./fixtures/lean-kernel.mjs';
import {leanV2Fixture}from'./fixtures/lean-v2.mjs';import {leanFixture,digest}from'./fixtures/lean.mjs';
import {parseVerificationPlan,fingerprint,parseLeanExecutionReview}from'../src/lib/verification.ts';
import {parseLeanEvidence,assessLeanEvidence,leanEvidenceFiles,leanScientificBinding,leanStatementBinding,leanExecutionBinding,validateLeanV2Artifacts,summarizeLean,leanGuidance}from'../src/lib/lean-verification.ts';
const clone=x=>structuredClone(x),valid=()=>parseVerificationPlan(leanKernelFixture().plan);
test('kernel keeps exactly reviewed science and meaning while transport/execution fingerprint is distinct',()=>{
 const p=valid(),old=parseVerificationPlan(leanV2Fixture().plan);assert.equal(leanScientificBinding(p.lean),leanScientificBinding(old.lean));assert.equal(leanStatementBinding(p.lean),leanStatementBinding(old.lean));assert.notEqual(fingerprint(p),fingerprint(old));assert.notEqual(leanExecutionBinding(p.lean),leanExecutionBinding(old.lean));assert.equal(p.lean.execution_review_id,undefined);
 const changed=clone(p);changed.environment='Synthetic later host observation';assert.equal(leanScientificBinding(p.lean),leanScientificBinding(changed.lean));assert.notEqual(fingerprint(p),fingerprint(changed));
});
test('kernel aliases are strict and never accept comparator approval fields or foreign host fields',()=>{
 for(const change of [p=>p.comparator_revision='a'.repeat(40),p=>p.external_checker={},p=>p.execution_review_id=1,p=>p.proof_representations=[],p=>p.host='/Users/private',p=>p.claims[0].assumptions.push('hidden hypothesis'),p=>p.kernel_objects[0].claim_ids=['foreign'],p=>p.kernel_objects[0].artifact.sha256=digest('substitute')]){const {plan}=leanKernelFixture();change(plan.lean);assert.throws(()=>parseVerificationPlan(plan));}
 assert.throws(()=>parseLeanExecutionReview(valid().lean,{binding_sha256:leanExecutionBinding(valid().lean),correctness_md:'x'.repeat(100)}),/v2/);
});
test('direct object bytes and external descriptor inventory bind exact immutable custody without fake raw uploads',()=>{
 for(const descriptor of [false,true]){const f=leanKernelFixture({descriptor}),p=parseVerificationPlan(f.plan),files=artifactFiles(f.artifacts);validateLeanV2Artifacts(p.lean,p.manifest,files);if(descriptor)assert(!files.has(p.lean.kernel_objects[0].artifact.sha256));
 const s=p.lean.kernel_custody.sources.sha256;files.get(s).bytes++;assert.throws(()=>validateLeanV2Artifacts(p.lean,p.manifest,files),/bytes/);}
 const f=leanKernelFixture({descriptor:true}),p=parseVerificationPlan(f.plan),files=artifactFiles(f.artifacts),h=p.lean.kernel_custody.objects.sha256;files.get(h).content=files.get(h).content.replace('kernel-object','proof');assert.throws(()=>validateLeanV2Artifacts(p.lean,p.manifest,files),/descriptor/);
});
test('kernel evidence has its own exact fields and references only actual audit/axiom/custody observations',()=>{
 const p=valid().lean,e=parseLeanEvidence(kernelEvidence(p));assert.deepEqual(assessLeanEvidence(p,e),{checked:['claim'],issues:[]});assert.deepEqual(leanEvidenceFiles(e),[e.audit_sha256,e.axioms_sha256,e.custody_sha256]);
 for(const change of [e=>e.proof_files=[],e=>e.export_validated=true,e=>e.external_checked=true,e=>e.comparator_revision='a'.repeat(40),e=>e.claims[0].proof_sha256=digest('export')]){const e=kernelEvidence(p);change(e);assert.throws(()=>parseLeanEvidence(e));}
 for(const change of [e=>e.execution_identity=digest('foreign'),e=>e.scientific_identity=digest('foreign'),e=>e.claims[0].object_sha256=digest('foreign'),e=>e.claims[0].axioms.push('sorryAx'),e=>e.kernel_checked=false,e=>e.source_objects_verified=false,e=>e.claims[0].statement_matches=false]){const e=kernelEvidence(p);change(e);assert.equal(assessLeanEvidence(p,parseLeanEvidence(e)).checked.length,0);}
});
test('kernel status requires current authenticated execution and independent finished judgment; summary labels method',()=>{
 const p=valid().lean,e=kernelEvidence(p),run={id:1,outcome:'pass',details:{lean:e,exit_code:0},trusted_execution:true,receipt_status:'recorded'};
 const status=ids=>summarizeLean(p,[run],ids,true,p.manuscript_sha256,{status:'accepted',provisional:false}).status;
 assert.equal(status([]),'awaiting_review');assert.equal(status([1]),'checked');assert.equal(summarizeLean(p,[run],[1],true,p.manuscript_sha256,{status:'accepted',provisional:false}).policy,'lean-kernel-v1');
 assert.notEqual(summarizeLean(p,[{...run,trusted_execution:false}],[1],true,p.manuscript_sha256,{status:'accepted',provisional:false}).status,'checked');
 assert.match(leanGuidance(p),/does not require a pre-execution/);assert.match(leanGuidance(parseVerificationPlan(leanV2Fixture().plan).lean),/external checker/);
});
test('legacy profile and comparator-v2 cannot be relabelled by removing stronger checker requirements',()=>{
 for(const fixture of [leanFixture(),leanV2Fixture()]){const p=parseVerificationPlan(fixture.plan);assert.match(p.lean.policy,/lean-comparator/);const f=clone(fixture.plan);delete f.lean.external_checker;assert.throws(()=>parseVerificationPlan(f));}
});

test('kernel evidence and object inventories reject sparse or accessor arrays',()=>{
 const e=kernelEvidence(valid().lean);e.claims.length=2;assert.throws(()=>parseLeanEvidence(e),/dense/);
 const f=leanKernelFixture();Object.defineProperty(f.plan.lean.kernel_objects,'0',{get(){throw new Error('must not execute');}});assert.throws(()=>parseVerificationPlan(f.plan),/dense/);
});
