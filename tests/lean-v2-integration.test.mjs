// Synthetic contract/intake data only. No native inference, compiler, kernel or trusted execution.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {leanV2Fixture} from './fixtures/lean-v2.mjs';
import {digest,leanEvidence} from './fixtures/lean.mjs';
import {parseVerificationPlan,fingerprint,parseLeanExecutionReview} from '../src/lib/verification.ts';
import {leanStatementBinding,leanScientificBinding,leanExecutionBinding,validateLeanV2Artifacts,validateLeanProofFiles,leanEvidenceFiles,parseLeanEvidence,assessLeanEvidence} from '../src/lib/lean-verification.ts';
const clone=x=>structuredClone(x);
const stored=artifacts=>new Map(artifacts.map(([,content])=>[digest(content),{bytes:Buffer.byteLength(content),content}]));
function prepared(){const f=leanV2Fixture();return {...f,p:parseVerificationPlan(f.plan)};}
function descriptorFixture(){
  const {plan,artifacts}=leanV2Fixture();
  const science=plan.lean.scientific_identity, archive=science.semantic_dependencies[0].source, proof=science.proof_artifacts[0].artifact;
  const encoded={path:'proof.encoded.txt',sha256:digest('Synthetic encoded proof'),bytes:Buffer.byteLength('Synthetic encoded proof')};
  const recipe=plan.lean.execution_identity.invocation;
  const descriptor={schema:'solveathome-lean-artifact-descriptor-v2',artifacts:[
    {artifact:clone(archive),category:'semantic-source',representation:null},
    {artifact:clone(proof),category:'proof',representation:{inputs:[clone(encoded)],recipe:clone(recipe)}}
  ]};
  const content=JSON.stringify(descriptor), path='source-descriptor.json', sha=digest(content);
  const absent=new Set([archive.path,proof.path]);
  plan.manifest=plan.manifest.filter(f=>!absent.has(f.path));
  plan.manifest.push({path,sha256:sha,role:'dependency'},{path:encoded.path,sha256:encoded.sha256,role:'certificate'});
  plan.lean.artifact_roles=plan.lean.artifact_roles.filter(f=>!absent.has(f.path));
  plan.lean.artifact_roles.push({path,kind:'provenance'},{path:encoded.path,kind:'scientific'});
  plan.lean.artifact_bindings.forEach(b=>{if(absent.has(b.artifact.path))b.representation={kind:'descriptor',path};});
  plan.lean.dependencies[0].sha256=sha;
  plan.lean.proof_representations=[{artifact:clone(proof),descriptor:{path,sha256:sha,bytes:Buffer.byteLength(content)},inputs:[clone(encoded)],recipe:clone(recipe)}];
  return {plan,artifacts:[...artifacts.filter(a=>!absent.has(a[0])),[path,content,'dependency'],[encoded.path,'Synthetic encoded proof','certificate']],descriptor,path};
}

test('v2 direct intake binds actual byte counts and every classified manifest artifact',()=>{
  const {p,artifacts}=prepared();validateLeanV2Artifacts(p.lean,p.manifest,stored(artifacts));
  const wrong=stored(artifacts);wrong.get(p.lean.scientific_identity.manuscript.sha256).bytes++;
  assert.throws(()=>validateLeanV2Artifacts(p.lean,p.manifest,wrong),/byte count/);
  for(const mutate of [p=>p.lean.artifact_roles.pop(),p=>p.lean.artifact_bindings.pop(),p=>p.lean.scientific_identity.host_ip='192.0.2.1',
    p=>p.lean.execution_identity.namespace_inode=123,p=>p.lean.receipt_id=1,p=>p.lean.claims[0].locator='Other claim',
    p=>p.lean.claims[0].ip='192.0.2.1',p=>p.lean.dependencies[0].machine='fixture',p=>p.lean.external_checker.host='fixture',
    p=>p.lean.dependencies[0].revision='c'.repeat(40),p=>p.lean.execution_identity.package_artifacts.pop()]) {
    const next=leanV2Fixture().plan;mutate(next);assert.throws(()=>parseVerificationPlan(next));
  }
});

test('v2 proof changes preserve conservative meaning while scientific and exact transport identities change',()=>{
  const {p}=prepared(),next=clone(p),artifact=next.lean.scientific_identity.proof_artifacts[0].artifact;
  artifact.sha256=digest('Synthetic repaired proof');
  next.manifest.find(f=>f.path===artifact.path).sha256=artifact.sha256;
  next.lean.artifact_bindings.find(b=>b.artifact.path===artifact.path).artifact.sha256=artifact.sha256;
  next.lean.proof_representations[0].artifact.sha256=artifact.sha256;next.lean.proof_representations[0].inputs[0].sha256=artifact.sha256;
  const parsed=parseVerificationPlan(next);
  assert.equal(leanStatementBinding(parsed.lean),leanStatementBinding(p.lean));
  assert.notEqual(leanScientificBinding(parsed.lean),leanScientificBinding(p.lean));
  assert.equal(leanExecutionBinding(parsed.lean),leanExecutionBinding(p.lean));
  assert.notEqual(fingerprint(parsed),fingerprint(p));
});

