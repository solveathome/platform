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
export function researchBucket(row: Parameters<typeof stageOf>[0]): ResearchBucket { const s = stageOf(row); return s === 'first_look' ? 'pursue' : s; }
export const STAGE_SQL = `coalesce(j.research_stage,CASE WHEN j.purpose='discovery' THEN CASE WHEN j.type IN ('explore','direction') THEN 'discover' ELSE 'pursue' END ELSE 'consolidate' END)`;
export const REQUIRED_CORRECTION_INTERVAL = 4;
const REQUIRED_CORRECTION_SQL = `j.min_tier=1 AND j.requires_trust AND j.type IN ('audit','paper') AND EXISTS (
  SELECT 1 FROM findings f WHERE f.job_id=j.id AND f.status='open' AND f.scope<>'advisory')`;
/** A project-wide opportunity, not a fresh allowance per session. /start holds the
 * project transaction lock, so concurrent one-task launches share this interval. */
export async function selectRequiredCorrection(a: SchedulingAgent): Promise<any | null> {
  if (a.tier !== 1 || !a.trusted || a.directionId || a.jobId) return null;
  const recent = await one(`SELECT 1 FROM (SELECT reason FROM assignment_attempts
    WHERE problem_id=$1 AND tier=1 AND scheduled ORDER BY started_at DESC,id DESC LIMIT $2) recent
    WHERE reason->>'required_correction'='true'`, [a.problemId, REQUIRED_CORRECTION_INTERVAL - 1]);
  return recent ? null : (await selectJob(a, false, false, undefined, false, false, false, true)) ?? null;
}
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
  for (const r of rows) { const key = r.stage === 'first_look' ? 'pursue' : r.stage; used[key] = (used[key] ?? 0) + Number(r.hours); used.total += Number(r.hours); used.abandoned += Number(r.abandoned ?? 0); }
  return used;
}

/** Who did the work (Chris, Sep 24 2026, #sah-gemma-mvp): over the last 7 days, the share of budgeted assignment hours and of
 * trusted review decisions held by the busiest handle and the busiest model. With one agent of one model running all day, this is
 * the number that shows whether the swarm is becoming that agent (the Gemma Challenge's agents converged without anyone seeing it
 * until afterwards), and the board says openly how much of the record one contributor's agent holds. Hours are allocation
 * accounting, as in researchAllocation, never a limit. A share is null when nothing happened in the window. */
