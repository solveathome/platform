/** Inert Lean evidence contracts. This module never loads or executes a proof or validator. */
import { createHash } from 'node:crypto';
import { bad, object, prose } from './research-format.js';

export const LEAN_POLICY = 'lean-comparator-v1';
export const LEAN_AXIOMS = ['propext', 'Classical.choice', 'Quot.sound'] as const;
type Manifest = { path: string; sha256: string; role: string }[];
export type LeanClaim = { id: string; locator: string; declaration: string; target: string; coverage: 'full' | 'partial'; assumptions: string[] };
export type LeanProfile = {
  policy: typeof LEAN_POLICY; paper_slug: string; manuscript_sha256: string;
  statement_bundle_sha256: string; statement_review_id: number | null;
  toolchain: string; toolchain_sha256: string; lakefile_sha256: string; lake_manifest_sha256: string;
  dependencies: { name: string; revision: string; sha256: string }[];
  validator_sha256: string; comparator_revision: string;
  external_checker: { name: string; revision: string; sha256: string };
  claims: LeanClaim[];
};
export type LeanEvidence = {
  policy: string; statement_binding: string; toolchain: string; validator_sha256: string;
  comparator_revision: string; external_checker_sha256: string;
  audit_sha256: string; axioms_sha256: string;
  sandbox: boolean; offline: boolean; clean_environment: boolean; pinned_inputs: boolean;
  export_validated: boolean; outside_sandbox: boolean; kernel_checked: boolean; external_checked: boolean;
  claims: { id: string; declaration: string; result: 'checked' | 'failed' | 'missing'; statement_matches: boolean; axioms: string[]; proof_sha256: string | null }[];
};
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
  const { statement_review_id, ...binding } = profile;
  return createHash('sha256').update('solveathome-lean-statement-v1\n').update(JSON.stringify(canonical(binding))).digest('hex');
}
export function parseLeanProfile(raw: unknown, manifest: Manifest, targets: string[], checker: string): LeanProfile | undefined {
  if (raw === undefined) return undefined;
  const p = object(raw, 'verification_plan.lean');
  if (p.policy !== LEAN_POLICY) bad(`verification_plan.lean.policy must be ${LEAN_POLICY}`);
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
  return { policy: LEAN_POLICY, paper_slug: p.paper_slug, manuscript_sha256: pinned(p.manuscript_sha256, 'manuscript_sha256', 'input'),
    statement_bundle_sha256: pinned(p.statement_bundle_sha256, 'statement_bundle_sha256', 'input'), statement_review_id: p.statement_review_id,
    toolchain: p.toolchain, toolchain_sha256: pinned(p.toolchain_sha256, 'toolchain_sha256', 'dependency'),
    lakefile_sha256: pinned(p.lakefile_sha256, 'lakefile_sha256', 'dependency'), lake_manifest_sha256: pinned(p.lake_manifest_sha256, 'lake_manifest_sha256', 'dependency'),
    dependencies, validator_sha256: pinned(p.validator_sha256, 'validator_sha256', 'checker'), comparator_revision: p.comparator_revision,
    external_checker: dependency(p.external_checker), claims };
}
export function parseLeanEvidence(raw: unknown): LeanEvidence | null {
  if (raw === undefined) return null; // Missing evidence is recorded, never promoted to a proof.
  const e = object(raw, 'check_receipt.lean');
  const booleans = ['sandbox','offline','clean_environment','pinned_inputs','export_validated','outside_sandbox','kernel_checked','external_checked'] as const;
  for (const k of booleans) if (typeof e[k] !== 'boolean') bad(`check_receipt.lean.${k} must be true|false`);
  if (typeof e.policy !== 'string' || typeof e.toolchain !== 'string' || !revision(e.comparator_revision)) bad('Lean evidence needs observed policy, toolchain and comparator revision');
  if (!Array.isArray(e.claims) || e.claims.length > 30) bad('Lean evidence needs at most 30 claim results');
  const claims: LeanEvidence["claims"] = e.claims.map((raw: unknown) => {
    const c = object(raw, 'Lean evidence claim');
    if (!identifier(c.id) || typeof c.declaration !== 'string' || c.declaration.length > 200 || !['checked','failed','missing'].includes(c.result) || typeof c.statement_matches !== 'boolean') bad('Lean evidence claim needs id, declaration, result and statement_matches');
    return { id: c.id, declaration: c.declaration, result: c.result, statement_matches: c.statement_matches, axioms: names(c.axioms, 'Lean transitive axioms'), proof_sha256: c.proof_sha256 === null ? null : hash(c.proof_sha256, 'Lean proof export') };
  });
  if (new Set(claims.map(c => c.id)).size !== claims.length) bad('Lean evidence claim ids must be unique');
  return { policy: prose(e.policy, 'Lean policy', 100), statement_binding: hash(e.statement_binding, 'Lean statement binding'), toolchain: prose(e.toolchain, 'Lean toolchain', 200),
    validator_sha256: hash(e.validator_sha256, 'Lean validator'), comparator_revision: e.comparator_revision,
    external_checker_sha256: hash(e.external_checker_sha256, 'Lean external checker'), audit_sha256: hash(e.audit_sha256, 'Lean audit'), axioms_sha256: hash(e.axioms_sha256, 'Lean axiom report'),
    ...Object.fromEntries(booleans.map(k => [k, e[k]])) as Pick<LeanEvidence, typeof booleans[number]>, claims };
}
export function leanEvidenceFiles(e: LeanEvidence): string[] { return [...new Set([e.audit_sha256, e.axioms_sha256, ...e.claims.flatMap(c => c.proof_sha256 ? [c.proof_sha256] : [])])]; }
/** Structural checks of worker reports, not a substitute for independently executing the trusted validator. */
export function assessLeanEvidence(p: LeanProfile, e: LeanEvidence | null): { checked: string[]; issues: string[] } {
  if (!e) return { checked: [], issues: ['No structured Lean validation evidence.'] };
  const issues: string[] = [];
  if (e.policy !== p.policy || e.statement_binding !== leanStatementBinding(p) || e.toolchain !== p.toolchain || e.validator_sha256 !== p.validator_sha256 || e.comparator_revision !== p.comparator_revision || e.external_checker_sha256 !== p.external_checker.sha256) issues.push('Validator, toolchain or statement binding differs from the immutable profile.');
  if (!e.sandbox || !e.offline || !e.clean_environment || !e.pinned_inputs || !e.export_validated || !e.outside_sandbox || !e.kernel_checked || !e.external_checked) issues.push('Trustworthy isolated export and independent rechecking were not all reported.');
  if (e.claims.some(c => !p.claims.some(t => t.id === c.id))) issues.push('Receipt names an unmapped claim.');
  if (issues.length) return { checked: [], issues };
  const checked: string[] = [];
  for (const c of p.claims) {
    const r = e.claims.find(r => r.id === c.id);
    if (!r || r.result !== 'checked' || !r.proof_sha256) issues.push(`${c.id}: proof missing or not checked.`);
    else if (r.declaration !== c.declaration || !r.statement_matches) issues.push(`${c.id}: theorem does not match the reviewed statement.`);
    else if (r.axioms.some(a => !(LEAN_AXIOMS as readonly string[]).includes(a))) issues.push(`${c.id}: disallowed transitive axioms: ${r.axioms.filter(a => !(LEAN_AXIOMS as readonly string[]).includes(a)).join(', ')}.`);
    else checked.push(c.id);
  }
  return { checked, issues };
}
export type LeanStatus = 'no_proof' | 'partial' | 'conditional' | 'checked' | 'stale' | 'failed' | 'conflicting' | 'unable' | 'awaiting_review' | 'rejected' | 'superseded';
export type LeanSummary = { status: LeanStatus; label: string; checked_claims: string[]; total_claims: number; issues: string[]; statement_binding: string; manuscript_sha256: string; claims: LeanClaim[]; return_status?: string; superseded_by?: number | null };
/** The return's own decision. A rejected or superseded return's Lean evidence never counts, whatever its receipts say (Oct 6 2026: rejected packages showed as awaiting review on the paper page). */
export type LeanDecision = { status?: string | null; superseded_by?: number | string | null };
export function summarizeLean(p: LeanProfile, runs: any[], trustedReceiptIds: number[], statementReviewed: boolean, currentSha: string | null, decision: LeanDecision = {}): LeanSummary {
  const valid = runs.filter(r => r.independent && ['recorded','accepted'].includes(r.receipt_status));
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
  if (!statementReviewed) issues.push('No current independent trusted review of the pinned statement/definitions and claim mapping.');
  for (const x of results) issues.push(...x.issues.map(i => `Receipt #${x.r.id}: ${i}`));
  if (passes.some(r => r.details?.exit_code !== 0)) issues.push('A reported pass lacks a successful exit code.');
  const labels: Record<LeanStatus,string> = { no_proof: 'No checked Lean proof recorded', partial: 'Partial Lean coverage', conditional: 'Mapped Lean claims checked under stated assumptions', checked: 'All mapped Lean claims checked', stale: 'Lean evidence is for another manuscript version', failed: 'Lean validation failed', conflicting: 'Lean validation observations conflict', unable: 'Lean validation could not run', awaiting_review: 'Lean evidence awaits trusted review', rejected: 'Return rejected: its Lean evidence does not count', superseded: 'Return superseded: its Lean evidence does not count' };
  return { status, label: labels[status], checked_claims: statementReviewed && !decided ? best?.checked ?? [] : [], total_claims: p.claims.length, issues, statement_binding: leanStatementBinding(p), manuscript_sha256: p.manuscript_sha256, claims: p.claims,
    ...(decision.status ? { return_status: decision.status } : {}), ...(decision.superseded_by ? { superseded_by: Number(decision.superseded_by) } : {}) };
}
export const LEAN_GUIDANCE = `Lean evidence uses verification_plan.lean with policy ${LEAN_POLICY}. Pin the manuscript, every mapped claim and fully qualified declaration, trusted statement/definition bundle, exact Lean release, lakefile, lake-manifest, all transitive dependency revisions, comparator and external checker. Statement review, proof replay and trusted receipt judgment require a distinct model family from the author, with both sides on Tier 1 at high or above. Versions and sibling models from the same provider lineage do not establish independence. The same contributor may operate both families when approved on the project. Read actual client request/response model and effort metadata; aliases and self-descriptions are not evidence. These are worker-reported observations, not server-authenticated inference. A statement proposal uses statement_review_id:null; a trusted reviewer records lean_statement_review:{binding_sha256:<lean_statement_binding from the return>,meaning_md:<why the formal statements and definitions express these claims>}. A subsequent immutable proof package references that independent review id with the same statement binding. Do not change the reviewed statement to make a proof pass. Keep unmapped claims, partial lemmas and explicit hypotheses visible; this status is separate from the ordinary review grade.

When the assignment asks for a Lean package, preparing and submitting the complete verification_plan is part of the work. Read GET <project base>/research-protocol for the full schema, assemble the manifest before spending the assignment on proof discovery, upload each exact file through /files, and use returned hashes. Map manuscript and statement bundle to input entries, each .lean target to a target entry, lean-toolchain/lakefile/lake-manifest and dependencies to dependency entries, and exactly one reviewed validator to the checker entry. toolchain_sha256 is the hash of the small lean-toolchain file, NOT a demand to upload a compiler archive. An extensionless file can be uploaded with a .txt storage name while its manifest path remains lean-toolchain. Pin large public toolchain/source downloads by exact release/revision and archive hash in a manifested descriptor; distinguish descriptor, source, archive and binary hashes explicitly. Use availability.status:regenerate when binaries must be reconstructed, and declare network access for preparation separately from offline validation. Never invent hashes or call unavailable images supplied. Compressed proof exports must bind the uploaded encoded bytes and reconstructed bytes separately: exact SHA-256, decoded length, codec/version and reconstruction command. Before parsing untrusted data, enforce encoded-size, decoder-memory and output-size bounds; reject truncated, trailing or concatenated streams and hash mismatches. Keep source, dependency descriptors, build caches, proof exports, logs and receipts separate. Validate reconstruction against an independently regenerated export; disclose shared caches and do not call cached replay a fresh source build. Upload limits do not establish safe decoded size. A core-only project has no additional Lean library dependencies; checker build dependencies still need pins and lockfiles.

Before POST /result, check that verification_plan.lean is actually present, every referenced hash is uploaded, every target has a claim mapping, and statement_review_id is null for an unreviewed proposal. A plain report or compilation log does not exercise this contract. Partial progress remains allowed: say exactly which package fields/artifacts are missing and give a concrete package-completion task in report_md and recipe_md, citing this return's existing evidence. In an active saved direction, after finishing or releasing the held step, propose that task with POST /run/next-step and type:formalize under the current direction revision. Otherwise request ordinary review. A reviewer who finds the claim uncheckable can submit verdict:reject, unverifiable:true, reject_reason:unverifiable and specific needs_md; the existing workflow creates a make-checkable formalize follow-up on the first final rejection when all deciding rejection votes are unverifiable. Missing needs_md alone does not create work. Do not claim that a next task exists until the API returns its id, create a new direction without your person's instruction, or repeat discovery to fill missing package metadata.

Untrusted Lean metaprograms can execute arbitrary code. Compile-plus-grep, #print axioms and lean4checker alone are insufficient for hostile proofs. Use a reviewed hash-pinned comparator validator, a Linux isolation boundary with no network, secrets, home mounts or Docker socket, and validate exported proof data outside submitted code's writable environment with the Lean kernel AND a pinned independent external checker. Match the reviewed statements and definitions, inspect the transitive axiom closure, and allow only propext, Classical.choice and Quot.sound. sorryAx, custom axioms, Lean.trustCompiler and native-evaluation axioms never pass this policy. Explicit mathematical hypotheses belong in the statement and remain conditional, not on the axiom allowlist. Never lake update during a check. Unsupported isolation/toolchain is unable with a capability blocker; do not substitute a local Mac build. Upload actual audit, axiom and proof-export artifacts and report every target in check_receipt.lean. The server records worker observations; it executes no proof and authenticates no claimed execution. Trusted judgment must name the receipt and assess the trust boundary, statement meaning, coverage and remaining assumptions. No runner is distributed. See https://lean-lang.org/doc/reference/latest/ValidatingProofs/.`;
