/** Separately labelled Lean-kernel assurance. Inert pins/reports only; never executes code. */
import { bad, prose } from './research-format.js';
import { identityObject, parseIdentityArtifact, parseScientificIdentityV2, parseExecutionIdentityV2, scientificIdentityV2, scientificMeaningV2, executionIdentityV2, type IdentityArtifact } from './lean-identity-v2.js';
import { createHash } from 'node:crypto';
export const LEAN_KERNEL_POLICY = 'lean-kernel-v1';
type Manifest = {path:string;sha256:string;role:string}[];
export type KernelObject = {artifact:IdentityArtifact;claim_ids:string[]};
export type KernelCustody = {sources:IdentityArtifact;objects:IdentityArtifact;provenance:IdentityArtifact};
export type KernelProfile = {
  policy:typeof LEAN_KERNEL_POLICY;paper_slug:string;manuscript_sha256:string;statement_bundle_sha256:string;statement_review_id:number|null;
  toolchain:string;toolchain_sha256:string;lakefile_sha256:string;lake_manifest_sha256:string;
  dependencies:{name:string;revision:string;sha256:string}[];validator_sha256:string;
  claims:ReturnType<typeof parseScientificIdentityV2>['claims'];
  scientific_identity:ReturnType<typeof parseScientificIdentityV2>;execution_identity:ReturnType<typeof parseExecutionIdentityV2>;
  artifact_bindings:{artifact:IdentityArtifact;representation:{kind:'manifest'|'descriptor';path:string}}[];
  artifact_roles:{path:string;kind:'scientific'|'execution'|'provenance'}[];
  kernel_objects:KernelObject[];kernel_custody:KernelCustody;
  comparator_revision?:never;external_checker?:never;execution_review_id?:never;proof_representations?:never;
};
export type KernelEvidence = {
  policy:typeof LEAN_KERNEL_POLICY;statement_binding:string;scientific_identity:string;execution_identity:string;toolchain:string;validator_sha256:string;
  audit_sha256:string;axioms_sha256:string;custody_sha256:string;
  sandbox:boolean;offline:boolean;clean_environment:boolean;pinned_inputs:boolean;outside_sandbox:boolean;kernel_checked:boolean;source_objects_verified:boolean;
  claims:{id:string;declaration:string;result:'checked'|'failed'|'missing';statement_matches:boolean;axioms:string[];object_sha256:string|null;proof_sha256?:never}[];
  comparator_revision?:never;external_checker_sha256?:never;export_validated?:never;external_checked?:never;proof_files?:never;
};
const sha=(x:any)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function hash(x:any):string {if(!sha(x))bad('Lean kernel pin needs lowercase SHA-256');return x;}
const canonical=(x:any):any=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const same=(a:any,b:any)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function rows(raw:any,max=4096):any[] {
  if(!Array.isArray(raw)||!raw.length||raw.length>max||Reflect.ownKeys(raw).some(k=>k!=='length'&&(typeof k!=='string'||!/^(?:0|[1-9][0-9]*)$/.test(k)||Number(k)>=raw.length))||Array.from({length:raw.length},(_,i)=>Object.getOwnPropertyDescriptor(raw,String(i))).some(d=>!d||!Object.hasOwn(d,'value')))bad('Lean kernel inventory requires bounded dense data');
  return raw;
}
const sorted=<T>(list:T[],key:(x:T)=>string)=>[...list].sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0);
export function parseKernelProfile(raw:unknown,manifest:Manifest,targets:string[],checker:string):KernelProfile {
  const p=identityObject(raw,['policy','paper_slug','manuscript_sha256','statement_bundle_sha256','statement_review_id','toolchain','toolchain_sha256','lakefile_sha256','lake_manifest_sha256','dependencies','validator_sha256','claims','scientific_identity','execution_identity','artifact_bindings','artifact_roles','kernel_objects','kernel_custody'],'Lean kernel profile');
  if(p.policy!==LEAN_KERNEL_POLICY)bad('unsupported Lean kernel policy');
  const science=parseScientificIdentityV2(p.scientific_identity),execution=parseExecutionIdentityV2(p.execution_identity);
  if(p.statement_review_id!==null&&(!Number.isSafeInteger(p.statement_review_id)||p.statement_review_id<1))bad('Lean kernel statement review needs an id or null');
  if(typeof p.toolchain!=='string'||!/^leanprover\/lean4:v4\.\d+\.\d+(?:-rc\d+)?$/.test(p.toolchain))bad('Lean kernel needs exact Lean release');
  const claims=sorted(rows(p.claims,30).map(c=>{
    identityObject(c,['id','locator','declaration','target','coverage','assumptions'],'kernel claim alias');
    if(!Array.isArray(c.assumptions))bad('kernel claim assumptions required');
    return {...c,assumptions:sorted(c.assumptions,(s:any)=>s)};
  }),c=>c.id);
  if(science.paper_slug!==p.paper_slug||science.manuscript.sha256!==p.manuscript_sha256||science.statement_bundle.sha256!==p.statement_bundle_sha256||!same(claims,science.claims))bad('Lean kernel aliases differ from exact scientific identity');
  if(targets.some(t=>!science.claims.some(c=>c.target===t))||science.claims.some(c=>!targets.includes(c.target)||!manifest.some(f=>f.path===c.target&&f.role==='target')))bad('every Lean kernel target needs exact scientific claim mapping');
  const pin=(value:any,role:string)=>{hash(value);if(!manifest.some(f=>f.sha256===value&&f.role===role))bad('Lean kernel alias pin missing from manifested role');return value as string;};
  pin(p.manuscript_sha256,'input');pin(p.statement_bundle_sha256,'input');
  for(const field of ['toolchain_sha256','lakefile_sha256','lake_manifest_sha256'])if(!science.source_artifacts.some(a=>a.sha256===pin(p[field],'dependency')))bad('kernel toolchain/lake aliases missing from science');
  if(pin(p.validator_sha256,'checker')!==checker||execution.validator.sha256!==checker)bad('Lean kernel validator differs from actual checker');
  const dependencies=sorted(rows(p.dependencies,60).map(raw=>{const d=identityObject(raw,['name','revision','sha256'],'kernel dependency');hash(d.sha256);if(!/^[a-f0-9]{40}$/.test(d.revision))bad('kernel dependency revision required');return {name:d.name as string,revision:d.revision as string,sha256:d.sha256 as string};}),d=>d.name);
  if(!same(dependencies.map(d=>({name:d.name,revision:d.revision})),science.semantic_dependencies.map(d=>({name:d.name,revision:d.revision}))))bad('kernel dependencies differ from science');
  const bindings=sorted(rows(p.artifact_bindings).map(raw=>{
    const b=identityObject(raw,['artifact','representation'],'kernel artifact binding'),artifact=parseIdentityArtifact(b.artifact),r=identityObject(b.representation,['kind','path'],'kernel representation');
    const f=manifest.find(f=>f.path===r.path);
    if(!f||!['manifest','descriptor'].includes(r.kind)||r.kind==='manifest'&&(r.path!==artifact.path||f.sha256!==artifact.sha256)||r.kind==='descriptor'&&f.role!=='dependency')bad('kernel artifact must bind exact manifest or descriptor');
    return {artifact,representation:{kind:r.kind as 'manifest'|'descriptor',path:r.path as string}};
  }),b=>b.artifact.path);
  if(new Set(bindings.map(b=>b.artifact.path.toLowerCase())).size!==bindings.length)bad('duplicate kernel binding');
  const roles=sorted(rows(p.artifact_roles,64).map(raw=>{const r=identityObject(raw,['path','kind'],'kernel artifact role');if(!manifest.some(f=>f.path===r.path)||!['scientific','execution','provenance'].includes(r.kind))bad('invalid kernel artifact role');return {path:r.path as string,kind:r.kind as 'scientific'|'execution'|'provenance'};}),r=>r.path);
  if(roles.length!==manifest.length||new Set(roles.map(r=>r.path)).size!==roles.length)bad('kernel roles must classify every manifested file');
  const bind=(a:IdentityArtifact)=>{const b=bindings.find(b=>same(b.artifact,a));if(!b)bad('consumed kernel artifact lacks exact binding');return b;};
  // Existing export pins remain scientific identity metadata, not consumed kernel proof inputs.
  for(const a of [science.manuscript,science.statement_bundle,...science.source_artifacts])if(bind(a).representation.kind!=='manifest'||roles.find(r=>r.path===a.path)?.kind!=='scientific')bad('kernel mathematical source must be direct scientific bytes');
  for(const d of science.semantic_dependencies){const b=bind(d.source);if(manifest.find(f=>f.path===b.representation.path)?.sha256!==dependencies.find(a=>a.name===d.name)?.sha256)bad('kernel dependency transport alias mismatch');}
  for(const a of [execution.validator,execution.invocation,...execution.package_artifacts])if(bind(a).representation.kind!=='manifest'||roles.find(r=>r.path===a.path)?.kind!=='execution')bad('kernel executable assets require direct execution bindings');
  if(!same(sorted(roles.filter(r=>r.kind==='execution').map(r=>r.path),x=>x),sorted(execution.package_artifacts.map(a=>a.path),x=>x)))bad('kernel execution inventory must cover all execution-classified files');
  for(const f of manifest.filter(f=>f.path.endsWith('.lean')))if(![science.statement_bundle,...science.source_artifacts].some(a=>a.path===f.path&&a.sha256===f.sha256)&&roles.find(r=>r.path===f.path)?.kind!=='execution')bad('kernel Lean source omitted from science');
  const byHash=(h:string)=>bindings.filter(b=>b.artifact.sha256===h);
  if(!byHash(execution.isolation.policy_sha256).length)bad('kernel isolation policy must be pinned');
  for(const t of execution.tools)if(!byHash(t.source_sha256).length||!byHash(t.binary_sha256).length)bad('kernel tool source and binary must be pinned');
  const lean=science.semantic_dependencies.find(d=>d.name.toLowerCase()==='lean');
  if(!lean||!execution.tools.some(t=>t.name==='lean'&&t.revision===lean.revision&&t.source_kind===lean.source_kind&&t.source_sha256===lean.source.sha256))bad('kernel tool must match exact semantic Lean source scope');
  const kernel_objects=sorted(rows(p.kernel_objects,30).map(raw=>{const k=identityObject(raw,['artifact','claim_ids'],'kernel object');const artifact=parseIdentityArtifact(k.artifact);bind(artifact);const ids=sorted(rows(k.claim_ids,30),(x:any)=>x);if(ids.some(id=>!science.claims.some(c=>c.id===id))||new Set(ids).size!==ids.length)bad('kernel object claim mapping invalid');return {artifact,claim_ids:ids as string[]};}),k=>k.artifact.path);
  const ids=kernel_objects.flatMap(k=>k.claim_ids);
  if(new Set(kernel_objects.map(k=>k.artifact.path.toLowerCase())).size!==kernel_objects.length||new Set(ids).size!==ids.length||!same(sorted(ids,x=>x),science.claims.map(c=>c.id)))bad('kernel objects must map every claim exactly once');
  const custody=identityObject(p.kernel_custody,['sources','objects','provenance'],'kernel custody');
  const kernel_custody={sources:parseIdentityArtifact(custody.sources),objects:parseIdentityArtifact(custody.objects),provenance:parseIdentityArtifact(custody.provenance)};
  for(const a of Object.values(kernel_custody))bind(a);
  for(const b of bindings.filter(b=>b.representation.kind==='descriptor'))if(roles.find(r=>r.path===b.representation.path)?.kind!=='provenance')bad('kernel mixed descriptors are provenance');
  return {policy:LEAN_KERNEL_POLICY,paper_slug:science.paper_slug,manuscript_sha256:science.manuscript.sha256,statement_bundle_sha256:science.statement_bundle.sha256,statement_review_id:p.statement_review_id,
    toolchain:p.toolchain,toolchain_sha256:p.toolchain_sha256,lakefile_sha256:p.lakefile_sha256,lake_manifest_sha256:p.lake_manifest_sha256,
    dependencies,validator_sha256:checker,claims:science.claims,scientific_identity:science,execution_identity:execution,artifact_bindings:bindings,artifact_roles:roles,kernel_objects,kernel_custody};
}
export function validateKernelArtifacts(p:KernelProfile,manifest:Manifest,files:Map<string,{bytes:number;content?:string}>):void {
  const direct=(a:IdentityArtifact)=>{if(!manifest.some(f=>f.path===a.path&&f.sha256===a.sha256)||files.get(a.sha256)?.bytes!==a.bytes)bad('kernel artifact bytes differ from uploaded manifest');};
  const s=p.scientific_identity,x=p.execution_identity;
  const consumed=[s.manuscript,s.statement_bundle,...s.source_artifacts,...s.semantic_dependencies.map(d=>d.source),...p.kernel_objects.map(k=>k.artifact),...Object.values(p.kernel_custody)];
  const consumedHashes=new Set([...consumed.map(a=>a.sha256),x.isolation.policy_sha256,...x.tools.flatMap(t=>[t.source_sha256,t.binary_sha256])]);
  for(const b of p.artifact_bindings){
    if(b.representation.kind==='manifest'){direct(b.artifact);continue;}
    const f=manifest.find(f=>f.path===b.representation.path)!,stored=files.get(f.sha256);
    if(!stored?.content||stored.bytes>1024**2||Buffer.byteLength(stored.content)!==stored.bytes||createHash('sha256').update(stored.content).digest('hex')!==f.sha256)bad('kernel descriptor needs exact inert uploaded JSON <=1MiB');
    let raw:any;try{raw=JSON.parse(stored.content);}catch{bad('invalid kernel descriptor JSON');}
    const d=identityObject(raw,['schema','artifacts'],'kernel descriptor');if(d.schema!=='solveathome-lean-artifact-descriptor-v2')bad('unsupported kernel descriptor');
    const entries=rows(d.artifacts).map(raw=>{const e=identityObject(raw,['artifact','category','representation'],'kernel descriptor entry');return {category:e.category,representation:e.representation,artifact:parseIdentityArtifact(e.artifact)};});
    if(new Set(entries.map(e=>e.artifact.path.toLowerCase())).size!==entries.length)bad('duplicate kernel descriptor artifacts');
    const e=entries.find(e=>same(e.artifact,b.artifact));if(!e)bad('kernel descriptor artifact mismatch');
    if(!['semantic-source','proof','tool-source','tool-binary','policy','kernel-object','kernel-custody'].includes(e.category))bad('unsupported kernel descriptor category');
    if(!consumedHashes.has(b.artifact.sha256))continue; // Supplemental retained comparator/export metadata is not assurance.
    if(s.semantic_dependencies.some(d=>same(d.source,b.artifact))&&e.category!=='semantic-source'||p.kernel_objects.some(k=>same(k.artifact,b.artifact))&&e.category!=='kernel-object'||Object.values(p.kernel_custody).some(a=>same(a,b.artifact))&&!['kernel-custody','semantic-source'].includes(e.category))bad('kernel descriptor category differs from consumed role');
    if(x.tools.some(t=>t.binary_sha256===b.artifact.sha256)&&e.category!=='tool-binary'||x.tools.some(t=>t.source_sha256===b.artifact.sha256)&&!['semantic-source','tool-source'].includes(e.category)||x.isolation.policy_sha256===b.artifact.sha256&&e.category!=='policy')bad('kernel descriptor tool category mismatch');
    if(e.representation!==null){const r=identityObject(e.representation,['inputs','recipe'],'kernel reconstruction');for(const input of rows(r.inputs,64)){const a=parseIdentityArtifact(input);direct(a);}const recipe=parseIdentityArtifact(r.recipe);direct(recipe);if(!x.package_artifacts.some(a=>same(a,recipe)))bad('consumed kernel reconstruction recipe must be exactly executable-pinned');}
    else if(['tool-binary','policy'].includes(e.category))bad('consumed kernel binary/policy needs pinned materialization inputs');
  }
  for(const b of p.artifact_bindings.filter(b=>b.representation.kind==='manifest'))if((x.tools.some(t=>t.binary_sha256===b.artifact.sha256)||x.isolation.policy_sha256===b.artifact.sha256)&&p.artifact_roles.find(r=>r.path===b.artifact.path)?.kind!=='execution')bad('kernel tool binary/policy must be execution inventory');
  for(const a of [x.validator,x.invocation,...x.package_artifacts])direct(a);
}
export function parseKernelEvidence(raw:unknown):KernelEvidence {
  const e=identityObject(raw,['policy','statement_binding','scientific_identity','execution_identity','toolchain','validator_sha256','audit_sha256','axioms_sha256','custody_sha256','sandbox','offline','clean_environment','pinned_inputs','outside_sandbox','kernel_checked','source_objects_verified','claims'],'Lean kernel evidence');
  if(e.policy!==LEAN_KERNEL_POLICY)bad('unsupported kernel evidence');
  const flags=['sandbox','offline','clean_environment','pinned_inputs','outside_sandbox','kernel_checked','source_objects_verified'];
  if(flags.some(k=>typeof e[k]!=='boolean'))bad('kernel evidence flags must be boolean');
  if(!Array.isArray(e.claims)||e.claims.length>30)bad('kernel evidence needs at most30 claims');
  if(e.claims.length)rows(e.claims,30);
  const claims=e.claims.map((raw:any)=>{const c=identityObject(raw,['id','declaration','result','statement_matches','axioms','object_sha256'],'kernel evidence claim');if(typeof c.id!=='string'||!/^\w[\w.-]{0,159}$/.test(c.id)||typeof c.declaration!=='string'||!['checked','failed','missing'].includes(c.result)||typeof c.statement_matches!=='boolean'||!Array.isArray(c.axioms)||c.axioms.length>100||c.axioms.some((a:any)=>typeof a!=='string'||!a||a.length>1000)||new Set(c.axioms).size!==c.axioms.length)bad('invalid kernel evidence claim');return {id:c.id,declaration:c.declaration,result:c.result,statement_matches:c.statement_matches,axioms:c.axioms,object_sha256:c.object_sha256===null?null:hash(c.object_sha256)};});
  if(new Set(claims.map((c:any)=>c.id)).size!==claims.length)bad('duplicate kernel claim results');
  return {policy:LEAN_KERNEL_POLICY,statement_binding:hash(e.statement_binding),scientific_identity:hash(e.scientific_identity),execution_identity:hash(e.execution_identity),toolchain:prose(e.toolchain,'kernel toolchain',200),validator_sha256:hash(e.validator_sha256),audit_sha256:hash(e.audit_sha256),axioms_sha256:hash(e.axioms_sha256),custody_sha256:hash(e.custody_sha256),...Object.fromEntries(flags.map(k=>[k,e[k]])),claims} as KernelEvidence;
}
export function assessKernelEvidence(p:KernelProfile,e:KernelEvidence|any):{checked:string[];issues:string[]} {
  const issues:string[]=[];
  if(!e)return {checked:[],issues:['No structured Lean kernel validation evidence.']};
  if(e.policy!==LEAN_KERNEL_POLICY||e.statement_binding!==scientificMeaningV2(p.scientific_identity)||e.scientific_identity!==scientificIdentityV2(p.scientific_identity)||e.execution_identity!==executionIdentityV2(p.execution_identity)||e.toolchain!==p.toolchain||e.validator_sha256!==p.validator_sha256)issues.push('Kernel evidence differs from the exact scientific/execution profile.');
  if(['sandbox','offline','clean_environment','pinned_inputs','outside_sandbox','kernel_checked','source_objects_verified'].some(k=>e[k]!==true))issues.push('Isolated pinned Lean-kernel execution and source/object custody were not all reported.');
  if(e.claims?.some((c:any)=>!p.claims.some(t=>t.id===c.id)))issues.push('Kernel receipt names an unmapped claim.');
  if(issues.length)return {checked:[],issues};
  const checked:string[]=[];
  for(const c of p.claims){const r=e.claims?.find((r:any)=>r.id===c.id);
    if(!r||r.result!=='checked'||!r.object_sha256)issues.push(`${c.id}: kernel object missing or not checked.`);
    else if(r.declaration!==c.declaration||r.statement_matches!==true)issues.push(`${c.id}: theorem differs from reviewed statement.`);
    else if(!p.kernel_objects.some(k=>k.claim_ids.includes(c.id)&&k.artifact.sha256===r.object_sha256))issues.push(`${c.id}: checked object differs from immutable kernel pin.`);
    else if(r.axioms.some((a:string)=>!['propext','Classical.choice','Quot.sound'].includes(a)))issues.push(`${c.id}: disallowed transitive axiom.`);
    else checked.push(c.id);
  }
  return {checked,issues};
}

export function validateKernelReceiptIdentity(p:KernelProfile,e:KernelEvidence):void {
  if(e.policy!==p.policy||e.statement_binding!==scientificMeaningV2(p.scientific_identity)||e.scientific_identity!==scientificIdentityV2(p.scientific_identity)||e.execution_identity!==executionIdentityV2(p.execution_identity)||e.validator_sha256!==p.validator_sha256||e.toolchain!==p.toolchain)bad('kernel receipt must bind the exact scientific/execution profile');
  for(const c of e.claims)if(!p.claims.some(t=>t.id===c.id&&t.declaration===c.declaration)||c.result==='checked'&&!c.object_sha256||c.object_sha256&&!p.kernel_objects.some(k=>k.claim_ids.includes(c.id)&&k.artifact.sha256===c.object_sha256))bad('kernel receipt object/declaration must match the immutable mapped input');
}