test('v2 authored sources and semantic dependency pins remain in the reviewed meaning scope',()=>{
  const {p}=prepared();
  for(const mutate of [p=>p.scientific_identity.source_artifacts[0].sha256=digest('Synthetic changed definition'),
    p=>p.scientific_identity.semantic_dependencies[0].source.sha256=digest('Synthetic changed core'),
    p=>p.scientific_identity.claims[0].assumptions=['Unproved synthetic hypothesis']]) {
    const next=clone(p.lean);mutate(next);assert.notEqual(leanStatementBinding(next),leanStatementBinding(p.lean));
  }
});

test('v2 checker/package changes and observation-only metadata cannot alter science meaning',()=>{
  const {p}=prepared(),next=clone(p);
  next.environment='Synthetic host B: namespace 2, IP ::1';
  assert.equal(leanStatementBinding(next.lean),leanStatementBinding(p.lean));
  assert.equal(leanScientificBinding(next.lean),leanScientificBinding(p.lean));
  assert.notEqual(fingerprint(next),fingerprint(p),'legacy exact transport fingerprint is deliberately unchanged in meaning');
  const execution=clone(p.lean);execution.execution_identity.package_artifacts[0].sha256=digest('Synthetic changed helper');
  assert.notEqual(leanExecutionBinding(execution),leanExecutionBinding(p.lean));
  assert.equal(leanStatementBinding(execution),leanStatementBinding(p.lean));
});

test('v2 descriptor-backed archives and decoded proofs bind exact uploaded inert declarations and encoded inputs',()=>{
  const f=descriptorFixture(),p=parseVerificationPlan(f.plan);
  validateLeanV2Artifacts(p.lean,p.manifest,stored(f.artifacts));
  for(const mutate of [d=>d.artifacts[0].artifact.sha256=digest('Wrong archive'),d=>d.artifacts[1].representation=null,
    d=>d.artifacts[1].representation.inputs[0].bytes++,d=>d.artifacts[1].category='tool-binary',
    d=>d.machine='fixture',d=>d.artifacts[1].namespace=1,d=>d.artifacts[1].representation.host_path='fixture']) {
    const next=descriptorFixture();mutate(next.descriptor);const content=JSON.stringify(next.descriptor),sha=digest(content);
    next.plan.manifest.find(f=>f.path===next.path).sha256=sha;next.plan.lean.dependencies[0].sha256=sha;
    next.artifacts.find(a=>a[0]===next.path)[1]=content;next.plan.lean.proof_representations[0].descriptor={path:next.path,sha256:sha,bytes:Buffer.byteLength(content)};
    const plan=parseVerificationPlan(next.plan);
    assert.throws(()=>validateLeanV2Artifacts(plan.lean,plan.manifest,stored(next.artifacts)));
  }
});

test('v2 descriptor metadata changes do not reset scientific pins or meaning',()=>{
  const a=descriptorFixture(),b=descriptorFixture();b.descriptor.artifacts.reverse();
  const content=JSON.stringify(b.descriptor),sha=digest(content);
  b.plan.manifest.find(f=>f.path===b.path).sha256=sha;b.plan.lean.dependencies[0].sha256=sha;b.artifacts.find(a=>a[0]===b.path)[1]=content;b.plan.lean.proof_representations[0].descriptor={path:b.path,sha256:sha,bytes:Buffer.byteLength(content)};
  const pa=parseVerificationPlan(a.plan),pb=parseVerificationPlan(b.plan);
  validateLeanV2Artifacts(pb.lean,pb.manifest,stored(b.artifacts));
  assert.equal(leanStatementBinding(pa.lean),leanStatementBinding(pb.lean));
  assert.equal(leanScientificBinding(pa.lean),leanScientificBinding(pb.lean));
  assert.notEqual(fingerprint(pa),fingerprint(pb));
});

