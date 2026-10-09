/** Inert Lean evidence contracts. This module never loads or executes a proof or validator. */
import { createHash } from 'node:crypto';
import { LEAN_KERNEL_POLICY, parseKernelProfile, validateKernelArtifacts, parseKernelEvidence, assessKernelEvidence, type KernelProfile, type KernelEvidence } from './lean-kernel.js';
export { LEAN_KERNEL_POLICY } from './lean-kernel.js';
import { bad, object, prose } from './research-format.js';
import { identityObject, parseIdentityArtifact, parseScientificIdentityV2, parseExecutionIdentityV2, scientificIdentityV2, scientificMeaningV2, executionIdentityV2, type IdentityArtifact } from './lean-identity-v2.js';

export const LEAN_POLICY = 'lean-comparator-v1';
export const LEAN_POLICY_V2 = 'lean-comparator-v2';
export const LEAN_AXIOMS = ['propext', 'Classical.choice', 'Quot.sound'] as const;
type Manifest = { path: string; sha256: string; role: string }[];
export type LeanClaim = { id: string; locator: string; declaration: string; target: string; coverage: 'full' | 'partial'; assumptions: string[] };
export type ComparatorLeanProfile = {
  policy: typeof LEAN_POLICY | typeof LEAN_POLICY_V2; paper_slug: string; manuscript_sha256: string;
  statement_bundle_sha256: string; statement_review_id: number | null;
  toolchain: string; toolchain_sha256: string; lakefile_sha256: string; lake_manifest_sha256: string;
  dependencies: { name: string; revision: string; sha256: string }[];
  validator_sha256: string; comparator_revision: string;
  external_checker: { name: string; revision: string; sha256: string };
  claims: LeanClaim[];
  scientific_identity?: ReturnType<typeof parseScientificIdentityV2>;
  execution_identity?: ReturnType<typeof parseExecutionIdentityV2>;
  execution_review_id?: number | null;
  artifact_bindings?: ArtifactBinding[];
  artifact_roles?: { path: string; kind: 'scientific' | 'execution' | 'provenance' }[];
  proof_representations?: LeanProofRepresentation[];
};
export type LeanProfile = ComparatorLeanProfile | KernelProfile;
export type ArtifactBinding = { artifact: IdentityArtifact; representation: { kind: 'manifest' | 'descriptor'; path: string } };
export type LeanProofRepresentation = { artifact: IdentityArtifact; descriptor: IdentityArtifact | null; inputs: IdentityArtifact[]; recipe: IdentityArtifact | null };
export type ComparatorLeanEvidence = {
  policy: string; statement_binding: string; toolchain: string; validator_sha256: string;
  comparator_revision: string; external_checker_sha256: string;
  audit_sha256: string; axioms_sha256: string;
  sandbox: boolean; offline: boolean; clean_environment: boolean; pinned_inputs: boolean;
  export_validated: boolean; outside_sandbox: boolean; kernel_checked: boolean; external_checked: boolean;
  claims: { id: string; declaration: string; result: 'checked' | 'failed' | 'missing'; statement_matches: boolean; axioms: string[]; proof_sha256: string | null; object_sha256?: never }[];
  scientific_identity?: string; execution_identity?: string;
  proof_files?: LeanProofRepresentation[];
};
export type LeanEvidence = ComparatorLeanEvidence | KernelEvidence;
export const isSha256 = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const revision = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const identifier = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,159}$/.test(x);
function hash(x: unknown, field: string): string { if (!isSha256(x)) bad(`${field} needs a lowercase sha256`); return x as string; }
function names(x: unknown, field: string): string[] {
  if (!Array.isArray(x) || x.length > 100 || x.some(s => typeof s !== 'string' || !s.trim() || s.length > 1000) || new Set(x).size !== x.length) bad(`${field} needs a unique list of at most 100 strings`);
  return x as string[];
}
const canonical = (x: any): any => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
/** The review reference and proof bytes can change; the meaning, mapping and trusted environment cannot. */
export function leanStatementBinding(profile: LeanProfile): string {
  if (profile.policy === LEAN_POLICY_V2 || profile.policy === LEAN_KERNEL_POLICY) return scientificMeaningV2(profile.scientific_identity);
  const { statement_review_id, ...binding } = profile;
  return createHash('sha256').update('solveathome-lean-statement-v1\n').update(JSON.stringify(canonical(binding))).digest('hex');
}
export function leanExecutionBinding(profile: LeanProfile): string | null {
  return profile.policy === LEAN_POLICY_V2 || profile.policy === LEAN_KERNEL_POLICY ? executionIdentityV2(profile.execution_identity) : null;
}
export function leanScientificBinding(profile: LeanProfile): string | null {
  return profile.policy === LEAN_POLICY_V2 || profile.policy === LEAN_KERNEL_POLICY ? scientificIdentityV2(profile.scientific_identity) : null;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const ordered = <T>(rows: T[], key: (r: T) => string) => [...rows].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
function boundedRows(raw: unknown, field: string, maximum = 4096): any[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > maximum ||
      Reflect.ownKeys(raw).some(k=>k!=='length' && (typeof k!=='string' || !/^(?:0|[1-9][0-9]*)$/.test(k) || Number(k)>=raw.length)) ||
      Array.from({length:raw.length},(_,i)=>Object.getOwnPropertyDescriptor(raw,String(i))).some(d=>!d || !Object.hasOwn(d,'value'))) bad(`${field} requires a dense bounded data list`);
  return raw;
}
export function parseLeanProofRepresentations(raw: unknown, allowEmpty = false): LeanProofRepresentation[] {
  if (allowEmpty && Array.isArray(raw) && raw.length===0 && Reflect.ownKeys(raw).length===1) return [];
  const rows = ordered(boundedRows(raw,'proof representations').map(raw=> {
    const p=identityObject(raw,['artifact','descriptor','inputs','recipe'],'proof representation');
    const inputs=ordered(boundedRows(p.inputs,'proof representation inputs',64).map(parseIdentityArtifact),a=>a.path);
    if (new Set(inputs.map(a=>a.path.toLowerCase())).size!==inputs.length) bad('duplicate proof representation inputs');
    return {artifact:parseIdentityArtifact(p.artifact),descriptor:p.descriptor===null?null:parseIdentityArtifact(p.descriptor),inputs,recipe:p.recipe===null?null:parseIdentityArtifact(p.recipe)};
  }),p=>p.artifact.path);
  if (new Set(rows.map(p=>p.artifact.path.toLowerCase())).size!==rows.length) bad('duplicate proof representation artifacts');
  return rows;
}
function parseV2Profile(p: any, legacy: ComparatorLeanProfile, manifest: Manifest): LeanProfile {
  identityObject(p, ['policy','paper_slug','manuscript_sha256','statement_bundle_sha256','statement_review_id',
    'toolchain','toolchain_sha256','lakefile_sha256','lake_manifest_sha256','dependencies','validator_sha256',
    'comparator_revision','external_checker','claims','scientific_identity','execution_identity','execution_review_id',
    'artifact_bindings','artifact_roles','proof_representations'], 'Lean v2 profile');
  const science = parseScientificIdentityV2(p.scientific_identity), execution = parseExecutionIdentityV2(p.execution_identity);
  if (p.execution_review_id !== null && (!Number.isSafeInteger(p.execution_review_id) || p.execution_review_id < 1)) bad('lean.execution_review_id needs a review id or null');
  const scientificClaims = ordered(legacy.claims.map(c => ({ ...c, assumptions: ordered(c.assumptions, x => x) })), c => c.id);
  if (science.paper_slug !== legacy.paper_slug || science.manuscript.sha256 !== legacy.manuscript_sha256 ||
      science.statement_bundle.sha256 !== legacy.statement_bundle_sha256 || !same(science.claims, scientificClaims)) bad('v2 scientific identity differs from paper, statement or claim aliases');
  const deps = ordered(legacy.dependencies.map(d => ({name:d.name,revision:d.revision})), d => d.name);
  if (!same(deps, science.semantic_dependencies.map(d => ({name:d.name,revision:d.revision})))) bad('v2 semantic dependency names/revisions differ from legacy aliases');
  const bindings: ArtifactBinding[] = ordered(boundedRows(p.artifact_bindings, 'artifact_bindings').map(raw => {
    const b = identityObject(raw, ['artifact','representation'], 'artifact binding');
    const a = parseIdentityArtifact(b.artifact), r = identityObject(b.representation, ['kind','path'], 'artifact representation');
    const manifested = manifest.find(f => f.path === r.path);
    if (!manifested || !['manifest','descriptor'].includes(r.kind) || r.kind === 'manifest' && (r.path !== a.path || manifested.sha256 !== a.sha256)) bad('artifact binding must reference exact manifested bytes or a manifested descriptor');
    if (r.kind === 'descriptor' && manifested.role !== 'dependency') bad('artifact descriptor must be a manifested dependency');
    return { artifact:a, representation:{kind:r.kind as 'manifest'|'descriptor',path:r.path as string} };
  }), b => b.artifact.path);
  if (new Set(bindings.map(b => b.artifact.path.toLowerCase())).size !== bindings.length) bad('artifact binding paths must be unique');
  const roles = ordered(boundedRows(p.artifact_roles, 'artifact_roles', 64).map(raw => {
    const r = identityObject(raw, ['path','kind'], 'artifact role');
    if (!manifest.some(f => f.path === r.path) || !['scientific','execution','provenance'].includes(r.kind)) bad('artifact role must classify a manifested path');
    return {path:r.path as string,kind:r.kind as 'scientific'|'execution'|'provenance'};
  }), r => r.path);
  if (new Set(roles.map(r => r.path)).size !== roles.length || roles.length !== manifest.length) bad('every manifest artifact must be classified exactly once');
  const role = (path: string) => roles.find(r => r.path === path)?.kind;
  const bind = (a: IdentityArtifact) => {
    const b = bindings.find(b => b.artifact.path === a.path);
    if (!b || !same(a,b.artifact)) bad('every v2 identity artifact needs an exact binding');
    return b;
  };
  const scientific = [science.manuscript, science.statement_bundle, ...science.source_artifacts,
    ...science.proof_artifacts.map(p => p.artifact), ...science.semantic_dependencies.map(d => d.source)];
  for (const a of scientific) { const b = bind(a); if (b.representation.kind === 'manifest' && role(b.representation.path) !== 'scientific') bad('scientific artifact must be classified scientific'); }
  for (const a of [science.manuscript,science.statement_bundle,...science.source_artifacts]) if (bind(a).representation.kind !== 'manifest') bad('manuscript, statement bundle and authored sources require direct manifested bindings');
  if (science.proof_artifacts.some(p=>p.artifact.bytes > 128*1024**2)) bad('v2 reconstructed proof exceeds the existing 128 MiB whole-stream bound');
  if (!manifest.some(f => f.path === execution.validator.path && f.role === 'checker' && f.sha256 === execution.validator.sha256) || execution.validator.sha256 !== legacy.validator_sha256) bad('v2 validator differs from the actual checker');
  const executionArtifacts = [execution.validator, execution.invocation, ...execution.package_artifacts];
  for (const a of executionArtifacts) { const b = bind(a); if (b.representation.kind !== 'manifest' || role(a.path) !== 'execution') bad('execution package artifacts require direct manifested execution bindings'); }
  if (!same(roles.filter(r => r.kind === 'execution').map(r => r.path), execution.package_artifacts.map(a => a.path))) bad('execution identity must pin every execution-classified manifest artifact');
  for (const field of ['toolchain_sha256','lakefile_sha256','lake_manifest_sha256'] as const) if (!science.source_artifacts.some(a => a.sha256 === legacy[field])) bad('v2 toolchain/lake aliases must be in the scientific source inventory');
  const byHash = (sha: string) => bindings.filter(b => b.artifact.sha256 === sha);
  if (!byHash(execution.isolation.policy_sha256).length) bad('v2 isolation policy needs a bound artifact');
  for (const t of execution.tools) if (!byHash(t.source_sha256).length || !byHash(t.binary_sha256).length) bad('v2 tool sources and binaries need artifact bindings');
  const leanSource = science.semantic_dependencies.find(d => d.name.toLowerCase() === 'lean');
  if (!leanSource || !execution.tools.some(t => t.name === 'lean' && t.revision === leanSource.revision && t.source_kind === leanSource.source_kind && t.source_sha256 === leanSource.source.sha256)) bad('v2 Lean tool must use the pinned semantic Lean source/scope');
  const external = execution.tools.find(t => t.name === legacy.external_checker.name && t.revision === legacy.external_checker.revision);
  if (!execution.tools.some(t => t.name === 'comparator' && t.revision === legacy.comparator_revision) || !external ||
      !byHash(external.binary_sha256).some(b=>manifest.find(f=>f.path===b.representation.path)?.sha256===legacy.external_checker.sha256)) bad('v2 execution tools differ from comparator/external-checker transport aliases');
  for (const d of legacy.dependencies) {
    const source = science.semantic_dependencies.find(s => s.name === d.name)!, b = bind(source.source);
    if (manifest.find(f => f.path === b.representation.path)?.sha256 !== d.sha256) bad('v2 dependency alias must pin its exact direct source or descriptor');
  }
  for (const f of manifest.filter(f => f.path.endsWith('.lean'))) if (!science.source_artifacts.some(a => a.path === f.path && a.sha256 === f.sha256) && f.sha256 !== science.statement_bundle.sha256 && role(f.path) !== 'execution') bad('manifested Lean sources cannot be omitted from scientific inventory');
  for (const b of bindings) if (b.representation.kind === 'descriptor' && role(b.representation.path) !== 'provenance') bad('mixed descriptor bytes are provenance, not scientific meaning');
  const proof_representations=parseLeanProofRepresentations(p.proof_representations);
  if (!same(proof_representations.map(p=>p.artifact),ordered(science.proof_artifacts.map(p=>p.artifact),a=>a.path))) bad('proof representations must cover the exact scientific proof inventory');
  for (const r of proof_representations) {
    const b=bind(r.artifact);
    if (b.representation.kind==='manifest') {
      if (r.descriptor!==null || r.recipe!==null || !same(r.inputs,[r.artifact])) bad('direct proof representation must reference only its exact uploaded proof artifact');
    } else {
      const f=manifest.find(f=>f.path===b.representation.path)!;
      if (!r.descriptor || r.descriptor.path!==f.path || r.descriptor.sha256!==f.sha256 || !r.recipe) bad('decoded proof representation must name its exact descriptor and reconstruction recipe');
      for (const a of [...r.inputs,r.recipe,r.descriptor]) if (!manifest.some(f=>f.path===a.path && f.sha256===a.sha256)) bad('proof reconstruction transport must be exactly manifested');
      if (!execution.package_artifacts.some(a=>same(a,r.recipe))) bad('proof reconstruction recipe must be in the reviewed execution inventory');
    }
  }
  return {...legacy, scientific_identity:science,execution_identity:execution,execution_review_id:p.execution_review_id,artifact_bindings:bindings,artifact_roles:roles,proof_representations};
}

