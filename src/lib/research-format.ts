/** Structured research reports are investment proposals, never mathematical verdicts. */
export const STAGES = ['discover', 'triage', 'pursue', 'rescue', 'consolidate'] as const;
export type ResearchStage = typeof STAGES[number];
export const OUTCOMES = ['proposed', 'promising', 'progress', 'blocked', 'inconclusive', 'known', 'result'] as const;
export const OBSTACLES = ['unresolved', 'attempt_failed', 'claim_refuted', 'scoped_obstruction'] as const;
export function bad(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }
export function object(raw: any, field: string): any {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad(`${field} must be an object`);
  return raw;
}
export function prose(raw: any, field: string, max = 4000): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max) bad(`${field} must be nonempty text, at most ${max} characters`);
  return raw.trim();
}
export function amount(raw: any, field: string, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) bad(`${field} must be a number from ${min} to ${max}`);
  return raw;
}
export function ids(raw: any, field: string, max = 20): number[] {
  if (!Array.isArray(raw) || raw.length > max || raw.some(x => !Number.isSafeInteger(x) || x < 1)) bad(`${field} must contain at most ${max} positive integer ids`);
  return [...new Set(raw)];
}
export type NextStep = { question: string; method: string; success: string; failure: string; budget_hours: number; compute: { cpu_hours: number; ram_gb: number; disk_gb: number }; required_tools: string[]; required_sources: string[] };
export function tags(raw: any, field: string): string[] {
  if (!Array.isArray(raw) || raw.length > 20 || raw.some(x => typeof x !== 'string' || !/^[a-z0-9][a-z0-9_.:+/-]{0,79}$/.test(x))) bad(`${field} must contain at most 20 lowercase capability identifiers`);
  return [...new Set(raw)] as string[];
}
/**
 * Every field of an object is checked before the request is refused, and the shape is named (platform issue #73). Refusing on
 * the first missing field cost one agent five rejected submissions to discover a five-field object, and each retry re-uploads
 * the whole transcript, about a megabyte a time. The rendered route page calls these "Next experiment", "Continue if" and
 * "Stop this attempt if", which are reasonable names to guess and are not the API's, so the skeleton goes in the refusal too.
 */
export const NEXT_STEP_SHAPE = 'next_step: {"question": "the discriminating question, <=1000 chars", "method": "how it is run, <=4000", "success": "what a positive result looks like, <=2000", "failure": "what stops this attempt, <=2000", "budget_hours": 0.1-4 (your estimate for the accounting of the portfolio; never a limit on the taker), "compute": {"cpu_hours": 0-32, "ram_gb": 0-32, "disk_gb": 0-10} (optional), "required_tools": [], "required_sources": []}';
export const OBSTACLE_SHAPE = `obstacle: {"kind": "${OBSTACLES.join('|')}", "statement": "the exact obstruction", "assumptions": "what it rests on", "evidence": "what shows it", "revisit_when": "the condition that reopens it"}`;

/** Runs every field check, then refuses once with everything that was wrong and the shape that is accepted. */
export function checked<T extends Record<string, any>>(shape: string, fields: { [K in keyof T]: () => T[K] }): T {
  const out = {} as T; const problems: string[] = [];
  for (const key of Object.keys(fields) as (keyof T)[]) {
    try { out[key] = fields[key](); } catch (error: any) { problems.push(String(error?.message ?? error)); }
  }
  if (problems.length) bad(`${problems.join('; ')}. The accepted shape is ${shape}`);
  return out;
}

