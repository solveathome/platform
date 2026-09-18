import { q, one } from "../db/index.js";
import { readProjectConfig } from "./projects.js";
import { matchingTools, type Capabilities } from "./agent-profile.js";
import { stageOf } from './research-format.js';

export const RESEARCH_BUCKETS = ['discover', 'pursue', 'rescue', 'consolidate'] as const;
export type ResearchBucket = typeof RESEARCH_BUCKETS[number];
export type ResearchAllocation = Record<ResearchBucket, number>;
export const INITIAL_RESEARCH_ALLOCATION: ResearchAllocation = { discover: 0.3, pursue: 0.4, rescue: 0.15, consolidate: 0.15 };
export function researchPolicy(slug: string, override?: unknown): ResearchAllocation | null {
  const raw = override ?? readProjectConfig(slug)?.scheduler?.research_allocation;
  if (raw === undefined || raw === null) return null; // existing instances retain their explicit discovery policy
  if (typeof raw !== 'object' || Array.isArray(raw) || RESEARCH_BUCKETS.some(k => typeof (raw as any)[k] !== 'number' || !Number.isFinite((raw as any)[k]) || (raw as any)[k] < 0)
      || Math.abs(RESEARCH_BUCKETS.reduce((n, k) => n + (raw as any)[k], 0) - 1) > 1e-6) throw new Error('research_allocation needs discover, pursue, rescue, consolidate fractions summing to one');
  return Object.fromEntries(RESEARCH_BUCKETS.map(k => [k, (raw as any)[k]])) as ResearchAllocation;
}
export function researchBucket(row: Parameters<typeof stageOf>[0]): ResearchBucket { const s = stageOf(row); return s === 'triage' ? 'pursue' : s; }
export const STAGE_SQL = `coalesce(j.research_stage,CASE WHEN j.purpose='discovery' THEN CASE WHEN j.type IN ('explore','direction') THEN 'discover' ELSE 'pursue' END ELSE 'consolidate' END)`;
export function portfolioOrder(policy: ResearchAllocation, used: Record<string, number>): ResearchBucket[] {
  return RESEARCH_BUCKETS.filter(k => policy[k] > 0).sort((a, b) => (policy[b] * (used.total + 1) - (used[b] ?? 0)) - (policy[a] * (used.total + 1) - (used[a] ?? 0)));
}
// Each tier has its own research budget: plentiful models must not consume another
// tier's discovery reserve, nor need that tier online to advance their own routes.
export async function researchAllocation(problemId: number, tier = 1): Promise<Record<string, number>> {
  const rows = await q(`SELECT coalesce(a.research_stage,CASE WHEN a.purpose='discovery' THEN 'discover' ELSE 'consolidate' END) AS stage,
    sum(a.budget_hours) AS hours,sum(a.budget_hours) FILTER (WHERE a.status IN ('released','cancelled')) AS abandoned
    FROM assignment_attempts a WHERE a.problem_id=$1 AND a.tier=$2 AND a.scheduled AND (a.started_at>now()-interval '7 days' OR a.status='assigned') GROUP BY 1`, [problemId, tier]);
  const used: Record<string, number> = { total: 0, abandoned: 0, discover: 0, pursue: 0, rescue: 0, consolidate: 0 };
  for (const r of rows) { const key = r.stage === 'triage' ? 'pursue' : r.stage; used[key] = (used[key] ?? 0) + Number(r.hours); used.total += Number(r.hours); used.abandoned += Number(r.abandoned ?? 0); }
  return used;
}

export type SchedulingAgent = {
  problemId: number; slug: string; sessionId: string; uid: number; tier: number; model: string | null;
  provider: string | null; trusted: boolean; granted: boolean; lane: string | null;
  cpuHours: number; ramGb: number; hasGpu: boolean; disk: number; maxHours: number;
  jobId?: number; directionId?: string | null; directionRevision?: number; reviewStreak: number; capabilities: Partial<Capabilities>;
};

/** Hours a pursuit step waits before a requirement nobody here has ever declared stops holding it back. */
export const STALE_REQUIREMENT_HOURS = Math.max(1, Number(process.env.STALE_REQUIREMENT_HOURS) || 24);
const TOOL_ALIASES = `CASE WHEN need.name IN ('python','python3') THEN ARRAY['python','python3'] WHEN need.name IN ('node','nodejs','node.js') THEN ARRAY['node','nodejs','node.js'] ELSE ARRAY[need.name] END`;
/** A proposer's next step names its tools and sources in its own words ("job1934-blockgrain.py", "return-660"). Matching is
 * exact, so a name no agent declares holds the step for ever: on Sep 18 2026, 49 of 54 queued pursuit steps fitted no session
 * of the last week, their proposers' included, while agents were dealt lead hunts. A requirement still has to be met when any
 * session of the project has ever declared it (it is a real capability: `lean`, a private archive). A name nobody has ever
 * declared stops holding a pursuit step after a day; it is then shown to the taker as the proposer's note (`unmetRequirements`). */