/** Bounded, inert descriptor validation. It verifies declared pins and reconstruction inputs, never executes or decodes them. */
export function validateLeanV2Artifacts(profile: LeanProfile, manifest: Manifest, files: Map<string, {bytes:number;content?:string}>): void {
  if (profile.policy === LEAN_KERNEL_POLICY) return validateKernelArtifacts(profile,manifest,files);
  if (profile.policy !== LEAN_POLICY_V2) return;
  const bindings = profile.artifact_bindings!;
  const direct = (a: IdentityArtifact) => {
    const f = manifest.find(f => f.path === a.path && f.sha256 === a.sha256), stored = files.get(a.sha256);
    if (!f || !stored || stored.bytes !== a.bytes) bad('v2 artifact byte count or manifested bytes differ');
  };
  const usedInputs = new Set<string>();
  const descriptors = new Map<string, any[]>();
  for (const b of bindings) {
    if (b.representation.kind === 'manifest') { direct(b.artifact); continue; }
    const path = b.representation.path;
    if (!descriptors.has(path)) {
      const f = manifest.find(f => f.path === path)!, stored = files.get(f.sha256);
      if (!stored?.content || stored.bytes > 1024**2 || Buffer.byteLength(stored.content) !== stored.bytes || createHash('sha256').update(stored.content).digest('hex') !== f.sha256) bad('v2 descriptor must be available exact JSON of at most 1 MiB');
      let raw: unknown; try { raw = JSON.parse(stored.content); } catch { bad('invalid v2 artifact descriptor JSON'); }
      const d = identityObject(raw, ['schema','artifacts'], 'artifact descriptor');
      if (d.schema !== 'solveathome-lean-artifact-descriptor-v2') bad('unsupported artifact descriptor schema');
      const entries = boundedRows(d.artifacts,'descriptor artifacts').map(raw => {
        const e = identityObject(raw,['artifact','category','representation'],'descriptor entry'), artifact = parseIdentityArtifact(e.artifact);
        if (!['semantic-source','proof','tool-source','tool-binary','policy'].includes(e.category)) bad('unknown descriptor category');
        if (e.representation !== null) {
          const r = identityObject(e.representation,['inputs','recipe'],'descriptor reconstruction');
          const inputs = boundedRows(r.inputs,'descriptor inputs',64).map(parseIdentityArtifact), recipe = parseIdentityArtifact(r.recipe);
          if (new Set(inputs.map(a => a.path)).size !== inputs.length) bad('duplicate descriptor representation inputs');
          inputs.forEach(a => {direct(a);usedInputs.add(a.path);}); direct(recipe);
          if (profile.artifact_roles!.find(a => a.path === recipe.path)?.kind !== 'execution') bad('representation recipe must be execution reviewed');
        } else if (e.category === 'proof' || e.category === 'tool-binary' || e.category === 'policy') bad('decoded proof, tool binary and policy need manifested reconstruction inputs');
        return {...e,artifact};
      });
      if (new Set(entries.map(e => e.artifact.path.toLowerCase())).size !== entries.length) bad('duplicate descriptor artifact paths');
      if (entries.some(e=>!bindings.some(b=>b.representation.kind==='descriptor' && b.representation.path===path && same(b.artifact,e.artifact)))) bad('descriptor entries must all be referenced by exact artifact bindings');
      descriptors.set(path,entries);
    }
    const e = descriptors.get(path)!.find(e => same(e.artifact,b.artifact));
    if (!e) bad('v2 artifact must exactly match the uploaded descriptor entry');
    const s = profile.scientific_identity!;
    if (s.semantic_dependencies.some(d => same(d.source,b.artifact)) && e.category !== 'semantic-source' || s.proof_artifacts.some(p => same(p.artifact,b.artifact)) && e.category !== 'proof') bad('descriptor artifact category differs from its scientific role');
    const x = profile.execution_identity!;
    if (x.tools.some(t => t.binary_sha256 === b.artifact.sha256) && e.category !== 'tool-binary' || x.isolation.policy_sha256 === b.artifact.sha256 && e.category !== 'policy' ||
        x.tools.some(t => t.source_sha256 === b.artifact.sha256) && !['semantic-source','tool-source'].includes(e.category)) bad('descriptor artifact category differs from its execution role');
    if (x.tools.some(t=>t.source_sha256===b.artifact.sha256 && t.source_kind==='source-files') && e.representation===null) bad('off-manifest source files need manifested reconstruction inputs');
  }
  const x = profile.execution_identity!;
  for (const b of bindings.filter(b=>b.representation.kind==='manifest')) if ((x.tools.some(t=>t.binary_sha256===b.artifact.sha256) || x.isolation.policy_sha256===b.artifact.sha256) && profile.artifact_roles!.find(r=>r.path===b.artifact.path)?.kind !== 'execution') bad('tool binaries and policy must be execution artifacts');
  for (const b of bindings.filter(b=>b.representation.kind==='manifest')) if (x.tools.some(t=>t.source_sha256===b.artifact.sha256) && !profile.scientific_identity!.semantic_dependencies.some(d=>d.source.sha256===b.artifact.sha256) && profile.artifact_roles!.find(r=>r.path===b.artifact.path)?.kind !== 'execution') bad('tool source must be execution reviewed or a scientific semantic dependency');
  const scientificDirect = new Set([profile.scientific_identity!.manuscript,profile.scientific_identity!.statement_bundle,
    ...profile.scientific_identity!.source_artifacts,...profile.scientific_identity!.proof_artifacts.map(p=>p.artifact),
    ...profile.scientific_identity!.semantic_dependencies.map(d=>d.source)].map(a=>a.path));
  for (const r of profile.artifact_roles!) if (r.kind === 'scientific' && !scientificDirect.has(r.path) && !usedInputs.has(r.path)) bad('unbound scientific transport artifact');
  const resolved = ordered(profile.scientific_identity!.proof_artifacts.map(p=> {
    const b=bindings.find(b=>same(b.artifact,p.artifact))!;
    if (b.representation.kind==='manifest') return {artifact:p.artifact,descriptor:null,inputs:[p.artifact],recipe:null};
    const f=manifest.find(f=>f.path===b.representation.path)!, stored=files.get(f.sha256)!;
    const e=descriptors.get(f.path)!.find(e=>same(e.artifact,p.artifact))!, r=e.representation;
    return {artifact:p.artifact,descriptor:{path:f.path,sha256:f.sha256,bytes:stored.bytes},inputs:ordered(r.inputs.map(parseIdentityArtifact),(a:IdentityArtifact)=>a.path),recipe:parseIdentityArtifact(r.recipe)};
  }),p=>p.artifact.path);
  if (!same(profile.proof_representations,resolved)) bad('declared proof representation differs from the actual validated uploaded descriptor/transport');
}
/** A decoded proof hash is not an uploaded-file exemption: exact transport references were validated at intake. */
export function validateLeanProofFiles(profile: LeanProfile, evidence: LeanEvidence): void {
  if (profile.policy!==LEAN_POLICY_V2) return;
  const refs=parseLeanProofRepresentations(evidence.proof_files,true);
  if (evidence.policy!==LEAN_POLICY_V2 || evidence.scientific_identity!==leanScientificBinding(profile) || evidence.execution_identity!==leanExecutionBinding(profile)) bad('v2 proof files require the exact scientific and execution identities');
  for (const ref of refs) if (!profile.proof_representations!.some(p=>same(p,ref))) bad('receipt proof transport differs from the validated immutable package representation');
  const claimed=new Set(evidence.claims.flatMap(c=>c.proof_sha256?[c.proof_sha256]:[]));
  if (refs.some(r=>!claimed.has(r.artifact.sha256)) || [...claimed].some(h=>!refs.some(r=>r.artifact.sha256===h))) bad('every observed proof hash must have one exact referenced transport; unrelated proof references do not count');
  for (const c of evidence.claims.filter(c=>c.proof_sha256!==null)) if (!profile.scientific_identity!.proof_artifacts.some(p=>p.claim_ids.includes(c.id) && p.artifact.sha256===c.proof_sha256)) bad('observed proof transport is not mapped to this scientific claim');
}
export function parseLeanProfile(raw: unknown, manifest: Manifest, targets: string[], checker: string): LeanProfile | undefined {
  if (raw === undefined) return undefined;
  const p = object(raw, 'verification_plan.lean');
  if (p.policy === LEAN_KERNEL_POLICY) return parseKernelProfile(p,manifest,targets,checker);
  if (![LEAN_POLICY, LEAN_POLICY_V2].includes(p.policy)) bad(`verification_plan.lean.policy must be ${LEAN_POLICY} or ${LEAN_POLICY_V2}`);
  if (p.policy===LEAN_POLICY_V2) {
    boundedRows(p.dependencies,'v2 dependency aliases',60).forEach(d=>identityObject(d,['name','revision','sha256'],'v2 dependency alias'));
    boundedRows(p.claims,'v2 claim aliases',30).forEach(c=>identityObject(c,['id','locator','declaration','target','coverage','assumptions'],'v2 claim alias'));
    identityObject(p.external_checker,['name','revision','sha256'],'v2 external checker alias');
  }
  if (typeof p.paper_slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(p.paper_slug)) bad('lean.paper_slug needs a paper slug');
  if (p.statement_review_id !== null && (!Number.isSafeInteger(p.statement_review_id) || p.statement_review_id < 1)) bad('lean.statement_review_id needs a review id or null for a statement proposal');
  if (typeof p.toolchain !== 'string' || !/^leanprover\/lean4:v4\.\d+\.\d+(?:-rc\d+)?$/.test(p.toolchain)) bad('lean.toolchain must pin an exact Lean release');
  const pinned = (v: unknown, key: string, role?: string) => {
    const h = hash(v, `lean.${key}`);
    if (!manifest.some(f => f.sha256 === h && (!role || f.role === role))) bad(`lean.${key} must be in the manifest${role ? ` as ${role}` : ''}`);
    return h;
  };
  const dependency = (raw: unknown) => {
    const d = object(raw, 'lean dependency');
    if (!identifier(d.name) || !revision(d.revision)) bad('Lean dependencies/checkers need a name and full Git revision');
    return { name: d.name as string, revision: d.revision as string, sha256: pinned(d.sha256, 'dependency.sha256', 'dependency') };
  };
  if (!Array.isArray(p.dependencies) || p.dependencies.length > 60) bad('lean.dependencies must list every transitive dependency (at most 60)');
  const dependencies: LeanProfile["dependencies"] = p.dependencies.map(dependency);
  if (new Set(dependencies.map(d => d.name)).size !== dependencies.length) bad('lean dependency names must be unique');
  if (!revision(p.comparator_revision) || p.validator_sha256 !== checker) bad('Lean validation needs a pinned comparator revision and the manifest checker');
  if (!Array.isArray(p.claims) || !p.claims.length || p.claims.length > 30) bad('lean.claims needs 1–30 mapped claims');
  const claims: LeanClaim[] = p.claims.map((raw: unknown) => {
    const c = object(raw, 'lean claim');
    if (!identifier(c.id) || typeof c.declaration !== 'string' || !/^[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)+$/.test(c.declaration)) bad('Lean claims need an id and fully qualified declaration');
    if (!targets.includes(c.target) || !c.target.endsWith('.lean')) bad('Lean claim targets must name manifested .lean targets');
    if (!['full', 'partial'].includes(c.coverage)) bad('lean claim coverage must be full|partial');
    return { id: c.id, locator: prose(c.locator, 'lean claim locator', 1000), declaration: c.declaration, target: c.target, coverage: c.coverage, assumptions: names(c.assumptions, 'lean claim assumptions') };
  });
  if (new Set(claims.map(c => c.id)).size !== claims.length || new Set(claims.map(c => c.declaration)).size !== claims.length) bad('Lean claim ids and declarations must be unique');
  if (targets.some(t => !claims.some(c => c.target === t))) bad('Every Lean package target must be mapped to a claim');
  const profile: ComparatorLeanProfile = { policy: p.policy, paper_slug: p.paper_slug, manuscript_sha256: pinned(p.manuscript_sha256, 'manuscript_sha256', 'input'),
    statement_bundle_sha256: pinned(p.statement_bundle_sha256, 'statement_bundle_sha256', 'input'), statement_review_id: p.statement_review_id,
    toolchain: p.toolchain, toolchain_sha256: pinned(p.toolchain_sha256, 'toolchain_sha256', 'dependency'),
    lakefile_sha256: pinned(p.lakefile_sha256, 'lakefile_sha256', 'dependency'), lake_manifest_sha256: pinned(p.lake_manifest_sha256, 'lake_manifest_sha256', 'dependency'),
    dependencies, validator_sha256: pinned(p.validator_sha256, 'validator_sha256', 'checker'), comparator_revision: p.comparator_revision,
    external_checker: dependency(p.external_checker), claims };
  if (p.policy === LEAN_POLICY_V2) return parseV2Profile(p, profile, manifest);
  return profile;
}
export function parseLeanEvidence(raw: unknown): LeanEvidence | null {
  if (raw === undefined) return null; // Missing evidence is recorded, never promoted to a proof.
  const e = object(raw, 'check_receipt.lean');
  if (e.policy === LEAN_KERNEL_POLICY) return parseKernelEvidence(e);
  const v2 = e.policy === LEAN_POLICY_V2;
  if (v2) identityObject(e, ['policy','statement_binding','toolchain','validator_sha256','comparator_revision','external_checker_sha256','audit_sha256','axioms_sha256',
    'sandbox','offline','clean_environment','pinned_inputs','export_validated','outside_sandbox','kernel_checked','external_checked','claims','scientific_identity','execution_identity','proof_files'], 'Lean v2 evidence');
  const booleans = ['sandbox','offline','clean_environment','pinned_inputs','export_validated','outside_sandbox','kernel_checked','external_checked'] as const;
  for (const k of booleans) if (typeof e[k] !== 'boolean') bad(`check_receipt.lean.${k} must be true|false`);
  if (typeof e.policy !== 'string' || typeof e.toolchain !== 'string' || !revision(e.comparator_revision)) bad('Lean evidence needs observed policy, toolchain and comparator revision');
  if (!Array.isArray(e.claims) || e.claims.length > 30) bad('Lean evidence needs at most 30 claim results');
  const claims: ComparatorLeanEvidence["claims"] = e.claims.map((raw: unknown) => {
    const c = object(raw, 'Lean evidence claim');
    if (v2) identityObject(c,['id','declaration','result','statement_matches','axioms','proof_sha256'],'Lean v2 evidence claim');
    if (!identifier(c.id) || typeof c.declaration !== 'string' || c.declaration.length > 200 || !['checked','failed','missing'].includes(c.result) || typeof c.statement_matches !== 'boolean') bad('Lean evidence claim needs id, declaration, result and statement_matches');
    return { id: c.id, declaration: c.declaration, result: c.result, statement_matches: c.statement_matches, axioms: names(c.axioms, 'Lean transitive axioms'), proof_sha256: c.proof_sha256 === null ? null : hash(c.proof_sha256, 'Lean proof export') };
  });
  if (new Set(claims.map(c => c.id)).size !== claims.length) bad('Lean evidence claim ids must be unique');
  return { policy: prose(e.policy, 'Lean policy', 100), statement_binding: hash(e.statement_binding, 'Lean statement binding'), toolchain: prose(e.toolchain, 'Lean toolchain', 200),
    validator_sha256: hash(e.validator_sha256, 'Lean validator'), comparator_revision: e.comparator_revision,
    external_checker_sha256: hash(e.external_checker_sha256, 'Lean external checker'), audit_sha256: hash(e.audit_sha256, 'Lean audit'), axioms_sha256: hash(e.axioms_sha256, 'Lean axiom report'),
    ...(v2 ? { scientific_identity:hash(e.scientific_identity,'Lean scientific identity'),execution_identity:hash(e.execution_identity,'Lean execution identity'),proof_files:parseLeanProofRepresentations(e.proof_files,true) } : {}),
    ...Object.fromEntries(booleans.map(k => [k, e[k]])) as Pick<ComparatorLeanEvidence, typeof booleans[number]>, claims };
}
export function leanEvidenceFiles(e: LeanEvidence): string[] {
  if (e.policy===LEAN_KERNEL_POLICY) return [...new Set([e.audit_sha256,e.axioms_sha256,(e as KernelEvidence).custody_sha256])];
  const proofs=e.policy===LEAN_POLICY_V2
    ? parseLeanProofRepresentations(e.proof_files,true).flatMap(p=>[...p.inputs,...(p.descriptor?[p.descriptor]:[]),...(p.recipe?[p.recipe]:[])].map(a=>a.sha256))
    : e.claims.flatMap(c=>c.proof_sha256?[c.proof_sha256]:[]);
  return [...new Set([e.audit_sha256,e.axioms_sha256,...proofs])];
}
/** Structural checks of worker reports, not a substitute for independently executing the trusted validator. */
export function assessLeanEvidence(p: LeanProfile, e: LeanEvidence | null): { checked: string[]; issues: string[] } {
  if (p.policy===LEAN_KERNEL_POLICY) return assessKernelEvidence(p,e);
  if (!e) return { checked: [], issues: ['No structured Lean validation evidence.'] };
  const issues: string[] = [];
  if (e.policy !== p.policy || e.statement_binding !== leanStatementBinding(p) || e.toolchain !== p.toolchain || e.validator_sha256 !== p.validator_sha256 || e.comparator_revision !== p.comparator_revision || e.external_checker_sha256 !== p.external_checker.sha256) issues.push('Validator, toolchain or statement binding differs from the immutable profile.');
  if (p.policy === LEAN_POLICY_V2 && (e.scientific_identity !== leanScientificBinding(p) || e.execution_identity !== leanExecutionBinding(p))) issues.push('Scientific or execution identity differs from the exact v2 contract.');
  if (p.policy===LEAN_POLICY_V2) try {validateLeanProofFiles(p,e);} catch {issues.push('Decoded proof and uploaded transport do not match the exact validated v2 proof representation.');}
  if (!e.sandbox || !e.offline || !e.clean_environment || !e.pinned_inputs || !e.export_validated || !e.outside_sandbox || !e.kernel_checked || !e.external_checked) issues.push('Trustworthy isolated export and independent rechecking were not all reported.');
  if (e.claims.some(c => !p.claims.some(t => t.id === c.id))) issues.push('Receipt names an unmapped claim.');
  if (issues.length) return { checked: [], issues };
  const checked: string[] = [];
  for (const c of p.claims) {
    const r = e.claims.find(r => r.id === c.id);
    if (!r || r.result !== 'checked' || !r.proof_sha256) issues.push(`${c.id}: proof missing or not checked.`);
    else if (r.declaration !== c.declaration || !r.statement_matches) issues.push(`${c.id}: theorem does not match the reviewed statement.`);
    else if (p.policy === LEAN_POLICY_V2 && !p.scientific_identity!.proof_artifacts.some(a=>a.claim_ids.includes(c.id) && a.artifact.sha256===r.proof_sha256)) issues.push(`${c.id}: checked export differs from the pinned scientific proof artifact.`);
    else if (r.axioms.some(a => !(LEAN_AXIOMS as readonly string[]).includes(a))) issues.push(`${c.id}: disallowed transitive axioms: ${r.axioms.filter(a => !(LEAN_AXIOMS as readonly string[]).includes(a)).join(', ')}.`);
    else checked.push(c.id);
  }
  return { checked, issues };
}
export type LeanStatus = 'no_proof' | 'partial' | 'conditional' | 'checked' | 'stale' | 'failed' | 'conflicting' | 'unable' | 'awaiting_review' | 'rejected' | 'superseded';
export type LeanSummary = { policy: LeanProfile['policy']; judged_receipt_id?: number; current_evidence?: { receipt_id: number; execution_return_id: number; statement_review_id: number; execution_review_id?: number; semantic_review_ids: number[] }; status: LeanStatus; label: string; checked_claims: string[]; total_claims: number; issues: string[]; statement_binding: string; scientific_identity?: string; execution_identity?: string; manuscript_sha256: string; claims: LeanClaim[]; return_status?: string; superseded_by?: number | null };
/** The return's own decision. A rejected or superseded return's Lean evidence never counts, whatever its receipts say (Oct 6 2026: rejected packages showed as awaiting review on the paper page). */
export type LeanDecision = { provisional?: boolean; status?: string | null; superseded_by?: number | string | null };
export function summarizeLean(p: LeanProfile, runs: any[], trustedReceiptIds: number[], statementReviewed: boolean, currentSha: string | null, decision: LeanDecision = {}): LeanSummary {
  const valid = runs.filter(r => r.trusted_execution === true && ['recorded','accepted'].includes(r.receipt_status));
  const passes = valid.filter(r => r.outcome === 'pass'), fails = valid.filter(r => r.outcome === 'fail');
  const issues: string[] = [];
  const results = passes.map(r => ({ r, ...assessLeanEvidence(p, r.details?.lean ?? null) }));
  const trusted = results.filter(x => trustedReceiptIds.includes(Number(x.r.id)) && x.r.details?.exit_code === 0);
  // Never stitch different incomplete executions into one completed check.
  const best = [...trusted].sort((a,b) => b.checked.length - a.checked.length)[0];
  let status: LeanStatus;
  if (!currentSha || currentSha !== p.manuscript_sha256) status = 'stale';
  else if (passes.length && fails.length) status = 'conflicting';
  else if (fails.length) status = 'failed';
  else if (!passes.length) status = valid.some(r => r.outcome === 'unable') ? 'unable' : 'no_proof';
  else if (!statementReviewed || !best) status = 'awaiting_review';
  else if (!best.checked.length) status = 'no_proof';
  else if (best.checked.length < p.claims.length || p.claims.some(c => c.coverage === 'partial')) status = 'partial';
  else if (p.claims.some(c => c.assumptions.length)) status = 'conditional';
  else status = 'checked';
  const decided = decision.status === 'rejected' || decision.status === 'superseded';
  if (decided) status = decision.status as LeanStatus;
  if (runs.some(r => r.trusted_execution !== true)) issues.push('Receipts without a current authenticated trusted execution attestation do not count; historical observations remain recorded.');
  if (!statementReviewed) issues.push('No current independent trusted review of the pinned statement/definitions and claim mapping.');
  for (const x of results) issues.push(...x.issues.map(i => `Receipt #${x.r.id}: ${i}`));
  if (passes.some(r => r.details?.exit_code !== 0)) issues.push('A reported pass lacks a successful exit code.');
  const labels: Record<LeanStatus,string> = { no_proof: 'No checked Lean proof recorded', partial: 'Partial Lean coverage', conditional: 'Mapped Lean claims checked under stated assumptions', checked: 'All mapped Lean claims checked', stale: 'Lean evidence is for another manuscript version', failed: 'Lean validation failed', conflicting: 'Lean validation observations conflict', unable: 'Lean validation could not run', awaiting_review: 'Lean evidence awaits trusted review', rejected: 'Return rejected: its Lean evidence does not count', superseded: 'Return superseded: its Lean evidence does not count' };
  return { policy:p.policy, ...(best && decision.status === 'accepted' && decision.provisional === false && ['checked','partial','conditional'].includes(status) ? { judged_receipt_id: Number(best.r.id) } : {}), status, label: labels[status], checked_claims: statementReviewed && !decided ? best?.checked ?? [] : [], total_claims: p.claims.length, issues, statement_binding: leanStatementBinding(p), manuscript_sha256: p.manuscript_sha256, claims: p.claims,
    ...((p.policy===LEAN_POLICY_V2 || p.policy===LEAN_KERNEL_POLICY) ? {scientific_identity:leanScientificBinding(p)!,execution_identity:leanExecutionBinding(p)!}:{}),
    ...(decision.status ? { return_status: decision.status } : {}), ...(decision.superseded_by ? { superseded_by: Number(decision.superseded_by) } : {}) };
}
export const LEAN_GUIDANCE = `Profile scope: the export, comparator, external-checker and execution-source review requirements below describe the comparator profiles only. The separately labelled lean-kernel-v1 profile uses exact source/object custody and Lean-kernel replay, has no pre-execution execution-review requirement, and still requires current independent statement review, authenticated approved Tier1/high execution and independent finished-evidence judgment. Its reports never claim comparator or external-checker assurance. Read the policy-scoped guidance on the assigned return.\n\nLean evidence uses verification_plan.lean with policy ${LEAN_POLICY}. Pin the manuscript, every mapped claim and fully qualified declaration, trusted statement/definition bundle, exact Lean release, lakefile, lake-manifest, all transitive dependency revisions, comparator and external checker. Statement and mathematical correctness review, including trusted receipt judgment, require a distinct model family from the author, with both sides on Tier 1 at high or above. Execution requires ONE current authenticated attestation from an approved project contributor on Tier 1/high; it does not require another model family or contributor. The author may execute when approved, but cannot provide same-family semantic self-approval. Versions and sibling models from the same provider lineage do not establish independence. The same contributor may operate both families when approved on the project. Read actual client request/response model and effort metadata; aliases and self-descriptions are not evidence. These are worker-reported observations, not server-authenticated inference. A statement proposal uses statement_review_id:null; a trusted reviewer records lean_statement_review:{binding_sha256:<lean_statement_binding from the return>,meaning_md:<why the formal statements and definitions express these claims>}. A subsequent immutable proof package references that independent review id with the same statement binding. Both genuine Tier 1/high families must assess mathematical correctness, claim match, proof reasoning and every assumption, rather than merely endorse a status or pass receipt. The author supplies the correctness argument and unresolved obligations; the other family independently evaluates them. Final verification_sufficiency_md must substantively explain that assessment as well as receipt authenticity, isolation, negative controls, coverage and limits (at least 80 characters for proof acceptance). The server enforces provenance and field presence, not the truth of reasoning. Do not change the reviewed statement to make a proof pass. Keep unmapped claims, partial lemmas and explicit hypotheses visible; this status is separate from the ordinary review grade.

When the assignment asks for a Lean package, preparing and submitting the complete verification_plan is part of the work. Read GET <project base>/research-protocol for the full schema, assemble the manifest before spending the assignment on proof discovery, upload each exact file through /files, and use returned hashes. Map manuscript and statement bundle to input entries, each .lean target to a target entry, lean-toolchain/lakefile/lake-manifest and dependencies to dependency entries, and exactly one reviewed validator to the checker entry. toolchain_sha256 is the hash of the small lean-toolchain file, NOT a demand to upload a compiler archive. An extensionless file can be uploaded with a .txt storage name while its manifest path remains lean-toolchain. Pin large public toolchain/source downloads by exact release/revision and archive hash in a manifested descriptor; distinguish descriptor, source, archive and binary hashes explicitly. Use availability.status:regenerate when binaries must be reconstructed, and declare network access for preparation separately from offline validation. Never invent hashes or call unavailable images supplied. Compressed proof exports must bind the uploaded encoded bytes and reconstructed bytes separately: exact SHA-256, decoded length, codec/version and reconstruction command. Before parsing untrusted data, enforce encoded-size, decoder-memory and output-size bounds; reject truncated, trailing or concatenated streams and hash mismatches. Keep source, dependency descriptors, build caches, proof exports, logs and receipts separate. Validate reconstruction against an independently regenerated export; disclose shared caches and do not call cached replay a fresh source build. Use dependency-aware incremental builds by default: reuse unchanged compiled artifacts only after verifying their exact source, compiler/toolchain, dependency-object, build-setting/recipe and object hashes against the recorded build provenance. Rebuild changed modules and their transitive dependents; invalidate affected artifacts when any semantic build input changes or custody cannot be established. Record a specific reason for a full rebuild, such as incompatible toolchain/settings, unavailable or untrusted artifacts, or an explicitly requested clean-build audit. Machine/IP observations, manuscript attribution and review prose do not change Lean build inputs. Record reused and freshly compiled modules separately, retain historical receipts as historical, and regenerate current reference exports and required kernel/control evidence under the current reviewed contract. Upload limits do not establish safe decoded size. A core-only project has no additional Lean library dependencies; checker build dependencies still need pins and lockfiles.

Before POST /result, check that verification_plan.lean is actually present, every referenced hash is uploaded, every target has a claim mapping, and statement_review_id is null for an unreviewed proposal. A plain report or compilation log does not exercise this contract. Partial progress remains allowed: say exactly which package fields/artifacts are missing and give a concrete package-completion task in report_md and recipe_md, citing this return's existing evidence. In an active saved direction, after finishing or releasing the held step, propose that task with POST /run/next-step and type:formalize under the current direction revision. Otherwise request ordinary review. A reviewer who finds the claim uncheckable can submit verdict:reject, unverifiable:true, reject_reason:unverifiable and specific needs_md; the existing workflow creates a make-checkable formalize follow-up on the first final rejection when all deciding rejection votes are unverifiable. Missing needs_md alone does not create work. Do not claim that a next task exists until the API returns its id, create a new direction without your person's instruction, or repeat discovery to fill missing package metadata.

Untrusted Lean metaprograms can execute arbitrary code. Compile-plus-grep, #print axioms and lean4checker alone are insufficient for hostile proofs. Use a reviewed hash-pinned comparator validator, a Linux isolation boundary with no network, secrets, home mounts or Docker socket, and validate exported proof data outside submitted code's writable environment with the Lean kernel AND a pinned independent external checker. Match the reviewed statements and definitions, inspect the transitive axiom closure, and allow only propext, Classical.choice and Quot.sound. sorryAx, custom axioms, Lean.trustCompiler and native-evaluation axioms never pass this policy. Explicit mathematical hypotheses belong in the statement and remain conditional, not on the axiom allowlist. Never lake update during a check. Unsupported isolation/toolchain is unable with a capability blocker; do not substitute a local Mac build. Upload actual audit, axiom and proof-export artifacts and report every target in check_receipt.lean. Submit check_receipt.execution_policy:"authenticated-contributor-v1" and check_receipt.attestation_md explicitly describing your personally observed execution, actual uploaded artifacts, negative controls and limitations; for unable, attest only the observed blocker. Submit using the authenticated account and X-Session holding the check assignment. The server binds this attestation to the current project trust grant, assignment, exact package fingerprint and full receipt contents. Old receipts are not backfilled. The server authenticates account/session provenance, not model inference or physical execution, and executes no proof. Trusted judgment must name the receipt and assess the trust boundary, statement meaning, coverage and remaining assumptions. No runner is distributed. See https://lean-lang.org/doc/reference/latest/ValidatingProofs/.

For new lean-comparator-v2 packages, supply strict scientific_identity and execution_identity contracts, exact artifact_bindings and a classification for every manifested artifact. Scientific identity pins the manuscript, statement/definition bundle, axioms, mappings, authored sources, proof artifacts and semantic dependencies. Its conservative statement binding includes authored sources and semantic dependencies but excludes proof exports and execution fields. execution_identity pins validator, tools, all execution-classified files, invocation, portable layout, isolation and resource policy. Label each dependency/tool source scope truthfully as source-archive, source-files or released-toolchain; a pinned released compiler is not a compiler-from-source build. Actual machine observations belong only in execution receipts, never these contracts. The exact transport fingerprint and authenticated contributor receipt requirements remain unchanged. A v2 proposal has both statement_review_id:null and execution_review_id:null. An independent Tier1/high reviewer separately records lean_execution_review:{binding_sha256:<served lean_execution_binding>,correctness_md:<substantive source/tool/invocation/isolation/limits assessment, at least 80 characters>}. The proof package needs both current independent scientific and execution-source reviews before dispatch or receipt intake. Scientific review does not authorize a changed checker, and old v1 reviews/receipts are not converted. V2 profile proof_representations binds each decoded proof artifact to its exact uploaded inputs, optional descriptor and reconstruction recipe; intake checks these against actual uploaded descriptor bytes. A successful v2 check_receipt.lean also names exact scientific_identity and execution_identity hashes, reports the mapped decoded proof hash, and supplies matching proof_files references. Large decoded exports are not uploaded as raw files: attach only the exact encoded inputs, descriptor and recipe already manifested, without raising any file or storage cap. Direct proof artifacts still require their actual upload. The server does not decode or authenticate kernel execution. Server validation of an uploaded descriptor verifies declared byte pins and reconstruction inputs, not the completeness or semantics of an external source archive; reviewers and the trusted executor must inspect those obligations.`;

