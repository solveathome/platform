/** Immutable check packages and independent execution receipts. No submitted code runs here. */
import { createHash } from 'node:crypto';
import { one, q } from '../db/index.js';
import { amount, bad, object, prose, tags } from './research-format.js';

export type VerificationPlan = {
  schema_version: 1; manifest: { path: string; sha256: string; role: string }[]; targets: string[];
  claim: string; scope: string; assumptions: string; checker: string; inputs: string[];
  environment: string; command: string; expected: string; supports: string; coverage: 'decisive' | 'sample';
  coverage_md: string; comparison: string; availability: { status: 'complete' | 'incomplete' | 'regenerate' | 'restricted'; details: string; required_sources: string[]; network: boolean };
  cost: { minutes: number; judgment_minutes?: number; cpu_hours: number; ram_gb: number; disk_gb: number };
};
const sha = (s: any) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
export function parseVerificationPlan(raw: unknown): VerificationPlan | null {
  if (raw === undefined) return null;
  const p = object(raw, 'verification_plan'), c = object(p.cost, 'verification_plan.cost');
  if (p.schema_version !== 1) bad('verification_plan.schema_version must be 1');
  if (!Array.isArray(p.manifest) || !p.manifest.length || p.manifest.length > 64) bad('verification_plan.manifest needs 1–64 pinned files');
  const manifest = p.manifest.map((raw: any) => {
    const f = object(raw, 'manifest file');
    if (typeof f.path !== 'string' || f.path.length > 200 || !/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(f.path) || f.path.split('/').some((part: string) => !part || part === '.' || part === '..') || !sha(f.sha256)) bad('manifest files need safe relative paths and lowercase sha256 hashes');
    if (!['checker', 'input', 'dependency', 'target', 'certificate'].includes(f.role)) bad('manifest file role must be checker|input|dependency|target|certificate');
    return { path: f.path, sha256: f.sha256, role: f.role };
  });
  if (new Set(manifest.map((f: any) => f.path.toLowerCase())).size !== manifest.length) bad('manifest paths must be unique, including on case-insensitive machines');
  if (!Array.isArray(p.targets) || !p.targets.length || p.targets.length > 30 || p.targets.some((path: any) => !manifest.some((f: any) => f.path === path && ['target', 'certificate'].includes(f.role)))) bad('targets must name target or certificate paths in the manifest');
  const availability = object(p.availability, 'verification_plan.availability');
  if (!['complete', 'incomplete', 'regenerate', 'restricted'].includes(availability.status) || typeof availability.network !== 'boolean') bad('availability needs a status and explicit network boolean');
  if (!Array.isArray(availability.required_sources) || availability.required_sources.length > 20 || availability.required_sources.some((s: any) => typeof s !== 'string' || !/^[a-z0-9][a-z0-9_.:+/-]{0,79}$/.test(s))) bad('availability.required_sources needs up to 20 source identifiers');
  if (!sha(p.checker) || !Array.isArray(p.inputs) || p.inputs.length > 30 || p.inputs.some((x: any) => !sha(x))) bad('verification_plan needs a checker sha256 and at most 30 input sha256s');
  if (!['decisive', 'sample'].includes(p.coverage)) bad('verification_plan.coverage must be decisive|sample');
  if (manifest.filter((f: any) => f.role === 'checker').length !== 1 || !manifest.some((f: any) => f.role === 'checker' && f.sha256 === p.checker) || p.inputs.some((s: string) => !manifest.some((f: any) => f.sha256 === s))) bad('checker and inputs must be included in the manifest, with exactly one checker');
  // Expected output is data: preserve whitespace needed for exact comparison and fingerprinting.
  prose(p.expected, 'verification_plan.expected', 8000);
  return { schema_version: 1, manifest, targets: [...new Set(p.targets)] as string[], coverage_md: prose(p.coverage_md, 'verification_plan.coverage_md'), comparison: prose(p.comparison, 'verification_plan.comparison'),
    availability: { status: availability.status, details: prose(availability.details, 'availability.details'), required_sources: availability.required_sources, network: availability.network },
    claim: prose(p.claim, 'verification_plan.claim'), scope: prose(p.scope, 'verification_plan.scope'), assumptions: prose(p.assumptions, 'verification_plan.assumptions'),
    checker: p.checker, inputs: [...new Set(p.inputs)] as string[], environment: prose(p.environment, 'verification_plan.environment'), command: prose(p.command, 'verification_plan.command'),
    expected: p.expected, supports: prose(p.supports, 'verification_plan.supports'), coverage: p.coverage,
    cost: { minutes: amount(c.minutes, 'cost.minutes', 0.01, 240), judgment_minutes: amount(c.judgment_minutes ?? 15, 'cost.judgment_minutes', 6, 240), cpu_hours: amount(c.cpu_hours, 'cost.cpu_hours', 0, 32), ram_gb: amount(c.ram_gb, 'cost.ram_gb', 0, 32), disk_gb: amount(c.disk_gb ?? 1, 'cost.disk_gb', 0, 10) } };
}
type CheckBlocker = { kind: 'capability' | 'package'; required_tools: string[]; required_sources: string[] };
export function parseCheckBlocker(raw: unknown): CheckBlocker | null {
  if (raw === undefined) return null; // Older unable receipts remain honest unknowns, not executions.
  const b = object(raw, 'check_receipt.blocker');
  if (!['capability', 'package'].includes(b.kind)) bad('check_receipt.blocker.kind must be capability|package');
  const required_tools = tags(b.required_tools ?? [], 'blocker.required_tools'), required_sources = tags(b.required_sources ?? [], 'blocker.required_sources');
  if (b.kind === 'capability' && !required_tools.length && !required_sources.length) bad('a capability blocker must name the missing tools or sources needed by another worker');
  return { kind: b.kind, required_tools, required_sources };
}
export function isCompletedCheck(run: any): boolean {
  return run.independent && ['recorded', 'accepted'].includes(run.receipt_status) && ['pass', 'fail'].includes(run.outcome);
}
function canonical(x: any): any { return Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x; }
export function fingerprint(plan: VerificationPlan): string {
  // Cost estimates do not change the scientific check; every semantic/executable field does.
  const { cost, ...check } = plan;
  return createHash('sha256').update('solveathome-verification-v1\n').update(JSON.stringify(canonical(check))).digest('hex');
}
export async function saveVerificationPlan(returnId: number, plan: VerificationPlan): Promise<void> {
  for (const file of new Set(plan.manifest.map(f => f.sha256))) {
    if (!(await one(`SELECT 1 FROM files WHERE sha256=$1 AND deleted_at IS NULL`, [file]))) bad(`verification artifact ${file} is not available; upload it first`);
    await q(`INSERT INTO file_refs (file_sha,ref_type,ref_id) VALUES ($1,'return',$2) ON CONFLICT DO NOTHING`, [file, returnId]);
  }
  await q(`UPDATE returns SET verification_plan=$2,verification_fingerprint=$3 WHERE id=$1`, [returnId, JSON.stringify(plan), fingerprint(plan)]);
}
export async function verificationRuns(returnId: number): Promise<any[]> {
  return q(`SELECT v.id,v.subject_return_id,v.result_return_id,v.fingerprint,v.outcome,v.observed,v.elapsed_seconds,v.details,v.created_at,
    u.handle,r.model,r.status AS receipt_status, (r.user_id<>subject.user_id AND r.model<>subject.model) AS independent,
    (v.subject_return_id<>subject.id) AS reused
    FROM returns subject JOIN verification_runs v ON v.fingerprint=subject.verification_fingerprint
    JOIN returns r ON r.id=v.result_return_id AND r.problem_id=subject.problem_id JOIN users u ON u.id=r.user_id
    WHERE subject.id=$1 ORDER BY v.id DESC`, [returnId]);
}
export async function verificationState(returnId: number): Promise<any> {
  const runs = await verificationRuns(returnId);
  const valid = runs.filter(r => r.independent && ['recorded', 'accepted'].includes(r.receipt_status));
  const latest = valid.reduce((latest, r) => Math.max(latest, Number(r.id)), 0);
  const conflict = valid.some(r => r.outcome === 'pass') && valid.some(r => r.outcome === 'fail');
  const resolution = await one(`SELECT rv.id,rv.verification_conflict_resolution_md,rv.verification_conflict_through FROM reviews rv JOIN returns r ON r.id=rv.return_id JOIN returns subject ON subject.id=$1 AND subject.problem_id=r.problem_id AND subject.verification_fingerprint=r.verification_fingerprint WHERE rv.trusted AND NOT rv.needs_reassessment AND rv.verification_conflict_through >= $2 ORDER BY rv.id DESC LIMIT 1`, [returnId, latest]);
  return { execution: conflict ? 'conflicting' : valid.some(r => r.outcome === 'fail') ? 'fail' : valid.some(r => r.outcome === 'pass') ? 'pass' : valid.length ? 'unable' : 'not_attempted', conflict, unresolved_conflict: conflict && !resolution, latest_receipt_id: latest, receipt_count: runs.length, resolution: resolution ?? null };
}
export async function queueCheck(ret: any): Promise<boolean> {
  if (!ret.verification_plan) return false;
  const runs = (await verificationRuns(Number(ret.id))).filter(r => ['recorded', 'accepted'].includes(r.receipt_status));
  // Failure/conflict also goes to judgment; do not quietly rerun until a pass appears.
  if (runs.some(isCompletedCheck)) return false;
  if (await checkWaitExpired(Number(ret.id))) return false;
  if (await one(`SELECT 1 FROM jobs j JOIN returns r ON r.id=j.evidence_return_id WHERE r.problem_id=$1 AND r.verification_fingerprint=$2 AND j.type='check' AND j.status IN ('queued','assigned')`, [ret.problem_id, ret.verification_fingerprint])) {
    await q(`UPDATE returns SET review_admitted_at=coalesce(review_admitted_at,now()) WHERE id=$1`, [ret.id]);
    return true;
  }
  const unable = runs.filter(r => r.outcome === 'unable');
  // One targeted reassignment for a declared worker capability gap. Package defects,
  // unknown causes or two unable observations go to judgment with the missing execution visible.
  if (unable.length && (unable.length >= 2 || unable.some(r => r.details?.blocker?.kind !== 'capability'))) return false;
  const plan: VerificationPlan = ret.verification_plan;
  const requiredTools = [...new Set(unable.flatMap(r => r.details.blocker.required_tools))];
  const requiredSources = [...new Set([...plan.availability.required_sources, ...unable.flatMap(r => r.details.blocker.required_sources)])];
  await q(`INSERT INTO jobs (problem_id,lane_id,type,title,brief_md,budget_hours,min_tier,compute_hint,evidence_return_id,research_stage,origin_key)
    VALUES ($1,$2,'check',$3,$4,$5,99,$6,$7,'consolidate',$8)`,
    [ret.problem_id, ret.lane_id, `Check evidence for return #${ret.id}`,
      `Reconstruct the immutable package from GET <project base>/return/${ret.id} in a clean directory using ONLY its manifest and declared runtime/source requirements. Fetch each file by SHA from /files/<sha> to its relative manifest path. Inspect the checker before executing it within your person's limits. The checker must consume the submitted target, not only regenerate an unrelated expected answer. Check actual coverage and the comparison rule. For a new checker, try a corrupted target or missing record and record whether it detects the defect. Preserve the original files and results; modifications for controls belong in a separate temporary copy. Do not redo discovery. Return report_md, transcript, and check_receipt: {fingerprint: "${ret.verification_fingerprint}", outcome: "pass|fail|unable", observed: "actual output and differences", elapsed_seconds: <actual time>, stdout_sha256: "<uploaded actual output>", exit_code: <integer or null if unable>, environment: "observed versions", coverage_md: "exactly what ran, exclusions and seeds", method: "rerun|independent_implementation", shared_components_md: "shared algorithm, code, parser or library", controls_md: "negative controls and their observed outcomes"}. If execution cannot proceed, use outcome unable and blocker: {kind: "capability|package", required_tools: [], required_sources: []}. Use capability only when another worker with the named tools or source access can run the unchanged package; include at least one missing capability identifier. Use package for missing artifacts, undeclared dependencies or defects requiring repair, and describe the defect in observed. A capability gap permits one targeted reassignment; package defects and unresolved second attempts go to judgment. A repair requires a new package. Execution receipts remain worker-reported evidence at their stated coverage, not mathematical verdicts.`,
      Math.min(4, Math.max(0.1, plan.cost.minutes / 60 + 0.1)), JSON.stringify(plan.cost), ret.id, `check:${ret.id}:${ret.verification_fingerprint}:${unable.length + 1}`]);
  await q(`UPDATE jobs SET required_tools=$2,required_sources=$3 WHERE evidence_return_id=$1 AND type='check' AND status='queued'`, [ret.id, requiredTools, requiredSources]);
  await q(`UPDATE returns SET review_admitted_at=coalesce(review_admitted_at,now()) WHERE id=$1`, [ret.id]);
  return true;
}
export async function checkWaitExpired(returnId: number): Promise<boolean> {
  return !!await one(`SELECT 1 FROM returns r JOIN returns subject ON subject.id=$1
    AND r.problem_id=subject.problem_id AND r.verification_fingerprint=subject.verification_fingerprint
    JOIN jobs j ON j.evidence_return_id=r.id WHERE j.check_wait_expired_at IS NOT NULL`, [returnId]);
}
/** Scheduling only: an unclaimed check eventually needs an agent to assess the missing capacity. */
export async function expireWaitingChecks(problemId: number): Promise<any[]> {
  const expired = await q(`UPDATE jobs SET status='expired',check_wait_expired_at=now()
    WHERE problem_id=$1 AND type='check' AND status='queued' AND created_at < now()-interval '24 hours'
    RETURNING evidence_return_id`, [problemId]);
  if (!expired.length) return [];
  return q(`SELECT DISTINCT r.* FROM returns r JOIN returns source ON source.id=ANY($1::bigint[])
    AND r.problem_id=source.problem_id AND r.verification_fingerprint=source.verification_fingerprint
    WHERE r.status='pending' AND r.duplicate_of IS NULL`, [expired.map(j => j.evidence_return_id)]);
}
/** Only byte-identical contributions fold automatically; semantic novelty stays with agents. */
export async function identicalClaim(ret: any): Promise<any> {
  if (!ret.verification_fingerprint) return null;
  return one(`SELECT prior.* FROM returns prior WHERE prior.problem_id=$1 AND prior.id<>$2
    AND prior.verification_fingerprint=$3 AND prior.duplicate_of IS NULL AND NOT prior.provisional
    AND prior.status IN ('pending','accepted','rejected')
    AND prior.type=$4 AND prior.report_md=$5
    AND prior.patch IS NOT DISTINCT FROM $6 AND prior.revision_sha IS NOT DISTINCT FROM $7
    AND prior.revision_path IS NOT DISTINCT FROM $8 AND prior.target IS NOT DISTINCT FROM $9::jsonb
    AND prior.finding IS NOT DISTINCT FROM $10 AND prior.paper_slug IS NOT DISTINCT FROM $11
    AND prior.author_rung IS NOT DISTINCT FROM $12
    AND (prior.research->>'evidence_md') IS NOT DISTINCT FROM $13
    AND (SELECT array_agg(file_sha ORDER BY file_sha) FROM file_refs WHERE ref_type='return' AND ref_id=prior.id)
      IS NOT DISTINCT FROM (SELECT array_agg(file_sha ORDER BY file_sha) FROM file_refs WHERE ref_type='return' AND ref_id=$2)
    AND (SELECT array_agg(depends_on_id ORDER BY depends_on_id) FROM return_dependencies WHERE return_id=prior.id)
      IS NOT DISTINCT FROM (SELECT array_agg(depends_on_id ORDER BY depends_on_id) FROM return_dependencies WHERE return_id=$2)
    ORDER BY prior.id LIMIT 1`, [ret.problem_id,ret.id,ret.verification_fingerprint,ret.type,ret.report_md,
      ret.patch,ret.revision_sha,ret.revision_path,ret.target ? JSON.stringify(ret.target) : null,
      ret.finding,ret.paper_slug,ret.author_rung,ret.research?.evidence_md ?? null]);
}
export async function saveCheckReceipt(ret: any, job: any, raw: any): Promise<number> {
  const x = object(raw, 'check_receipt');
  const subject = await one(`SELECT * FROM returns WHERE id=$1 AND problem_id=$2`, [job.evidence_return_id, ret.problem_id]);
  if (!subject || !subject.verification_fingerprint || x.fingerprint !== subject.verification_fingerprint) bad('check_receipt fingerprint does not match the assigned immutable package');
  if (String(subject.user_id) === String(ret.user_id) || subject.model === ret.model) bad('a check requires a different contributor and model from the author');
  if (!['pass', 'fail', 'unable'].includes(x.outcome)) bad('check_receipt.outcome must be pass|fail|unable');
  if (x.blocker !== undefined && x.outcome !== 'unable') bad('check_receipt.blocker belongs only on an unable receipt');
  const blocker = parseCheckBlocker(x.blocker);
  if (!['rerun', 'independent_implementation'].includes(x.method)) bad('check_receipt.method must be rerun|independent_implementation');
  if (x.exit_code !== null && (!Number.isInteger(x.exit_code) || x.exit_code < 0 || x.exit_code > 255)) bad('check_receipt.exit_code must be 0–255 or null');
  if (x.outcome !== 'unable' && (!sha(x.stdout_sha256) || x.exit_code === null)) bad('completed checks need stdout_sha256 and exit_code');
  if (x.stdout_sha256 !== undefined) {
    if (!sha(x.stdout_sha256) || !(await one(`SELECT 1 FROM files WHERE sha256=$1 AND deleted_at IS NULL`, [x.stdout_sha256]))) bad('upload actual stdout before submitting the receipt');
    await q(`INSERT INTO file_refs (file_sha,ref_type,ref_id) VALUES ($1,'return',$2) ON CONFLICT DO NOTHING`, [x.stdout_sha256, ret.id]);
  }
  const details = { stdout_sha256: x.stdout_sha256 ?? null, exit_code: x.exit_code, environment: prose(x.environment, 'check_receipt.environment'), coverage_md: prose(x.coverage_md, 'check_receipt.coverage_md'), method: x.method, shared_components_md: prose(x.shared_components_md, 'check_receipt.shared_components_md'), controls_md: prose(x.controls_md, 'check_receipt.controls_md'), expected_visible: true, blocker };
  await q(`INSERT INTO verification_runs (subject_return_id,result_return_id,fingerprint,outcome,observed,elapsed_seconds,details) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [subject.id, ret.id, x.fingerprint, x.outcome, prose(x.observed, 'check_receipt.observed', 12000), amount(x.elapsed_seconds, 'check_receipt.elapsed_seconds', 0, 86400), JSON.stringify(details)]);
  const state = await verificationState(Number(subject.id));
  if (state.unresolved_conflict && !(await one(`SELECT 1 FROM jobs WHERE problem_id=$1 AND origin_key LIKE $2 AND status IN ('queued','assigned')`, [ret.problem_id, `check-conflict:${x.fingerprint}:%`]))) {
    await q(`INSERT INTO jobs (problem_id,lane_id,type,title,brief_md,budget_hours,min_tier,research_stage,evidence_return_id,origin_key) VALUES ($1,$2,'explore',$3,$4,0.5,1,'consolidate',$5,$6)`,
      [ret.problem_id, subject.lane_id, `Resolve conflicting checks for return #${subject.id}`, `Read the package and ALL receipts at GET <project base>/return/${subject.id}. Isolate the smallest cause of contradictory observations: environment, coverage, missing input, comparison rule or checker defect. Preserve each receipt. Return a bounded investigation with the decisive evidence and cite the affected returns. A trusted reviewer must explicitly reconcile the conflict before accepting the package.`, subject.id, `check-conflict:${x.fingerprint}:${state.latest_receipt_id}`]);
  }
  return Number(subject.id);
}
export function judgmentBudget(plan?: VerificationPlan | null): number {
  // Assessing a receipt or a mathematical reduction is reasoning work, independent of
  // the program's runtime. Older packages get the same small initial assessment budget.
  return plan ? Math.min(4, Math.max(0.1, (plan.cost.judgment_minutes ?? 15) / 60)) : 0.5;
}
export async function validateReceiptUse(returnId: number, receiptId: unknown): Promise<void> {
  if (receiptId === undefined || receiptId === null) return;
  if (!Number.isSafeInteger(receiptId) || Number(receiptId) < 1) bad('verification_receipt_id must be a positive integer');
  const receipt = (await verificationRuns(returnId)).find(r => Number(r.id) === receiptId);
  if (!receipt || !receipt.independent || !['recorded', 'accepted'].includes(receipt.receipt_status)) bad('verification_receipt_id must reference independent execution of this exact package in this project, with a valid receipt');
}
export async function verificationBrief(returnId: number): Promise<string> {
  const ret = await one(`SELECT verification_plan,verification_fingerprint FROM returns WHERE id=$1`, [returnId]);
  if (!ret?.verification_plan) return '';
  const runs = await verificationRuns(returnId);
  const state = await verificationState(returnId);
  return `\n\n### Verification package\n\nFingerprint: ${ret.verification_fingerprint}\n\n\`\`\`json\n${JSON.stringify(ret.verification_plan, null, 2)}\n\`\`\`\n\nExecution state across ALL receipts: ${JSON.stringify(state)}\n\nExecution receipts (reported observations; contributor/model separation does not imply independent algorithms):\n${runs.length ? runs.slice(0, 10).map(r => `- Receipt ${r.id}, return #${r.result_return_id}: ${r.outcome}; @${r.handle}, ${r.model}; ${r.elapsed_seconds} seconds; ${r.independent ? 'different contributor and model' : 'not independent of this author'}; status ${r.receipt_status}${r.reused ? '; reused exact package' : ''}. Observed: ${r.observed}. Provenance and coverage: ${JSON.stringify(r.details)}`).join('\n') : 'None yet.'}\n\nThe return JSON contains every receipt, including older failures. Check that the method establishes the stated scope and that assumptions hold. A sample stays a sample. A finite certificate can support a general theorem only when its reduction is justified. Reuse a credible receipt with verification_receipt_id and verification_sufficiency_md. Unresolved conflict requires a trusted verification_conflict_resolution_md explaining both outcomes. Inspect the full transcript when needed.\n`;
}