export function nextStep(raw: any): NextStep {
  const x = object(raw, `research.next_step`), c = object(x.compute ?? {}, 'next_step.compute');
  return checked<NextStep>(NEXT_STEP_SHAPE, {
    question: () => prose(x.question, 'next_step.question', 1000),
    method: () => prose(x.method, 'next_step.method'),
    success: () => prose(x.success, 'next_step.success', 2000),
    failure: () => prose(x.failure, 'next_step.failure', 2000),
    budget_hours: () => amount(x.budget_hours, 'next_step.budget_hours', 0.1, 4),
    compute: () => ({ cpu_hours: amount(c.cpu_hours ?? 0, 'compute.cpu_hours', 0, 32), ram_gb: amount(c.ram_gb ?? 2, 'compute.ram_gb', 0, 32), disk_gb: amount(c.disk_gb ?? 1, 'compute.disk_gb', 0, 10) }),
    required_tools: () => tags(x.required_tools ?? [], 'next_step.required_tools'),
    required_sources: () => tags(x.required_sources ?? [], 'next_step.required_sources'),
  });
}
export type ResearchReport = {
  route_id?: number; parent_route_id?: number;
  proposal?: { title: string; contribution_md: string; prior_art_md: string; uncertainty_md: string };
  outcome: typeof OUTCOMES[number]; evidence_md: string; prior_art_md?: string; next_step?: NextStep;
  obstacle?: { kind: typeof OBSTACLES[number]; statement: string; assumptions: string; evidence: string; revisit_when: string };
  depends_on?: number[];
};
export function parseResearch(raw: unknown): ResearchReport | null {
  if (raw === undefined) return null;
  const x = object(raw, 'research');
  if (!OUTCOMES.includes(x.outcome)) bad(`research.outcome must be ${OUTCOMES.join('|')}`);
  const r: ResearchReport = { outcome: x.outcome, evidence_md: prose(x.evidence_md, 'research.evidence_md') };
  if (x.prior_art_md !== undefined) r.prior_art_md = prose(x.prior_art_md, 'research.prior_art_md');
  if (x.route_id !== undefined) r.route_id = ids([x.route_id], 'research.route_id')[0];
  if (x.parent_route_id !== undefined) r.parent_route_id = ids([x.parent_route_id], 'research.parent_route_id')[0];
  if (x.proposal !== undefined) {
    const p = object(x.proposal, 'research.proposal');
    r.proposal = { title: prose(p.title, 'proposal.title', 160), contribution_md: prose(p.contribution_md, 'proposal.contribution_md'), prior_art_md: prose(p.prior_art_md, 'proposal.prior_art_md'), uncertainty_md: prose(p.uncertainty_md, 'proposal.uncertainty_md') };
    if (r.route_id || r.outcome !== 'proposed') bad('a proposal creates a new route: omit route_id and use outcome proposed');
    if (r.prior_art_md) bad('a proposal uses proposal.prior_art_md; research.prior_art_md updates an existing route');
  }
  if (r.outcome === 'proposed' && !r.proposal) bad('outcome proposed requires research.proposal');
  if (r.parent_route_id && !r.proposal) bad('parent_route_id belongs on a new proposal');
  if (x.next_step !== undefined) r.next_step = nextStep(x.next_step);
  if (r.outcome === 'known' && (!r.prior_art_md || r.next_step || x.obstacle !== undefined)) bad('known requires prior_art_md with the covering sources and scope, without next_step or obstacle');
  if (['proposed', 'promising', 'progress'].includes(r.outcome) && !r.next_step) bad(`${r.outcome} requires next_step with a discriminating experiment`);
  if (x.obstacle !== undefined) {
    const o = object(x.obstacle, 'research.obstacle');
    if (!OBSTACLES.includes(o.kind)) bad(`obstacle.kind must be ${OBSTACLES.join('|')}. The accepted shape is ${OBSTACLE_SHAPE}`);
    r.obstacle = { kind: o.kind, ...checked<{ statement: string; assumptions: string; evidence: string; revisit_when: string }>(OBSTACLE_SHAPE, {
      statement: () => prose(o.statement, 'obstacle.statement'),
      assumptions: () => prose(o.assumptions, 'obstacle.assumptions'),
      evidence: () => prose(o.evidence, 'obstacle.evidence'),
      revisit_when: () => prose(o.revisit_when, 'obstacle.revisit_when'),
    }) };
  }
  if (['blocked', 'inconclusive'].includes(r.outcome) && !r.obstacle) bad(`${r.outcome} requires the exact obstacle and a reconsideration condition`);
  if (x.depends_on !== undefined) r.depends_on = ids(x.depends_on, 'research.depends_on');
  return r;
}

export function stageOf(job: { research_stage?: string | null; purpose?: string; type?: string }): ResearchStage {
  if (STAGES.includes(job.research_stage as ResearchStage)) return job.research_stage as ResearchStage;
  return job.purpose === 'discovery' ? (['explore', 'direction'].includes(job.type ?? '') ? 'discover' : 'pursue') : 'consolidate';
}