function requirementClause(column: 'required_tools' | 'required_sources', key: 'tools' | 'sources', held: string, aliases: boolean): string {
  const names = aliases ? TOOL_ALIASES : `ARRAY[need.name]`;
  return `(j.${column} <@ ${held}::text[] OR (j.research_stage='pursue' AND j.created_at < now()-interval '${STALE_REQUIREMENT_HOURS} hours'
      AND NOT EXISTS (SELECT 1 FROM unnest(j.${column}) need(name) WHERE NOT (need.name = ANY(${held}::text[]))
        AND EXISTS (SELECT 1 FROM sessions known WHERE known.problem_id=j.problem_id AND coalesce(known.capabilities->'${key}','[]'::jsonb) ?| ${names}))))`;
}
/** The requirements of an assigned job this agent did not declare: served with the brief as the proposer's notes. */
export function unmetRequirements(row: { required_tools?: string[] | null; required_sources?: string[] | null }, capabilities: Partial<Capabilities>): { tools: string[]; sources: string[] } {
  const tools = new Set(matchingTools(capabilities.tools)), sources = new Set(capabilities.sources ?? []);
  return { tools: (row.required_tools ?? []).filter(t => !tools.has(t)), sources: (row.required_sources ?? []).filter(x => !sources.has(x)) };
}

/** Shared predicates: the backlog and selection must count exactly the same eligible work. */
function eligibility(a: SchedulingAgent, omitCompute = false, sameKindOnly = false) {
  const values: any[] = [];
  const p = (v: any) => { values.push(v); return `$${values.length}`; };
  const pid = p(a.problemId), tier = p(a.tier), sid = p(a.sessionId), uid = p(a.uid), model = p(a.model);
  const clauses = [
    `j.problem_id = ${pid} AND j.status = 'queued' AND j.min_tier >= ${tier}`,
    `j.last_released_session IS DISTINCT FROM ${sid}::text`,
    `NOT EXISTS (SELECT 1 FROM assignment_attempts old WHERE old.job_id = j.id AND old.session_id = ${sid} AND old.status IN ('released','cancelled'))`,
    `(${p(a.lane)}::text IS NULL OR l.slug = $${values.length})`,
    `(j.avoid_model IS NULL OR j.avoid_model IS DISTINCT FROM ${model}::text)`,
    `(er.id IS NULL OR (er.user_id <> ${uid} AND er.model IS DISTINCT FROM ${model}::text))`,
    `(j.type <> 'check' OR j.budget_hours <= ${p(a.maxHours)})`,
    `(j.type <> 'check' OR NOT EXISTS (SELECT 1 FROM verification_runs v JOIN returns worker ON worker.id=v.result_return_id WHERE v.fingerprint=er.verification_fingerprint AND worker.problem_id=j.problem_id AND worker.user_id=${uid} AND v.outcome='unable'))`,
    requirementClause('required_tools', 'tools', p(matchingTools(a.capabilities.tools)), true),
    requirementClause('required_sources', 'sources', p(a.capabilities.sources ?? []), false),
    `(pr.id IS NULL OR pr.user_id <> ${uid} OR ${p(a.granted)}::boolean)`,
    `(pr.id IS NULL OR ${p(a.trusted)}::boolean)`,
    `NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.return_id = j.parent_return_id AND rv.user_id = ${uid} AND NOT rv.needs_reassessment)`,
    `NOT EXISTS (SELECT 1 FROM jobs j2 WHERE j2.parent_return_id = j.parent_return_id AND j2.id <> j.id AND j2.assigned_to = ${uid} AND j2.status = 'assigned')`,
    sameKindOnly ? `(pr.id IS NOT NULL AND pr.model IS NOT DISTINCT FROM ${model}::text)` : `(pr.id IS NULL OR pr.model IS DISTINCT FROM ${model}::text)`,
    `(pr.id IS NULL OR j.min_tier >= 99 OR ${tier} <= coalesce(amt.tier, 99))`,
  ];
  clauses.push(a.directionId
    ? `((j.agent_direction_id=${p(a.directionId)} AND j.agent_direction_revision=${p(a.directionRevision)}) OR (j.agent_direction_id IS NULL AND EXISTS(SELECT 1 FROM agent_direction_links dl WHERE dl.job_id=j.id AND dl.direction_id=${p(a.directionId)} AND dl.revision=${p(a.directionRevision)})))`
    : `j.agent_direction_id IS NULL`);
  if(a.jobId) clauses.push(`j.id=${p(a.jobId)}`);
  if (!omitCompute) clauses.push(
    `coalesce((j.compute_hint->>'cpu_hours')::numeric,0) <= ${p(a.cpuHours)}`,
    `coalesce((j.compute_hint->>'ram_gb')::numeric,0) <= ${p(a.ramGb > 0 ? a.ramGb : 8)}`,
    `(coalesce(j.compute_hint->>'gpu','false') IN ('false','0','') OR ${p(a.hasGpu)}::boolean)`,
    `(coalesce(j.compute_hint->>'mathlib_cache','false') IN ('false','0','') OR ${p(a.disk)} >= 10)`,
    `coalesce((j.compute_hint->>'disk_gb')::numeric,0) <= ${p(a.disk)}`,
  );
  return { values, p, where: clauses.join("\n AND "), joins: `FROM jobs j LEFT JOIN lanes l ON l.id = j.lane_id LEFT JOIN returns pr ON pr.id = j.parent_return_id LEFT JOIN returns er ON er.id=j.evidence_return_id LEFT JOIN model_tiers amt ON amt.model = pr.model` };
}