export type Busiest = { name: string; share: number } | null;
export type WorkConcentration = { window_days: number; hours: { total: number; handle: Busiest; model: Busiest }; trusted_decisions: { total: number; handle: Busiest; model: Busiest } };
export async function workConcentration(problemId: number): Promise<WorkConcentration> {
  const top = async (sql: string): Promise<{ total: number; handle: Busiest; model: Busiest }> => {
    const rows = await q<{ handle: string; model: string | null; n: string }>(sql, [problemId]);
    const total = rows.reduce((t, r) => t + Number(r.n), 0);
    const busiest = (key: 'handle' | 'model'): Busiest => {
      const by = new Map<string, number>();
      for (const r of rows) { const k = r[key] ?? 'unknown'; by.set(k, (by.get(k) ?? 0) + Number(r.n)); }
      const [name, n] = [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
      return total > 0 && name !== undefined ? { name, share: Math.round(1000 * Number(n) / total) / 1000 } : null;
    };
    return { total: Math.round(total * 100) / 100, handle: busiest('handle'), model: busiest('model') };
  };
  const hours = await top(`SELECT u.handle, a.model, sum(a.budget_hours) AS n FROM assignment_attempts a JOIN users u ON u.id = a.user_id
    WHERE a.problem_id = $1 AND a.started_at > now() - interval '7 days' AND a.status <> 'cancelled' GROUP BY 1, 2`);
  const decisions = await top(`SELECT u.handle, rv.model, count(*) AS n FROM reviews rv JOIN returns r ON r.id = rv.return_id JOIN users u ON u.id = rv.user_id
    WHERE r.problem_id = $1 AND rv.trusted AND rv.created_at > now() - interval '7 days' GROUP BY 1, 2`);
  return { window_days: 7, hours, trusted_decisions: decisions };
}

export type SchedulingAgent = {
  problemId: number; slug: string; sessionId: string; uid: number; tier: number; model: string | null;
  provider: string | null; trusted: boolean; granted: boolean; lane: string | null;
  cpuHours: number; ramGb: number; hasGpu: boolean; disk: number; maxHours: number;
  /** Hours left in the session, when it has an end (the person's time= or the agent's X-Session-Ends): jobs are fitted to it (item 10). */
  hoursLeft?: number | null;
  jobId?: number; directionId?: string | null; directionRevision?: number; reviewStreak: number; capabilities: Partial<Capabilities>;
  /** A reviews-only trusted session with no review waiting (Chris, Sep 23 2026, ask 387): it may take a triage, under the review rules. */
  triageFallback?: boolean;
};

/** Hours a pursuit step waits before a requirement nobody here has ever declared stops holding it back. */
export const STALE_REQUIREMENT_HOURS = Math.max(1, Number(process.env.STALE_REQUIREMENT_HOURS) || 24);
/** Hours a session's declaration keeps counting as a capability someone here has. On Sep 26 2026 the 1,160 sessions of the last
 * week (every one a local department run) declared no tools, while sessions from before Sep 23 had declared `python3`: 93 of 96
 * queued pursuit steps named python and fitted nobody, pursuit had 11% of the hours against a 40% share, and the steps on the
 * routes the record ranks first (29, 59, 115, the k=46 certificate) waited eight days untaken. A capability nobody currently
 * running has declared is then treated like a name nobody declared: it stops holding a pursuit step after a day. A week was
 * too long: the python3 sessions were last seen on Sep 23, so a 7-day window left the 93 steps held until Sep 30. */
export const DECLARED_CAPABILITY_HOURS = Math.max(1, Number(process.env.DECLARED_CAPABILITY_HOURS) || 24);
const TOOL_ALIASES = `CASE WHEN need.name IN ('python','python3') THEN ARRAY['python','python3'] WHEN need.name IN ('node','nodejs','node.js') THEN ARRAY['node','nodejs','node.js'] ELSE ARRAY[need.name] END`;
/** A proposer's next step names its tools and sources in its own words ("job1934-blockgrain.py", "return-660"). Matching is
 * exact, so a name no agent declares holds the step for ever: on Sep 18 2026, 49 of 54 queued pursuit steps fitted no session
 * of the last week, their proposers' included, while agents were dealt lead hunts. A requirement still has to be met when any
 * session of the project seen in the last DECLARED_CAPABILITY_HOURS has declared it (it is a real capability: `lean`, a private
 * archive). A name nobody running has declared stops holding a pursuit step after a day; it is then shown to the taker as the proposer's note (`unmetRequirements`). */
function requirementClause(column: 'required_tools' | 'required_sources', key: 'tools' | 'sources', held: string, aliases: boolean): string {
  const names = aliases ? TOOL_ALIASES : `ARRAY[need.name]`;
  return `(j.${column} <@ ${held}::text[] OR (j.research_stage='pursue' AND j.created_at < now()-interval '${STALE_REQUIREMENT_HOURS} hours'
      AND NOT EXISTS (SELECT 1 FROM unnest(j.${column}) need(name) WHERE NOT (need.name = ANY(${held}::text[]))
        AND EXISTS (SELECT 1 FROM sessions known WHERE known.problem_id=j.problem_id AND known.last_seen > now()-interval '${DECLARED_CAPABILITY_HOURS} hours'
          AND coalesce(known.capabilities->'${key}','[]'::jsonb) ?| ${names}))))`;
}
/** The requirements of an assigned job this agent did not declare: served with the brief as the proposer's notes. */
export function unmetRequirements(row: { required_tools?: string[] | null; required_sources?: string[] | null }, capabilities: Partial<Capabilities>): { tools: string[]; sources: string[] } {
  const tools = new Set(matchingTools(capabilities.tools)), sources = new Set(capabilities.sources ?? []);
  return { tools: (row.required_tools ?? []).filter(t => !tools.has(t)), sources: (row.required_sources ?? []).filter(x => !sources.has(x)) };
}

/** The tier a review of return `pr` asks for: composeReviewBrief's reviewTier (job.ts), for a triage that would become that review. */
const REVIEW_TIER_SQL = `(CASE WHEN pr.verification_plan IS NOT NULL THEN 1 WHEN pr.type IN ('break','measure','formalize') THEN 99 WHEN pr.type = 'source' THEN 2 ELSE 1 END)`;
/** Shared predicates: the backlog and selection must count exactly the same eligible work. */
function eligibility(a: SchedulingAgent, omitCompute = false, sameKindOnly = false) {
  const values: any[] = [];
  const p = (v: any) => { values.push(v); return `$${values.length}`; };
  const pid = p(a.problemId), tier = p(a.tier), sid = p(a.sessionId), uid = p(a.uid), model = p(a.model), fallback = p(a.triageFallback === true && a.trusted);
  // Each clause carries the reason a bot is given when it asks for a job by id and cannot have it (#mba-sah-held-feedback-items, item 11).
  const labeled: Array<[string, string]> = [
    [`it asks for tier ${"${j.min_tier}"} or better and this session is tier ${a.tier}`, `j.problem_id = ${pid} AND j.status = 'queued' AND j.min_tier >= ${tier}`],
    ["it requires a trusted session", `(NOT j.requires_trust OR ${p(a.trusted)}::boolean)`],
    ["this session released it before", `j.last_released_session IS DISTINCT FROM ${sid}::text`],
    ["this session released or cancelled an attempt on it before", `NOT EXISTS (SELECT 1 FROM assignment_attempts old WHERE old.job_id = j.id AND old.session_id = ${sid} AND old.status IN ('released','cancelled'))`],
    ["it is outside the lane this session was registered for", `(${p(a.lane)}::text IS NULL OR l.slug = $${values.length})`],
    ["it asks for another model than yours", `(j.avoid_model IS NULL OR j.avoid_model IS DISTINCT FROM ${model}::text)`],
    ["it checks evidence of your own handle or model", `(er.id IS NULL OR (er.user_id <> ${uid} AND er.model IS DISTINCT FROM ${model}::text))`],
    ["it is a check longer than this session's hours per assignment", `(j.type <> 'check' OR j.budget_hours <= ${p(a.maxHours)})`],
    ["your handle already reported this package as unable to run", `(j.type <> 'check' OR NOT EXISTS (SELECT 1 FROM verification_runs v JOIN returns worker ON worker.id=v.result_return_id WHERE v.fingerprint=er.verification_fingerprint AND worker.problem_id=j.problem_id AND worker.user_id=${uid} AND v.outcome='unable'))`],
    ["it needs tools this session did not declare", requirementClause('required_tools', 'tools', p(matchingTools(a.capabilities.tools)), true)],
    ["it needs sources this session did not declare", requirementClause('required_sources', 'sources', p(a.capabilities.sources ?? []), false)],
    ["it judges your own handle's return, which needs a grant", `(pr.id IS NULL OR pr.user_id <> ${uid} OR ((j.type <> 'triage' OR ${fallback}::boolean) AND ${p(a.granted)}::boolean))`],
    ["it is a review and this session is not a trusted reviewer", `(pr.id IS NULL OR j.type = 'triage' OR ${p(a.trusted)}::boolean)`],
    // Review triage (Sep 18 2026): a first read by a session that is not trusted, on another handle and model than the author's;
    // a trusted session reviews instead, and nobody triages one return twice. A reviews-only trusted session with no review
    // waiting selects a triage under the review rules (never its own model's return, its own handle's only by grant) only to
    // turn it into its review: a trusted session never triages (Sep 28 2026, #mba-sah-bot-feedback-fixes-skip-triage).
    ["it is a triage: a trusted session never triages, nobody triages a return twice, and a run of four first reads goes to research", `(j.type <> 'triage' OR ((${fallback}::boolean OR (NOT ${p(a.trusted)}::boolean AND ${p(a.reviewStreak < 4)}::boolean)) AND NOT EXISTS (SELECT 1 FROM triages t WHERE t.return_id = j.parent_return_id AND t.user_id = ${uid})))`],
    ["you already reviewed this return", `NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.return_id = j.parent_return_id AND rv.user_id = ${uid} AND NOT rv.needs_reassessment)`],
    ["you already hold another job on this return", `NOT EXISTS (SELECT 1 FROM jobs j2 WHERE j2.parent_return_id = j.parent_return_id AND j2.id <> j.id AND j2.assigned_to = ${uid} AND j2.status = 'assigned')`],
    [sameKindOnly ? "it is not a return of your model" : "it judges a return of your own model: a model never judges its own kind", sameKindOnly ? `(pr.id IS NOT NULL AND pr.model IS NOT DISTINCT FROM ${model}::text)` : `(pr.id IS NULL OR pr.model IS DISTINCT FROM ${model}::text)`],
    // A trusted session never triages (Chris, Sep 28 2026, #mba-sah-bot-feedback-fixes-skip-triage): a triage it falls back to becomes
    // its review, so it only falls back to a triage whose return it may review.
    ["the return's author model is above this session's tier", `(pr.id IS NULL OR (j.type = 'triage' AND NOT ${fallback}::boolean) OR (j.type <> 'triage' AND j.min_tier >= 99) OR ${tier} <= coalesce(amt.tier, 99))`],
    ["its review asks for a higher tier than this session's", `(j.type <> 'triage' OR NOT ${fallback}::boolean OR ${tier} <= ${REVIEW_TIER_SQL})`],
    // Fitted to the session's remaining time (#mba-sah-held-feedback-items, item 10): a job estimated longer than the session has left
    // is passed over for one that fits. The estimate chooses the job; it never limits it (no time budget or deadline, Sep 19 2026).
    [`its estimate (${"${j.budget_hours}"} h) is longer than this session has left (${a.hoursLeft ?? "?"} h)`, `(${p(a.hoursLeft ?? null)}::numeric IS NULL OR j.budget_hours <= $${values.length})`],
  ];
  labeled.push(a.directionId
    ? ["it is outside this session's direction", `((j.agent_direction_id=${p(a.directionId)} AND j.agent_direction_revision=${p(a.directionRevision)}) OR (j.agent_direction_id IS NULL AND EXISTS(SELECT 1 FROM agent_direction_links dl WHERE dl.job_id=j.id AND dl.direction_id=${p(a.directionId)} AND dl.revision=${p(a.directionRevision)})))`]
    : ["it belongs to another agent's direction", `j.agent_direction_id IS NULL`]);
  const clauses = labeled.map(([, sql]) => sql);
  if(a.jobId) clauses.push(`j.id=${p(a.jobId)}`);
  if (!omitCompute) { const compute: [string, string] = ["it needs more compute than this session offers (cpu, ram, gpu or disk)", [
    `coalesce((j.compute_hint->>'cpu_hours')::numeric,0) <= ${p(a.cpuHours)}`,
    `coalesce((j.compute_hint->>'ram_gb')::numeric,0) <= ${p(a.ramGb > 0 ? a.ramGb : 8)}`,
    `(coalesce(j.compute_hint->>'gpu','false') IN ('false','0','') OR ${p(a.hasGpu)}::boolean)`,
    `(coalesce(j.compute_hint->>'mathlib_cache','false') IN ('false','0','') OR ${p(a.disk)} >= 10)`,
    `coalesce((j.compute_hint->>'disk_gb')::numeric,0) <= ${p(a.disk)}`,
  ].join(" AND ")]; labeled.push(compute); clauses.push(compute[1]); }
  return { values, p, labeled, where: clauses.join("\n AND "), joins: `FROM jobs j LEFT JOIN lanes l ON l.id = j.lane_id LEFT JOIN returns pr ON pr.id = j.parent_return_id LEFT JOIN returns er ON er.id=j.evidence_return_id LEFT JOIN model_tiers amt ON amt.model = pr.model` };
}

/**
 * Why a session may not take one job (#mba-sah-held-feedback-items, item 11: a bot asks for ?job=<id>): each eligibility clause the job
 * fails, in words. Empty when it is eligible. Status (queued, taken, done) is answered before this by the caller.
 */
export async function whyNotEligible(a: SchedulingAgent, jobId: number): Promise<string[]> {
  const e = eligibility({ ...a, jobId: undefined });
  const idx = e.p(jobId);
  const row = await one<Record<string, any>>(`SELECT j.min_tier, j.budget_hours, ${e.labeled.map(([, sql], i) => `coalesce((${sql}), false) AS c${i}`).join(", ")} ${e.joins} WHERE j.id = ${idx}`, e.values);
  if (!row) return ["no such job in this project"];
  return e.labeled.map(([label], i) => row[`c${i}`] ? null : label.replace("${j.min_tier}", String(row.min_tier)).replace("${j.budget_hours}", String(Number(row.budget_hours)))).filter((x): x is string => !!x);
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

/** What a reviews-only agent could take now (Chris, Sep 23 2026, ask 387): reviews, and the triages it falls back to when none
 * waits. The same eligibility as selection, compute offer left out; a series one triage covers still counts one each. */
export async function reviewWorkFor(a: SchedulingAgent, triage: boolean) {
  const e = eligibility({ ...a, triageFallback: triage }, true);
  const row = await one(`SELECT count(*) FILTER (WHERE j.type = 'review') AS reviews, count(*) FILTER (WHERE j.type = 'triage') AS triage ${e.joins} WHERE ${e.where}`, e.values);
  return { reviews: Number(row?.reviews ?? 0), triage: triage ? Number(row?.triage ?? 0) : 0 };
}

const DEFAULT_SKILLS = `CASE j.type WHEN 'formalize' THEN ARRAY['lean','formalize'] WHEN 'measure' THEN ARRAY['python','computation'] WHEN 'source' THEN ARRAY['literature-search'] WHEN 'break' THEN ARRAY['proof-analysis','counterexamples'] WHEN 'review' THEN ARRAY['verification','proof-analysis'] WHEN 'explore' THEN ARRAY['proof-analysis','research'] ELSE ARRAY[]::text[] END`;
/** Judgment of a packaged return that already has completed independent execution: a bounded decision, not a review-pool task. */
const CHECKED_JUDGMENT_SQL = `j.type='review' AND pr.verification_plan IS NOT NULL AND EXISTS (SELECT 1 FROM verification_runs v JOIN returns w ON w.id=v.result_return_id
  WHERE v.fingerprint=pr.verification_fingerprint AND w.problem_id=pr.problem_id AND w.user_id<>pr.user_id AND w.model<>pr.model AND w.status IN ('recorded','accepted') AND v.outcome IN ('pass','fail'))`;
/** Route spread (Chris, Sep 24 2026, #sah-gemma-mvp). A research job on a route this handle and model worked in their last
 * ROUTE_REPEAT_WINDOW assignments ranks ROUTE_REPEAT_PENALTY points lower: one agent running all day otherwise keeps extending
 * its own recent routes, the loop the Gemma Challenge's agents fell into ("quickly converged on a small set of axes"). Keyed on
 * handle and model, not session, so several sessions of one model under one handle count as one. A preference only: never a
 * refusal or a cap (docs/scheduler.md, "No cap on how much one agent does"); with nothing else eligible it gets the same route.
 * 24 points is two matching skills, or 24 days of waiting. Reviews, audits, triage and checks judge a return and keep their order. */
export const ROUTE_REPEAT_WINDOW = 3;
export const ROUTE_REPEAT_PENALTY = 24;
function routeRepeatSql(uid: string, model: string): string {
  return `(j.research_route_id IS NOT NULL AND j.type NOT IN ('review','audit','triage','check') AND j.research_route_id IN (
    SELECT rj.research_route_id FROM (SELECT ra.job_id FROM assignment_attempts ra WHERE ra.problem_id=j.problem_id AND ra.user_id=${uid} AND ra.model IS NOT DISTINCT FROM ${model}::text
      ORDER BY ra.started_at DESC,ra.id DESC LIMIT ${ROUTE_REPEAT_WINDOW}) recent JOIN jobs rj ON rj.id=recent.job_id WHERE rj.research_route_id IS NOT NULL))`;
}
export async function selectJob(a: SchedulingAgent, preferResearch: boolean, discoveryOnly = false, bucket?: ResearchBucket, checkedJudgment = false, reviewsOnly = false, triageOnly = false, requiredCorrectionOnly = false): Promise<any> {
  const e = eligibility(a);
  const skills = e.p(a.capabilities.skills ?? []), provider = e.p(a.provider), uid = e.p(a.uid);
  const routeRepeat = routeRepeatSql(uid, e.p(a.model));
  const typeOrder = a.tier === 1
    ? preferResearch
      ? ["paper", "explore", "direction", "break", "audit", "review", "curate", "source", "formalize", "measure"]
      : ["review", "audit", "paper", "explore", "direction", "curate", "source", "formalize", "break", "measure"]
    : ["break", "measure", "formalize", "review", "source", "curate", "paper", "explore", "direction", "audit"];
  if (bucket === 'consolidate') typeOrder.unshift('check');
  else if (a.tier !== 1) typeOrder.unshift('check');
  if (a.tier !== 1) typeOrder.unshift('triage');
  const order = e.p(typeOrder);
  const bucketFilter = (bucket ? `AND CASE WHEN ${STAGE_SQL}='first_look' THEN 'pursue' ELSE ${STAGE_SQL} END=${e.p(bucket)}` : '') + (checkedJudgment ? ` AND ${CHECKED_JUDGMENT_SQL}` : '') + (reviewsOnly ? ` AND j.type='review'` : '') + (triageOnly ? ` AND j.type='triage'` : '') + (requiredCorrectionOnly ? ` AND ${REQUIRED_CORRECTION_SQL}` : '');
  // Prioritize judgments that further research already relies on, without changing trust or eligibility.
  // Every non-age term is bounded; one point per waiting day eventually lifts older work.
  return one(`SELECT j.*, l.slug AS lane_slug, (${REQUIRED_CORRECTION_SQL}) AS required_correction,
    (SELECT count(*) FROM unnest(CASE WHEN cardinality(j.preferred_skills) > 0 THEN j.preferred_skills ELSE ${DEFAULT_SKILLS} END) tag WHERE tag = ANY(${skills}::text[])) AS skill_matches,
    ${routeRepeat} AS route_repeat
    ${e.joins} WHERE ${e.where} ${bucketFilter} ${discoveryOnly ? "AND j.purpose = 'discovery' AND j.type IN ('explore','direction','break','measure','formalize','source')" : ""}
    ORDER BY CASE WHEN pr.id IS NOT NULL AND pr.user_id = ${uid} THEN 1 ELSE 0 END,
    CASE WHEN j.research_stage='first_look' AND (
      j.created_at < now()-interval '1 hour' OR
      (SELECT count(*) FROM (SELECT research_stage FROM assignment_attempts
        WHERE problem_id=j.problem_id AND scheduled AND research_stage IN ('first_look','pursue')
        ORDER BY started_at DESC,id DESC LIMIT 3) recent WHERE recent.research_stage='pursue')=3
    ) THEN 0 ELSE 1 END,
    (
      j.priority * 10 + extract(epoch FROM (now() - j.created_at)) / 86400
      + CASE WHEN j.requires_trust AND EXISTS (SELECT 1 FROM findings f WHERE f.job_id=j.id AND f.status='open' AND f.scope<>'advisory') THEN 20 ELSE 0 END
      + CASE WHEN pr.id IS NOT NULL AND (
          EXISTS (SELECT 1 FROM research_dependencies d WHERE d.return_id=pr.id)
          OR EXISTS (SELECT 1 FROM jobs next WHERE next.research_source_return_id=pr.id AND next.research_stage='pursue')
        ) THEN 8 ELSE 0 END
      + LEAST(3, (SELECT count(*) FROM unnest(CASE WHEN cardinality(j.preferred_skills) > 0 THEN j.preferred_skills ELSE ${DEFAULT_SKILLS} END) tag WHERE tag = ANY(${skills}::text[]))) * 12
      + LEAST(3, cardinality(j.required_sources)) * 12
      - coalesce(array_position(${order}::text[], j.type), 10) * 4
      - CASE WHEN ${routeRepeat} THEN ${ROUTE_REPEAT_PENALTY} ELSE 0 END
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
/** Review triage (Chris, Sep 18 2026, #sah-review-only-meaningful: "let a tier 2 agent do a first review to see if it's worth
 * escalating"). On Sep 18 311 returns waited for a verdict while trusted reviewers decided about 15 a day, a third of the pile
 * was failed attempts, and half the verdicts came from the owner's own sessions. With triage on, a return that asks for review
 * first gets one bounded `triage` assignment: a session that is not trusted, at `min_tier` or better, on another handle and
 * model than the author's, answers one question: would a trusted verdict change the record? Yes: the review jobs are made as
 * before, with the triage note in the brief. No: the return is recorded as it stands (citable, buildable, elevation open).
 * Nothing reaches a trusted reviewer by itself (Chris, Sep 19 2026: "This is not about falling back to trusted reviewers, that system
 * is wrong"): a return waits in triage until a tier-2 session has read it. One triage may cover a series of returns of the same
 * lane or route, and one trusted review then decides them all.
 * Project `scheduler.review_triage` {min_tier, budget_hours} -> environment REVIEW_TRIAGE_MIN_TIER -> off. */
export type ReviewTriage = { minTier: number; budgetHours: number };
export function reviewTriage(slug: string, override?: unknown): ReviewTriage | null {
  const cfg = override !== undefined ? override : readProjectConfig(slug)?.scheduler?.review_triage;
  if (cfg === false) return null;
  const raw = cfg && typeof cfg === 'object' ? cfg as any : null;
  const envTier = process.env.REVIEW_TRIAGE_MIN_TIER;
  if (!raw && (envTier === undefined || envTier === '')) return null;
  const minTier = Number(raw?.min_tier ?? envTier ?? 2), budgetHours = Number(raw?.budget_hours ?? 0.25);
  if (!Number.isInteger(minTier) || minTier < 1 || minTier > 99) throw new Error('review_triage.min_tier must be a tier (1 to 99)');
  return { minTier, budgetHours: Number.isFinite(budgetHours) && budgetHours > 0 ? Math.min(4, budgetHours) : 0.25 };
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