test('v2 pass evidence must match exact scientific and execution identities and actual mapped proof export',()=>{
  const {p}=prepared(),e=leanEvidence(p.lean,leanStatementBinding(p.lean));
  e.scientific_identity=leanScientificBinding(p.lean);e.execution_identity=leanExecutionBinding(p.lean);e.proof_files=clone(p.lean.proof_representations);
  e.claims[0].proof_sha256=p.lean.scientific_identity.proof_artifacts[0].artifact.sha256;
  assert.deepEqual(assessLeanEvidence(p.lean,parseLeanEvidence(e)).checked,['claim']);
  for(const mutate of [e=>e.scientific_identity=digest('Other science'),e=>e.execution_identity=digest('Other execution'),e=>e.claims[0].proof_sha256=digest('Other proof')]) {
    const next=clone(e);mutate(next);assert.deepEqual(assessLeanEvidence(p.lean,parseLeanEvidence(next)).checked,[]);
  }
  const missing=clone(e);delete missing.execution_identity;assert.throws(()=>parseLeanEvidence(missing));
  const host=clone(e);host.ip='192.0.2.1';assert.throws(()=>parseLeanEvidence(host),'machine observations belong on separate receipt details');
});

test('v2 normalized inventories reorder without changing scientific or execution identities',()=>{
  const {p}=prepared(),next=clone(p);
  next.lean.artifact_bindings.reverse();next.lean.artifact_roles.reverse();next.lean.scientific_identity.source_artifacts.reverse();
  next.lean.execution_identity.tools.reverse();next.lean.execution_identity.package_artifacts.reverse();
  const normalized=parseVerificationPlan(next);
  assert.equal(leanScientificBinding(normalized.lean),leanScientificBinding(p.lean));
  assert.equal(leanExecutionBinding(normalized.lean),leanExecutionBinding(p.lean));
  assert.equal(fingerprint(normalized),fingerprint(p));
});

test('v2 execution review preflight is separate, strict and cannot grant authority or refer to legacy meaning',()=>{
  const {p}=prepared(),raw={binding_sha256:leanExecutionBinding(p.lean),correctness_md:'Synthetic independent source review of exact validator, tool hashes, invocation, isolation and resource limits.'};
  assert.deepEqual(parseLeanExecutionReview(p.lean,raw),raw);
  for(const mutate of [r=>r.binding_sha256=leanStatementBinding(p.lean),r=>r.correctness_md='pass',r=>r.trusted=true,r=>r.approved_by=123]) {
    const next=clone(raw);mutate(next);assert.throws(()=>parseLeanExecutionReview(p.lean,next));
  }
  assert.equal(parseLeanExecutionReview(p.lean,undefined),undefined);
  assert.throws(()=>parseLeanExecutionReview({...p.lean,policy:'lean-comparator-v1'},raw));
});

test('v2 declares a released Lean trust boundary truthfully and rejects conflicting or invented source scopes',()=>{
  const f=leanV2Fixture();f.plan.lean.scientific_identity.semantic_dependencies[0].source_kind='released-toolchain';
  f.plan.lean.execution_identity.tools.find(t=>t.name==='lean').source_kind='released-toolchain';
  const p=parseVerificationPlan(f.plan);validateLeanV2Artifacts(p.lean,p.manifest,stored(f.artifacts));
  const inconsistent=clone(f.plan);inconsistent.lean.execution_identity.tools.find(t=>t.name==='lean').source_kind='source-archive';
  assert.throws(()=>parseVerificationPlan(inconsistent),/source\/scope/);
  const invented=clone(f.plan);invented.lean.scientific_identity.semantic_dependencies[0].source_kind='assumed-full-compiler-source';
  assert.throws(()=>parseVerificationPlan(invented),/scope/);
});

test('v2 authored tool files may truthfully lack a revision without loosening pinned Lean, comparator or archive revisions',()=>{
  const f=leanV2Fixture(),source=f.plan.lean.execution_identity.tools.find(t=>t.name==='comparator');
  f.plan.lean.execution_identity.tools.push({name:'authored_helper',revision:null,source_kind:'source-files',source_sha256:source.source_sha256,binary_sha256:source.binary_sha256});
  const p=parseVerificationPlan(f.plan);validateLeanV2Artifacts(p.lean,p.manifest,stored(f.artifacts));
  for(const kind of ['source-archive','released-toolchain']) {
    const next=clone(f.plan);next.lean.execution_identity.tools.find(t=>t.name==='authored_helper').source_kind=kind;
    assert.throws(()=>parseVerificationPlan(next),/revision/);
  }
  for(const name of ['lean','comparator','nanoda']) {
    const next=clone(f.plan),t=next.lean.execution_identity.tools.find(t=>t.name===name);t.source_kind='source-files';t.revision=null;
    assert.throws(()=>parseVerificationPlan(next),/source\/scope|aliases/);
  }
});