export async function backlogFor(a: SchedulingAgent) {
  const e = eligibility(a);
  const row = await one(`SELECT count(*) FILTER (WHERE j.type IN ('review','audit')) AS reviews,
    count(*) FILTER (WHERE j.type NOT IN ('review','audit')) AS research ${e.joins} WHERE ${e.where}`, e.values);
  // Reviews this agent cannot take *only* because a model never reviews its own kind (platform issue #82). Without it the
  // scheduler records eligible_backlog.reviews = 0 while the brief prints the count waiting, and the two describe one queue:
  // "no review debt" and "review debt nobody here can serve" are not the same fact, and only the second one grows.
  const k = eligibility(a, false, true);
  const blocked = await one(`SELECT count(*) FILTER (WHERE j.type IN ('review','audit')) AS reviews ${k.joins} WHERE ${k.where}`, k.values);
  return { reviews: Number(row?.reviews ?? 0), research: Number(row?.research ?? 0), blocked_reviews: Number(blocked?.reviews ?? 0) };
}

const DEFAULT_SKILLS = `CASE j.type WHEN 'formalize' THEN ARRAY['lean','formalize'] WHEN 'measure' THEN ARRAY['python','computation'] WHEN 'source' THEN ARRAY['literature-search'] WHEN 'break' THEN ARRAY['proof-analysis','counterexamples'] WHEN 'review' THEN ARRAY['verification','proof-analysis'] WHEN 'explore' THEN ARRAY['proof-analysis','research'] ELSE ARRAY[]::text[] END`;
/** Judgment of a packaged return that already has completed independent execution: a bounded decision, not a review-pool task. */
const CHECKED_JUDGMENT_SQL = `j.type='review' AND pr.verification_plan IS NOT NULL AND EXISTS (SELECT 1 FROM verification_runs v JOIN returns w ON w.id=v.result_return_id
  WHERE v.fingerprint=pr.verification_fingerprint AND w.problem_id=pr.problem_id AND w.user_id<>pr.user_id AND w.model<>pr.model AND w.status IN ('recorded','accepted') AND v.outcome IN ('pass','fail'))`;