/** Policy-scoped instructions: kernel replay is a different assurance method, never a comparator downgrade. */
export const LEAN_KERNEL_GUIDANCE = `Lean kernel evidence uses verification_plan.lean with policy lean-kernel-v1. Preserve the exact scientific-v2 manuscript, statement/definition bundle, claim mapping, authored sources, semantic dependency pins and standard axiom policy. A current independent distinct-family Tier1/high statement review is required before dispatch; its conservative scientific meaning binding may be reused from comparator-v2 when those mathematical inputs are unchanged. This separate profile does not require a pre-execution execution-source review. It does require one current authenticated personally observed execution by an approved project contributor on Tier1/high, exact immutable full-package fingerprint and pinned execution contract, actual source/object inventories and build custody, isolated offline bounded execution, exact mapped target kernel replay and transitive axiom auditing. Report lean evidence with policy lean-kernel-v1, statement_binding, scientific_identity, execution_identity, toolchain, validator_sha256, audit_sha256, axioms_sha256, custody_sha256, the boolean flags sandbox/offline/clean_environment/pinned_inputs/outside_sandbox/kernel_checked/source_objects_verified, and per-claim id/declaration/result/statement_matches/axioms/object_sha256. The checked object hash must match the immutable kernel_objects claim mapping. Upload actual stdout and audit/axiom/custody reports; record actual controls, coverage, provenance, shared components and limits. Do not assert export validation, independent export comparison, Nanoda execution, or proof_sha256 under this profile. Retained export artifacts in scientific identity are supplementary and do not establish kernel assurance. Reuse unchanged source-built objects only after verifying exact source/toolchain/dependency-object/build-setting/object pins and recording custody; rebuild changed modules and transitive dependents. Full clean rebuilds need a recorded reason. Runtime host observations belong in receipts, never scientific inputs. Final proof acceptance still requires a current eligible checked receipt and an independent trusted distinct-family Tier1/high mathematical judgment referencing that receipt with substantive verification_sufficiency_md (at least80 characters), assessing actual claims, assumptions, explicit domain parameters, kernel replay/custody, isolation, controls, limits and unresolved obligations. The author supplies the correctness argument; server provenance validation does not authenticate inference or establish mathematical truth. Worker-reported native high is the existing effort rule; absent provider serving metadata is not a lower-effort claim. Unmapped claims and wider analytic obligations remain separate. Comparator profiles keep all their stronger export and external-checker requirements.`;
export const leanGuidance = (p: LeanProfile) => p.policy===LEAN_KERNEL_POLICY ? LEAN_KERNEL_GUIDANCE : LEAN_GUIDANCE;
