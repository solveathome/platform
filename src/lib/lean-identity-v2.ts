/** Strict, inert v2 identities. These hashes never grant review or execution authority. */
import { createHash } from 'node:crypto';
import { bad } from './research-format.js';

export const SCIENTIFIC_IDENTITY_V2 = 'solveathome-lean-scientific-v2';
export const EXECUTION_IDENTITY_V2 = 'solveathome-lean-execution-contract-v2';
export const RECEIPT_IDENTITY_V2 = 'solveathome-lean-execution-receipt-v2';
export type IdentityArtifact = { path: string; sha256: string; bytes: number };
type Artifact = IdentityArtifact;

export function identityObject(raw: unknown, keys: string[], field: string): Record<string, any> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) bad(`${field} must be a plain object`);
  const x = raw as Record<string, any>;
  if (Reflect.ownKeys(x).some(k => typeof k !== 'string' || !keys.includes(k)) ||
      keys.some(k => !Object.hasOwn(x, k))) bad(`${field} has unknown or missing fields`);
  if (keys.some(k => !Object.hasOwn(Object.getOwnPropertyDescriptor(x, k)!, 'value'))) bad(`${field} must contain data, not accessors`);
  return x;
}
const exact = identityObject;
function sha(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) bad('identity requires lowercase SHA-256');
  return raw;
}
function name(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,159}$/.test(raw)) bad('invalid identity name');
  return raw;
}
function text(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1000) bad('invalid identity text');
  return raw; // Preserve exact mathematical prose, including meaningful whitespace.
}
function count(raw: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 1 || (raw as number) > max) bad('invalid positive identity bound');
  return raw as number;
}
function list<T>(raw: unknown, parse: (x: unknown) => T, minimum = 1, maximum = 4096): T[] {
  if (!Array.isArray(raw) || raw.length < minimum || raw.length > maximum) bad('invalid identity list');
  if (Reflect.ownKeys(raw).some(k => k !== 'length' && (typeof k !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(k) || Number(k) >= raw.length)) ||
      Array.from({ length: raw.length }, (_, i) => Object.getOwnPropertyDescriptor(raw, String(i))).some(d => !d || !Object.hasOwn(d, 'value'))) bad('identity lists must be dense data without extra fields');
  return raw.map(parse);
}
function unique<T>(rows: T[], key: (x: T) => string): T[] {
  if (new Set(rows.map(key)).size !== rows.length) bad('duplicate identity entry');
  return [...rows].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}
export function parseIdentityArtifact(raw: unknown): Artifact {
  const x = exact(raw, ['path', 'sha256', 'bytes'], 'identity artifact');
  if (typeof x.path !== 'string' || x.path.length > 200 ||
      !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(x.path) ||
      x.path.split('/').some((s: string) => !s || s === '.' || s === '..')) bad('artifact requires a safe relative path');
  return { path: x.path, sha256: sha(x.sha256), bytes: count(x.bytes) };
}
const artifact = parseIdentityArtifact;
const artifacts = (raw: unknown) => unique(list(raw, artifact), a => a.path.toLowerCase());
const names = (raw: unknown, minimum = 0) => unique(list(raw, name, minimum, 100), x => x);
function revision(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-f0-9]{40}$/.test(raw)) bad('identity requires an exact source revision');
  return raw;
}
function sourceKind(raw: unknown): 'source-archive' | 'source-files' | 'released-toolchain' {
  if (!['source-archive','source-files','released-toolchain'].includes(raw as string)) bad('source pin needs an explicit source/archive or trusted released-toolchain scope');
  return raw as 'source-archive' | 'source-files' | 'released-toolchain';
}
function version(raw: unknown, expected: string): void {
  if (raw !== expected) bad('unsupported identity schema');
}
function canonical(x: any): any {
  return Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
}
function digest(domain: string, x: unknown): string {
  return createHash('sha256').update(domain + '\n').update(JSON.stringify(canonical(x))).digest('hex');
}