test('v2 large decoded proof receipts reference exact uploaded representation without requiring raw proof upload',()=>{
  const f=descriptorFixture(),rawProof=f.plan.lean.scientific_identity.proof_artifacts[0].artifact;
  rawProof.bytes=123033220;
  f.plan.lean.artifact_bindings.find(b=>b.artifact.path===rawProof.path).artifact.bytes=rawProof.bytes;
  f.plan.lean.proof_representations[0].artifact.bytes=rawProof.bytes;
  f.descriptor.artifacts.find(a=>a.category==='proof').artifact.bytes=rawProof.bytes;
  const content=JSON.stringify(f.descriptor),sha=digest(content);
  f.plan.manifest.find(a=>a.path===f.path).sha256=sha;f.plan.lean.dependencies[0].sha256=sha;
  f.artifacts.find(a=>a[0]===f.path)[1]=content;
  f.plan.lean.proof_representations[0].descriptor={path:f.path,sha256:sha,bytes:Buffer.byteLength(content)};
  const p=parseVerificationPlan(f.plan);validateLeanV2Artifacts(p.lean,p.manifest,stored(f.artifacts));
  const e=leanEvidence(p.lean,leanStatementBinding(p.lean));
  e.scientific_identity=leanScientificBinding(p.lean);e.execution_identity=leanExecutionBinding(p.lean);
  e.claims[0].proof_sha256=rawProof.sha256;e.proof_files=clone(p.lean.proof_representations);
  const parsed=parseLeanEvidence(e);validateLeanProofFiles(p.lean,parsed);
  assert.deepEqual(assessLeanEvidence(p.lean,parsed).checked,['claim']);
  const files=leanEvidenceFiles(parsed);
  assert.equal(files.includes(rawProof.sha256),false,'decoded bytes are not falsely claimed as physical uploads');
  for(const a of [...parsed.proof_files[0].inputs,parsed.proof_files[0].descriptor,parsed.proof_files[0].recipe]) assert.ok(files.includes(a.sha256));
  assert.equal(p.manifest.length,f.plan.manifest.length,'no raw proof or extra upload slot was introduced');
  assert.equal(stored(f.artifacts).has(rawProof.sha256),false,'all asserted proof results in this fixture are synthetic');
});

test('v2 proof representation references cannot exempt arbitrary missing, mismatched or unrelated proof artifacts',()=>{
  const f=descriptorFixture(),p=parseVerificationPlan(f.plan);validateLeanV2Artifacts(p.lean,p.manifest,stored(f.artifacts));
  const e=leanEvidence(p.lean,leanStatementBinding(p.lean));
  e.scientific_identity=leanScientificBinding(p.lean);e.execution_identity=leanExecutionBinding(p.lean);
  e.claims[0].proof_sha256=p.lean.scientific_identity.proof_artifacts[0].artifact.sha256;e.proof_files=clone(p.lean.proof_representations);
  for(const mutate of [e=>e.proof_files=[],e=>e.proof_files[0].artifact.sha256=digest('Unrelated decoded proof'),
    e=>e.proof_files[0].descriptor.sha256=digest('Wrong descriptor'),e=>e.proof_files[0].inputs[0].bytes++,
    e=>e.proof_files[0].inputs[0].sha256=digest('Missing encoded input'),e=>e.proof_files[0].recipe=null,
    e=>e.proof_files[0].recipe.sha256=digest('Unreviewed decoder'),e=>e.claims[0].proof_sha256=null]) {
    const next=clone(e);mutate(next);assert.throws(()=>validateLeanProofFiles(p.lean,parseLeanEvidence(next)));
    assert.deepEqual(assessLeanEvidence(p.lean,parseLeanEvidence(next)).checked,[]);
  }
  const hidden=clone(e);hidden.proof_files[0].host_ip='192.0.2.1';assert.throws(()=>parseLeanEvidence(hidden));
  const omitted=clone(e);delete omitted.proof_files;assert.throws(()=>parseLeanEvidence(omitted));
});

test('v2 declared proof transport is checked against the actual descriptor rather than trusting self-consistent bare hashes',()=>{
  const f=descriptorFixture();f.plan.lean.proof_representations[0].inputs[0].bytes++;
  const p=parseVerificationPlan(f.plan);
  assert.throws(()=>validateLeanV2Artifacts(p.lean,p.manifest,stored(f.artifacts)),/actual validated/);
  const direct=prepared(),e=leanEvidence(direct.p.lean,leanStatementBinding(direct.p.lean));
  e.scientific_identity=leanScientificBinding(direct.p.lean);e.execution_identity=leanExecutionBinding(direct.p.lean);
  e.claims[0].proof_sha256=direct.p.lean.scientific_identity.proof_artifacts[0].artifact.sha256;e.proof_files=clone(direct.p.lean.proof_representations);
  validateLeanProofFiles(direct.p.lean,parseLeanEvidence(e));
  assert.ok(leanEvidenceFiles(parseLeanEvidence(e)).includes(e.claims[0].proof_sha256),'direct proof uploads still require actual physical proof artifact');
});