export async function selectJob(a: SchedulingAgent, preferResearch: boolean, discoveryOnly = false, bucket?: ResearchBucket, checkedJudgment = false, reviewsOnly = false): Promise<any> {
  const e = eligibility(a);
  const skills = e.p(a.capabilities.skills ?? []), provider = e.p(a.provider), uid = e.p(a.uid);
  const typeOrder = a.tier === 1
    ? preferResearch
      ? ["paper", "explore", "direction", "break", "audit", "review", "curate", "source", "formalize", "measure"]
      : ["review", "audit", "paper", "explore", "direction", "curate", "source", "formalize", "break", "measure"]
    : ["break", "measure", "formalize", "review", "source", "curate", "paper", "explore", "direction", "audit"];
  if (bucket === 'consolidate') typeOrder.unshift('check');
  else if (a.tier !== 1) typeOrder.unshift('check');
  const order = e.p(typeOrder);
  const bucketFilter = (bucket ? `AND CASE WHEN ${STAGE_SQL}='triage' THEN 'pursue' ELSE ${STAGE_SQL} END=${e.p(bucket)}` : '') + (checkedJudgment ? ` AND ${CHECKED_JUDGMENT_SQL}` : '') + (reviewsOnly ? ` AND j.type='review'` : '');
  // Prioritize judgments that further research already relies on, without changing trust or eligibility.
  // Every non-age term is bounded; one point per waiting day eventually lifts older work.
  return one(`SELECT j.*, l.slug AS lane_slug,
    (SELECT count(*) FROM unnest(CASE WHEN cardinality(j.preferred_skills) > 0 THEN j.preferred_skills ELSE ${DEFAULT_SKILLS} END) tag WHERE tag = ANY(${skills}::text[])) AS skill_matches
    ${e.joins} WHERE ${e.where} ${bucketFilter} ${discoveryOnly ? "AND j.purpose = 'discovery' AND j.type IN ('explore','direction','break','measure','formalize','source')" : ""}
    ORDER BY CASE WHEN pr.id IS NOT NULL AND pr.user_id = ${uid} THEN 1 ELSE 0 END,
    CASE WHEN j.research_stage='triage' AND (
      j.created_at < now()-interval '1 hour' OR
      (SELECT count(*) FROM (SELECT research_stage FROM assignment_attempts
        WHERE problem_id=j.problem_id AND scheduled AND research_stage IN ('triage','pursue')
        ORDER BY started_at DESC,id DESC LIMIT 3) recent WHERE recent.research_stage='pursue')=3
    ) THEN 0 ELSE 1 END,
    (
      j.priority * 10 + extract(epoch FROM (now() - j.created_at)) / 86400
      + CASE WHEN pr.id IS NOT NULL AND (
          EXISTS (SELECT 1 FROM research_dependencies d WHERE d.return_id=pr.id)
          OR EXISTS (SELECT 1 FROM jobs next WHERE next.research_source_return_id=pr.id AND next.research_stage='pursue')
        ) THEN 8 ELSE 0 END
      + LEAST(3, (SELECT count(*) FROM unnest(CASE WHEN cardinality(j.preferred_skills) > 0 THEN j.preferred_skills ELSE ${DEFAULT_SKILLS} END) tag WHERE tag = ANY(${skills}::text[]))) * 12
      + LEAST(3, cardinality(j.required_sources)) * 12
      - coalesce(array_position(${order}::text[], j.type), 10) * 4
    ) DESC,
    CASE WHEN pr.id IS NOT NULL AND pr.provider <> ${provider} THEN 0 ELSE 1 END,
    j.created_at, j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, e.values);
}

/** Review pressure: the number of review jobs a session that may review must find waiting before it goes back to alternating
 * by need (Chris, Sep 11 2026: a run of up to four reviews, then one research assignment) ahead of the research portfolio.
 * Under the portfolio alone reviews get the consolidation share (15% for twin primes): in the week to Sep 18 2026 the sessions
 * trusted by model were sent to research 38 times while about 560 reviews they could take waited, and took 11. Below the
 * threshold nothing changes: frontier agents are not a review pool. Project override -> environment -> off. */
export function reviewPressure(slug: string, override?: unknown): number | null {
  const raw = override ?? readProjectConfig(slug)?.scheduler?.review_pressure ?? process.env.REVIEW_PRESSURE;
  const n = Number(raw);
  return raw !== undefined && raw !== null && raw !== '' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
export function discoveryShare(slug: string, databaseShare?: number | string | null): number {
  const raw = databaseShare ?? readProjectConfig(slug)?.scheduler?.discovery_share ?? process.env.TIER1_DISCOVERY_SHARE ?? 0.2;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.2;
}
export async function allocation(problemId: number) {
  const r = await one(`SELECT coalesce(sum(budget_hours),0) AS total,
    coalesce(sum(budget_hours) FILTER (WHERE purpose = 'discovery'),0) AS discovery,
    coalesce(sum(budget_hours) FILTER (WHERE purpose = 'discovery' AND status = 'completed'),0) AS completed_discovery,
    coalesce(sum(budget_hours) FILTER (WHERE purpose = 'discovery' AND status IN ('released','cancelled')),0) AS abandoned_discovery
    FROM assignment_attempts WHERE problem_id = $1 AND tier = 1 AND scheduled AND (started_at > now() - interval '7 days' OR status = 'assigned')`, [problemId]);
  return Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k, Number(v)]));
}
export function discoveryDue(share: number, used: { [key: string]: number }, nextHours: number): boolean {
  return share > 0 && used.discovery + 1e-9 < share * (used.total + nextHours);
}

export async function computeBlocked(a: SchedulingAgent): Promise<{ n: number; types: string; ram: number; hours: number } | null> {
  const e = eligibility(a, true), full = eligibility(a);
  // Non-compute eligibility is identical; named work is excluded only by the compute predicates.
  const rows = await q(`SELECT j.id, j.type, j.compute_hint ${e.joins} WHERE ${e.where} AND j.type <> 'review'`, e.values);
  const fitting = new Set((await q(`SELECT j.id ${full.joins} WHERE ${full.where}`, full.values)).map(r => String(r.id)));
  const blocked = rows.filter(r => !fitting.has(String(r.id)));
  return blocked.length ? { n: blocked.length, types: [...new Set(blocked.map(r => r.type))].sort().join(", "), ram: Math.max(...blocked.map(r => Number(r.compute_hint.ram_gb ?? 0))), hours: Math.max(...blocked.map(r => Number(r.compute_hint.cpu_hours ?? 0))) } : null;
}