/** Inventories pin declared complete bytes; completeness and bundle contents still need independent artifact review. */
export function parseScientificIdentityV2(raw: unknown) {
  const x = exact(raw, ['schema', 'paper_slug', 'manuscript', 'statement_bundle', 'axiom_policy',
    'claims', 'source_artifacts', 'proof_artifacts', 'semantic_dependencies'], 'scientific identity');
  version(x.schema, SCIENTIFIC_IDENTITY_V2);
  if (typeof x.paper_slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(x.paper_slug)) bad('invalid scientific paper slug');
  const axiom_policy = names(x.axiom_policy);
  if (JSON.stringify(axiom_policy) !== JSON.stringify(['Classical.choice', 'Quot.sound', 'propext'])) bad('scientific identity requires the standard three-axiom policy');
  const source_artifacts = artifacts(x.source_artifacts);
  const claims = unique(list(x.claims, raw => {
    const c = exact(raw, ['id', 'locator', 'declaration', 'target', 'coverage', 'assumptions'], 'scientific claim');
    if (typeof c.declaration !== 'string' || !/^[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)+$/.test(c.declaration)) bad('claim requires a qualified declaration');
    if (!source_artifacts.some(a => a.path === c.target && a.path.endsWith('.lean'))) bad('claim target missing from source inventory');
    if (!['full', 'partial'].includes(c.coverage)) bad('invalid scientific coverage');
    const assumptions = unique(list(c.assumptions, text, 0, 100), s => s);
    return { id: name(c.id), locator: text(c.locator), declaration: c.declaration as string,
      target: c.target as string, coverage: c.coverage as 'full' | 'partial', assumptions };
  }, 1, 30), c => c.id);
  if (new Set(claims.map(c => c.declaration)).size !== claims.length) bad('duplicate scientific declaration');
  const proof_artifacts = unique(list(x.proof_artifacts, raw => {
    const p = exact(raw, ['artifact', 'claim_ids'], 'scientific proof');
    const claim_ids = names(p.claim_ids, 1);
    if (claim_ids.some(id => !claims.some(c => c.id === id))) bad('proof names an unmapped claim');
    return { artifact: artifact(p.artifact), claim_ids };
  }), p => p.artifact.path.toLowerCase());
  if (claims.some(c => !proof_artifacts.some(p => p.claim_ids.includes(c.id)))) bad('mapped claim missing from proof inventory');
  const semantic_dependencies = unique(list(x.semantic_dependencies, raw => {
    const d = exact(raw, ['name', 'revision', 'source_kind', 'source'], 'semantic source dependency');
    return { name: name(d.name), revision: revision(d.revision), source_kind:sourceKind(d.source_kind), source: artifact(d.source) };
  }, 1, 60), d => d.name);
  const manuscript = artifact(x.manuscript), statement_bundle = artifact(x.statement_bundle);
  // Distinct inventories cannot silently reuse a path for different bytes or categories.
  unique([manuscript, statement_bundle, ...source_artifacts, ...proof_artifacts.map(p => p.artifact),
    ...semantic_dependencies.map(d => d.source)], a => a.path.toLowerCase());
  return { schema: SCIENTIFIC_IDENTITY_V2, paper_slug: x.paper_slug as string, manuscript,
    statement_bundle, axiom_policy, claims, source_artifacts, proof_artifacts, semantic_dependencies };
}
export function scientificIdentityV2(raw: unknown): string {
  return digest(SCIENTIFIC_IDENTITY_V2, parseScientificIdentityV2(raw));
}
/** Conservative meaning scope: authored source bytes remain reviewed; proof exports and execution do not. */
export function scientificMeaningV2(raw: unknown): string {
  const { proof_artifacts, ...meaning } = parseScientificIdentityV2(raw);
  return digest('solveathome-lean-meaning-v2', meaning);
}

export function parseExecutionIdentityV2(raw: unknown) {
  const x = exact(raw, ['schema', 'validator', 'tools', 'invocation', 'package_artifacts', 'runtime_paths', 'isolation', 'resources'], 'execution contract');
  version(x.schema, EXECUTION_IDENTITY_V2);
  const tools = unique(list(x.tools, raw => {
    const t = exact(raw, ['name', 'revision', 'source_kind', 'source_sha256', 'binary_sha256'], 'execution tool');
    const source_kind = sourceKind(t.source_kind);
    return { name: name(t.name), revision: t.revision===null && source_kind==='source-files' ? null : revision(t.revision), source_kind, source_sha256: sha(t.source_sha256), binary_sha256: sha(t.binary_sha256) };
  }, 1, 60), t => t.name);
  const paths = exact(x.runtime_paths, ['package', 'support', 'tools', 'exports', 'scratch', 'lean_prefix'], 'portable runtime paths');
  for (const value of Object.values(paths)) if (typeof value !== 'string' ||
      !/^\/(?:opt|package|support|tools|exports|scratch)(?:\/[A-Za-z0-9_.-]+)*$/.test(value) ||
      value.split('/').some(p => p === '.' || p === '..')) bad('runtime layout requires portable container paths');
  const isolation = exact(x.isolation, ['policy_sha256', 'network', 'unprivileged', 'root_readonly',
    'inputs_readonly', 'compilation_separate', 'no_host_mounts', 'no_secrets', 'capabilities', 'no_new_privileges'], 'isolation policy');
  const capabilities = names(isolation.capabilities);
  if (isolation.network !== 'none' || capabilities.length ||
      ['unprivileged', 'root_readonly', 'inputs_readonly', 'compilation_separate', 'no_host_mounts', 'no_secrets', 'no_new_privileges'].some(k => isolation[k] !== true)) bad('execution contract requires strict isolated validation');
  const resources = exact(x.resources, ['memory_bytes', 'cpu_count', 'pids', 'wall_seconds', 'scratch_bytes', 'log_stream_bytes'], 'execution resources');
  const limits: Record<string, number> = { memory_bytes: 4 * 1024**3, cpu_count: 2, pids: 256,
    wall_seconds: 1200, scratch_bytes: 8 * 1024**3, log_stream_bytes: 8 * 1024**2 };
  for (const key of Object.keys(limits)) count(resources[key], limits[key]);
  return { schema: EXECUTION_IDENTITY_V2, validator: artifact(x.validator), tools,
    invocation: artifact(x.invocation), package_artifacts: artifacts(x.package_artifacts), runtime_paths: { ...paths },
    isolation: { ...isolation, policy_sha256: sha(isolation.policy_sha256), capabilities }, resources: { ...resources } };
}
export function executionIdentityV2(raw: unknown): string {
  return digest(EXECUTION_IDENTITY_V2, parseExecutionIdentityV2(raw));
}

/** Observations are separate immutable data, not science or an authority-granting pass flag. */
export function parseReceiptIdentityV2(raw: unknown) {
  const x = exact(raw, ['schema', 'scientific_identity', 'execution_identity', 'observation'], 'execution receipt identity');
  version(x.schema, RECEIPT_IDENTITY_V2);
  return { schema: RECEIPT_IDENTITY_V2, scientific_identity: sha(x.scientific_identity),
    execution_identity: sha(x.execution_identity), observation: artifact(x.observation) };
}
export function receiptIdentityV2(raw: unknown): string {
  return digest(RECEIPT_IDENTITY_V2, parseReceiptIdentityV2(raw));
}
