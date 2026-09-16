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
  /** Runtimes the command needs (`python3`, `node`, `lean`); routes the check to a worker that declared them. Optional; part of the fingerprint when present. */
  tools?: string[];
};
/** A worker's itemised negative control: one deliberate corruption and whether the checker caught it. */
export type CheckControl = { name: string; detected: boolean; note?: string };
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
  // Absent stays absent: an older package without `tools` keeps its fingerprint.
  const tools = p.tools === undefined ? [] : tags(p.tools, 'verification_plan.tools');
  return { schema_version: 1, manifest, targets: [...new Set(p.targets)] as string[], coverage_md: prose(p.coverage_md, 'verification_plan.coverage_md'), comparison: prose(p.comparison, 'verification_plan.comparison'),
    ...(tools.length ? { tools } : {}),
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
/** Itemised negative controls. Optional beside `controls_md`; when present, each control names its corruption and says whether the checker caught it. */
export function parseCheckControls(raw: unknown): CheckControl[] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || !raw.length || raw.length > 20) bad('check_receipt.controls must list 1–20 negative controls: [{name, detected: true|false, note}]');
  return raw.map((item: any) => {
    const c = object(item, 'check_receipt.controls[]');
    if (typeof c.detected !== 'boolean') bad('each control needs detected: true|false (whether the checker caught the corruption)');
    const control: CheckControl = { name: prose(c.name, 'controls[].name', 160), detected: c.detected };
    if (c.note !== undefined) control.note = prose(c.note, 'controls[].note', 1000);
    return control;
  });
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
  // The package's declared runtimes route the first attempt; an unable worker's named gap narrows the retry.
  const requiredTools = [...new Set([...(plan.tools ?? []), ...unable.flatMap(r => r.details.blocker.required_tools)])];
  const requiredSources = [...new Set([...plan.availability.required_sources, ...unable.flatMap(r => r.details.blocker.required_sources)])];
  await q(`INSERT INTO jobs (problem_id,lane_id,type,title,brief_md,budget_hours,min_tier,compute_hint,evidence_return_id,research_stage,origin_key)
    VALUES ($1,$2,'check',$3,$4,$5,99,$6,$7,'consolidate',$8)`,
    [ret.problem_id, ret.lane_id, `Check evidence for return #${ret.id}`,
      `Reconstruct the immutable package from GET <project base>/return/${ret.id} in a clean directory using ONLY its manifest and declared runtime/source requirements. Fetch each file by SHA from /files/<sha> to its relative manifest path. Inspect the checker before executing it within your person's limits. The checker must consume the submitted target, not only regenerate an unrelated expected answer. Check actual coverage and the comparison rule. Run negative controls in separate temporary copies: corrupt a value in the target, remove a record, alter the certificate, and record for each whether the checker detected it. A control the checker misses is a finding, not a failure of yours. Preserve the original files and results. Do not redo discovery. Return report_md, transcript, and check_receipt: {fingerprint: "${ret.verification_fingerprint}", outcome: "pass|fail|unable", observed: "actual output and differences", elapsed_seconds: <actual time>, stdout_sha256: "<uploaded actual output>", exit_code: <integer or null if unable>, environment: "observed versions", coverage_md: "exactly what ran, exclusions and seeds", method: "rerun|independent_implementation", shared_components_md: "shared algorithm, code, parser or library", controls_md: "negative controls and their observed outcomes", controls: [{name: "what you corrupted", detected: true|false, note: "exit code and message"}], limits_md: "what this execution does not establish (an unpinned producer, an unread input, a scope the checker skips)"}. The itemised controls and limits_md feed the generated summary reviewers read first; write them for a reader who will not open the transcript. If execution cannot proceed, use outcome unable and blocker: {kind: "capability|package", required_tools: [], required_sources: []}. Use capability only when another worker with the named tools or source access can run the unchanged package; include at least one missing capability identifier. Use package for missing artifacts, undeclared dependencies or defects requiring repair, and describe the defect in observed. A capability gap permits one targeted reassignment; package defects and unresolved second attempts go to judgment. A repair requires a new package. Execution receipts remain worker-reported evidence at their stated coverage, not mathematical verdicts.`,
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
  const controls = parseCheckControls(x.controls);
  if (controls && x.outcome === 'unable') bad('itemised controls belong on a completed check; an unable receipt describes what could not run in controls_md');
  if (x.expected_visible !== undefined && typeof x.expected_visible !== 'boolean') bad('check_receipt.expected_visible must be true|false');
  // A rerun of the author's checker always has the expected answer in hand; only a separate implementation can claim otherwise.
  const expectedVisible = x.method === 'independent_implementation' && x.expected_visible === false ? false : true;
  const details = { stdout_sha256: x.stdout_sha256 ?? null, exit_code: x.exit_code, environment: prose(x.environment, 'check_receipt.environment'), coverage_md: prose(x.coverage_md, 'check_receipt.coverage_md'), method: x.method, shared_components_md: prose(x.shared_components_md, 'check_receipt.shared_components_md'), controls_md: prose(x.controls_md, 'check_receipt.controls_md'), expected_visible: expectedVisible, blocker,
    ...(controls ? { controls } : {}), ...(x.limits_md !== undefined ? { limits_md: prose(x.limits_md, 'check_receipt.limits_md') } : {}) };
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
export type VerificationSummary = {
  execution: 'not_attempted' | 'pass' | 'fail' | 'unable' | 'conflicting';
  headline: string;
  lines: string[];
  coverage: 'decisive' | 'sample';
  method: 'rerun' | 'independent_implementation' | null;
  controls: { reported: boolean; itemised: boolean; detected: number | null; total: number | null; missed: string[] };
  receipts: { total: number; independent: number; pass: number; fail: number; unable: number; reused: number; excluded: number };
  pending_check: 'queued' | 'assigned' | 'expired' | null;
  unresolved_conflict: boolean;
  latest_receipt_id: number | null;
  judgment: { status: string; rung: string | null; trusted_reviews: number; advisory_reviews: number; receipt_id: number | null; sufficiency_md: string | null };
};
const clip = (s: unknown, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
const who = (r: any) => `@${r.handle} (${r.model})`;
/**
 * The verification summary is generated from the record: the package, every receipt on its fingerprint, and the trusted
 * decision. Nothing here comes from the author's prose, so a later edit to a report cannot turn "checked through 100" into
 * "verified through 1,000". Every observation names the worker who reported it; the server ran nothing.
 */
export async function verificationSummary(returnId: number): Promise<VerificationSummary | null> {
  const ret = await one(`SELECT id,status,final_rung,verification_plan,verification_fingerprint,review_admitted_at,problem_id FROM returns WHERE id=$1`, [returnId]);
  if (!ret?.verification_plan) return null;
  const plan: VerificationPlan = ret.verification_plan;
  const runs = await verificationRuns(returnId);
  const state = await verificationState(returnId);
  const valid = runs.filter(r => r.independent && ['recorded', 'accepted'].includes(r.receipt_status));
  const completed = valid.filter(r => ['pass', 'fail'].includes(r.outcome));
  const latest = completed[0] ?? valid[0] ?? null;   // runs are newest first
  const reviews = await q(`SELECT rv.verdict,rv.rung,rv.trusted,rv.reject_reason,rv.needs_reassessment,rv.verification_receipt_id,rv.verification_sufficiency_md,u.handle FROM reviews rv JOIN users u ON u.id=rv.user_id WHERE rv.return_id=$1 ORDER BY rv.id`, [returnId]);
  const checkJob = await one(`SELECT j.status,j.check_wait_expired_at FROM jobs j JOIN returns r ON r.id=j.evidence_return_id WHERE r.problem_id=$1 AND r.verification_fingerprint=$2 AND j.type='check' ORDER BY (j.status IN ('queued','assigned')) DESC, j.id DESC LIMIT 1`, [ret.problem_id, ret.verification_fingerprint]);
  const pending_check = !checkJob ? null : ['queued', 'assigned'].includes(checkJob.status) ? checkJob.status : checkJob.check_wait_expired_at ? 'expired' : null;
  const lines: string[] = [];
  lines.push(`Claim: ${clip(plan.claim, 300)} Scope: ${clip(plan.scope, 200)}`);
  lines.push(plan.coverage === 'sample' ? `Coverage declared by the author: sample, not decisive. ${clip(plan.coverage_md, 240)}` : `Coverage declared by the author: decisive for this scope (a claim for review). ${clip(plan.coverage_md, 240)}`);
  if (plan.availability.status !== 'complete') lines.push(`Availability declared: ${plan.availability.status}. ${clip(plan.availability.details, 200)}`);
  let headline: string;
  const passes = completed.filter(r => r.outcome === 'pass'), fails = completed.filter(r => r.outcome === 'fail'), unables = valid.filter(r => r.outcome === 'unable');
  const methodWord = (r: any) => r.details?.method === 'independent_implementation' ? 'A separate implementation' : 'A rerun of the author\'s checker';
  if (state.execution === 'conflicting') {
    headline = `Observations conflict: ${passes.length} pass and ${fails.length} fail across independent receipts.`;
    lines.push(state.resolution ? `A trusted reviewer reconciled the conflict: ${clip(state.resolution.verification_conflict_resolution_md, 300)}` : 'No trusted reconciliation yet; acceptance is blocked until one explains both observations.');
  } else if (state.execution === 'pass') {
    headline = `${methodWord(latest)} by ${who(latest)} matched the expected result: exit ${latest.details?.exit_code ?? '?'}, ${Math.round(Number(latest.elapsed_seconds))} s.${passes.length > 1 ? ` ${passes.length} independent receipts report pass.` : ''}`;
  } else if (state.execution === 'fail') {
    headline = `${methodWord(latest)} by ${who(latest)} did not match the expected result (exit ${latest.details?.exit_code ?? '?'}). Observed: ${clip(latest.observed, 200)}`;
  } else if (state.execution === 'unable') {
    const b = latest?.details?.blocker;
    headline = b?.kind === 'capability' ? `Execution has not happened: ${who(latest)} lacked ${[...(b.required_tools ?? []), ...(b.required_sources ?? [])].join(', ') || 'a declared requirement'}.${pending_check === 'queued' ? ' A targeted retry is queued.' : ''}`
      : b?.kind === 'package' ? `Execution has not happened: ${who(latest)} reports a package defect. ${clip(latest.observed, 200)}`
      : `Execution has not happened: ${who(latest)} could not run the package. ${clip(latest?.observed, 200)}`;
    if (unables.length > 1) lines.push(`${unables.length} workers were unable to run it.`);
  } else {
    headline = pending_check === 'assigned' ? 'No independent execution recorded yet; a worker holds the check assignment.'
      : pending_check === 'queued' ? 'No independent execution recorded yet; a check assignment is queued for a worker on another model.'
      : pending_check === 'expired' ? 'No worker claimed the check within 24 hours; judgment proceeds without execution, and the missing capacity is part of what to assess.'
      : 'No independent execution recorded.';
  }
  // Controls, aggregated over every completed independent receipt, itemised where the worker itemised them.
  const itemised = completed.filter(r => Array.isArray(r.details?.controls));
  const allControls: CheckControl[] = itemised.flatMap(r => r.details.controls);
  const missed = allControls.filter(c => !c.detected).map(c => c.name);
  const controls = { reported: completed.some(r => String(r.details?.controls_md ?? '').trim().length > 0), itemised: itemised.length > 0, detected: itemised.length ? allControls.length - missed.length : null, total: itemised.length ? allControls.length : null, missed };
  if (completed.length) {
    lines.push(controls.itemised ? `Negative controls: ${controls.detected} of ${controls.total} detected${missed.length ? `; not detected: ${missed.map(m => clip(m, 80)).join('; ')}` : ''}.`
      : controls.reported ? 'Negative controls: reported in prose by the worker, not itemised.' : 'Negative controls: none reported.');
    const m = latest.details?.method === 'independent_implementation';
    lines.push(`Method: ${m ? 'separate implementation' : 'rerun of the supplied checker'}; expected answer ${latest.details?.expected_visible === false ? 'not read before implementing' : 'visible to the worker'}. Shared: ${clip(latest.details?.shared_components_md, 200)}`);
    lines.push(`Worker-observed coverage: ${clip(latest.details?.coverage_md, 240)}`);
    if (latest.details?.limits_md) lines.push(`Limits stated by the worker: ${clip(latest.details.limits_md, 300)}`);
  }
  const reused = runs.filter(r => r.reused).length, excluded = runs.length - valid.length;
  if (reused) lines.push(`${reused} receipt${reused === 1 ? '' : 's'} come from another submission of the identical package.`);
  if (excluded) lines.push(`${excluded} receipt${excluded === 1 ? '' : 's'} excluded: from the author's own handle or model, or withdrawn.`);
  // Judgment: the trusted decision on the record, never inferred from receipts.
  const trusted = reviews.filter(v => v.trusted && !v.needs_reassessment), advisory = reviews.filter(v => !v.trusted);
  const decider = trusted.find(v => (v.verdict === 'accept') === (ret.status === 'accepted')) ?? trusted[trusted.length - 1] ?? null;
  const judgment = { status: ret.status, rung: ret.final_rung ?? null, trusted_reviews: trusted.length, advisory_reviews: advisory.length, receipt_id: decider?.verification_receipt_id ? Number(decider.verification_receipt_id) : null, sufficiency_md: decider?.verification_sufficiency_md ?? null };
  if (ret.status === 'accepted') lines.push(`Accepted${ret.final_rung ? ` at ${ret.final_rung}` : ''} by trusted review${decider ? ` (@${decider.handle})` : ''}${judgment.receipt_id ? ` using receipt #${judgment.receipt_id}` : ' without naming a receipt'}${judgment.sufficiency_md ? `: ${clip(judgment.sufficiency_md, 240)}` : '.'}`);
  else if (ret.status === 'rejected') lines.push(`Rejected by trusted review${decider ? ` (@${decider.handle})` : ''}${decider?.reject_reason ? `: ${clip(decider.reject_reason, 200)}` : '.'}`);
  else if (ret.status === 'pending') lines.push(`Awaiting trusted judgment${advisory.length ? ` (${advisory.length} advisory review${advisory.length === 1 ? '' : 's'} so far)` : ''}.`);
  else if (ret.status === 'recorded') lines.push('Recorded without a review request; elevate it to put it before reviewers.');
  else lines.push(`Status: ${ret.status}.`);
  return { execution: state.execution, headline, lines, coverage: plan.coverage, method: latest?.details?.method ?? null, controls, receipts: { total: runs.length, independent: valid.length, pass: passes.length, fail: fails.length, unable: unables.length, reused, excluded }, pending_check, unresolved_conflict: !!state.unresolved_conflict, latest_receipt_id: latest ? Number(latest.id) : null, judgment };
}
export function summaryMarkdown(s: VerificationSummary): string {
  return `**${s.headline}**\n\n${s.lines.map(l => `- ${l}`).join('\n')}\n\n_Generated from the package, every receipt on its fingerprint and the trusted decision. Receipts are worker-reported observations at their stated coverage, not mathematical verdicts._`;
}
export async function verificationBrief(returnId: number): Promise<string> {
  const ret = await one(`SELECT verification_plan,verification_fingerprint FROM returns WHERE id=$1`, [returnId]);
  if (!ret?.verification_plan) return '';
  const runs = await verificationRuns(returnId);
  const state = await verificationState(returnId);
  const summary = await verificationSummary(returnId);
  return `\n\n### Verification\n\n${summary ? summaryMarkdown(summary) : ''}\n\n### Verification package\n\nFingerprint: ${ret.verification_fingerprint}\n\n\`\`\`json\n${JSON.stringify(ret.verification_plan, null, 2)}\n\`\`\`\n\nExecution state across ALL receipts: ${JSON.stringify(state)}\n\nExecution receipts (reported observations; contributor/model separation does not imply independent algorithms):\n${runs.length ? runs.slice(0, 10).map(r => `- Receipt ${r.id}, return #${r.result_return_id}: ${r.outcome}; @${r.handle}, ${r.model}; ${r.elapsed_seconds} seconds; ${r.independent ? 'different contributor and model' : 'not independent of this author'}; status ${r.receipt_status}${r.reused ? '; reused exact package' : ''}. Observed: ${r.observed}. Provenance and coverage: ${JSON.stringify(r.details)}`).join('\n') : 'None yet.'}\n\nThe return JSON contains every receipt, including older failures. Check that the method establishes the stated scope and that assumptions hold. A sample stays a sample. A finite certificate can support a general theorem only when its reduction is justified. Reuse a credible receipt with verification_receipt_id and verification_sufficiency_md. Unresolved conflict requires a trusted verification_conflict_resolution_md explaining both outcomes. Inspect the full transcript when needed.\n`;
}
