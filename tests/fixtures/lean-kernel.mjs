// Inert test pins only: these fixtures do not contain a real proof or run a kernel.
import {leanV2Fixture} from './lean-v2.mjs';
import {digest} from './lean.mjs';
import {leanStatementBinding,leanScientificBinding,leanExecutionBinding} from '../../src/lib/lean-verification.ts';
export function leanKernelFixture({descriptor=false}={}) {
  const {plan,artifacts}=leanV2Fixture();
  const p=plan.lean;p.policy='lean-kernel-v1';
  for(const key of ['comparator_revision','external_checker','execution_review_id','proof_representations'])delete p[key];
  p.execution_identity.tools=p.execution_identity.tools.filter(t=>t.name==='lean');
  const objectText=descriptor?'Synthetic external retained object':'Synthetic declaration-owning object';
  const object={path:'objects/Main.olean',sha256:digest(objectText),bytes:Buffer.byteLength(objectText)};
  const added=[['kernel-sources.json','Synthetic exact source inventory.','dependency'],['kernel-provenance.json','Synthetic build/object custody.','dependency']];
  if(descriptor)added.push(['kernel-objects.json',JSON.stringify({schema:'solveathome-lean-artifact-descriptor-v2',artifacts:[{artifact:object,category:'kernel-object',representation:null}]}),'dependency']);
  else added.push(['objects/Main.olean','Synthetic declaration-owning object','dependency'],['kernel-objects.json','Synthetic complete object inventory.','dependency']);
  for(const [path,content,role] of added){const a={path,sha256:digest(content),bytes:Buffer.byteLength(content)};artifacts.push([path,content,role]);plan.manifest.push({path,sha256:a.sha256,role});p.artifact_bindings.push({artifact:a,representation:{kind:'manifest',path}});const kind=descriptor&&path==='kernel-objects.json'?'provenance':'execution';p.artifact_roles.push({path,kind});if(kind==='execution')p.execution_identity.package_artifacts.push(a);}
  if(descriptor)p.artifact_bindings.push({artifact:object,representation:{kind:'descriptor',path:'kernel-objects.json'}});
  p.kernel_objects=[{artifact:object,claim_ids:['claim']}];
  const a=path=>structuredClone(p.artifact_bindings.find(b=>b.artifact.path===path).artifact);
  p.kernel_custody={sources:a('kernel-sources.json'),objects:a('kernel-objects.json'),provenance:a('kernel-provenance.json')};
  plan.tools=['lean'];
  return {plan,artifacts};
}
export function kernelEvidence(p) {
 return {policy:'lean-kernel-v1',statement_binding:leanStatementBinding(p),scientific_identity:leanScientificBinding(p),execution_identity:leanExecutionBinding(p),
 toolchain:p.toolchain,validator_sha256:p.validator_sha256,audit_sha256:digest('Synthetic kernel audit'),axioms_sha256:digest('Synthetic kernel axiom report'),custody_sha256:digest('Synthetic kernel custody report'),
 sandbox:true,offline:true,clean_environment:true,pinned_inputs:true,outside_sandbox:true,kernel_checked:true,source_objects_verified:true,
 claims:p.claims.map(c=>({id:c.id,declaration:c.declaration,result:'checked',statement_matches:true,axioms:['propext','Classical.choice','Quot.sound'],object_sha256:p.kernel_objects.find(k=>k.claim_ids.includes(c.id)).artifact.sha256}))};
}
export const artifactFiles=artifacts=>new Map(artifacts.map(([,content])=>[digest(content),{bytes:Buffer.byteLength(content),content}]));
