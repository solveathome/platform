import { q, one } from "../db/index.js";
import { readProjectConfig } from "./projects.js";
import type { Capabilities } from "./agent-profile.js";

export type SchedulingAgent = {
  problemId: number; slug: string; sessionId: string; uid: number; tier: number; model: string | null;
  provider: string | null; trusted: boolean; granted: boolean; lane: string | null;
  cpuHours: number; ramGb: number; hasGpu: boolean; disk: number; maxHours: number;
  reviewStreak: number; capabilities: Partial<Capabilities>;
};

/** Shared predicates: the backlog and selection must count exactly the same eligible work. */
function eligibility(a: SchedulingAgent, omitCompute = false) {
  const values: any[] = [];
  const p = (v: any) => { values.push(v); return `$${values.length}`; };
  const pid = p(a.problemId), tier = p(a.tier), sid = p(a.sessionId), uid = p(a.uid), model = p(a.model);
  const clauses = [
    `j.problem_id = ${pid} AND j.status = 'queued' AND j.min_tier >= ${tier}`,
    `j.last_released_session IS DISTINCT FROM ${sid}::text`,
    `NOT EXISTS (SELECT 1 FROM assignment_attempts old WHERE old.job_id = j.id AND old.session_id = ${sid} AND old.status IN ('released','cancelled'))`,
    `(${p(a.lane)}::text IS NULL OR l.slug = $${values.length})`,
    `j.required_tools <@ ${p(a.capabilities.tools ?? [])}::text[]`,
    `j.required_sources <@ ${p(a.capabilities.sources ?? [])}::text[]`,
    `(pr.id IS NULL OR pr.user_id <> ${uid} OR ${p(a.granted)}::boolean)`,
    `(pr.id IS NULL OR ${p(a.trusted)}::boolean)`,
    `NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.return_id = j.parent_return_id AND rv.user_id = ${uid})`,
    `NOT EXISTS (SELECT 1 FROM jobs j2 WHERE j2.parent_return_id = j.parent_return_id AND j2.id <> j.id AND j2.assigned_to = ${uid} AND j2.status = 'assigned')`,
    `(pr.id IS NULL OR pr.model IS DISTINCT FROM ${model}::text)`,
    `(pr.id IS NULL OR j.min_tier >= 99 OR ${tier} <= coalesce(amt.tier, 99))`,
  ];
  if (!omitCompute) clauses.push(
    `coalesce((j.compute_hint->>'cpu_hours')::numeric,0) <= ${p(a.cpuHours)}`,
    `coalesce((j.compute_hint->>'ram_gb')::numeric,0) <= ${p(a.ramGb > 0 ? a.ramGb : 8)}`,
    `(coalesce(j.compute_hint->>'gpu','false') IN ('false','0','') OR ${p(a.hasGpu)}::boolean)`,
    `(coalesce(j.compute_hint->>'mathlib_cache','false') IN ('false','0','') OR ${p(a.disk)} >= 10)`,
    `coalesce((j.compute_hint->>'disk_gb')::numeric,0) <= ${p(a.disk)}`,
  );
  return { values, p, where: clauses.join("\n AND "), joins: `FROM jobs j LEFT JOIN lanes l ON l.id = j.lane_id LEFT JOIN returns pr ON pr.id = j.parent_return_id LEFT JOIN model_tiers amt ON amt.model = pr.model` };
}

export async function backlogFor(a: SchedulingAgent) {
  const e = eligibility(a);
  const row = await one(`SELECT count(*) FILTER (WHERE j.type IN ('review','audit')) AS reviews,
    count(*) FILTER (WHERE j.type NOT IN ('review','audit')) AS research ${e.joins} WHERE ${e.where}`, e.values);
  return { reviews: Number(row?.reviews ?? 0), research: Number(row?.research ?? 0) };
}

const DEFAULT_SKILLS = `CASE j.type WHEN 'formalize' THEN ARRAY['lean','formalize'] WHEN 'measure' THEN ARRAY['python','computation'] WHEN 'source' THEN ARRAY['literature-search'] WHEN 'break' THEN ARRAY['proof-analysis','counterexamples'] WHEN 'review' THEN ARRAY['verification','proof-analysis'] WHEN 'explore' THEN ARRAY['proof-analysis','research'] ELSE ARRAY[]::text[] END`;
export async function selectJob(a: SchedulingAgent, preferResearch: boolean, discoveryOnly = false): Promise<any> {
  const e = eligibility(a);
  const skills = e.p(a.capabilities.skills ?? []), provider = e.p(a.provider), uid = e.p(a.uid);
  const typeOrder = a.tier === 1
    ? preferResearch
      ? ["paper", "explore", "direction", "break", "audit", "review", "curate", "source", "formalize", "measure"]
      : ["review", "audit", "paper", "explore", "direction", "curate", "source", "formalize", "break", "measure"]
    : ["break", "measure", "formalize", "review", "source", "curate", "paper", "explore", "direction", "audit"];
  const order = e.p(typeOrder);
  // Every non-age term is bounded; one point per waiting day eventually lifts older work.
  return one(`SELECT j.*, l.slug AS lane_slug,
    (SELECT count(*) FROM unnest(CASE WHEN cardinality(j.preferred_skills) > 0 THEN j.preferred_skills ELSE ${DEFAULT_SKILLS} END) tag WHERE tag = ANY(${skills}::text[])) AS skill_matches
    ${e.joins} WHERE ${e.where} ${discoveryOnly ? "AND j.purpose = 'discovery' AND j.type IN ('explore','direction','break','measure','formalize','source')" : ""}
    ORDER BY CASE WHEN pr.id IS NOT NULL AND pr.user_id = ${uid} THEN 1 ELSE 0 END,
    (
      j.priority * 10 + extract(epoch FROM (now() - j.created_at)) / 86400
      + LEAST(3, (SELECT count(*) FROM unnest(CASE WHEN cardinality(j.preferred_skills) > 0 THEN j.preferred_skills ELSE ${DEFAULT_SKILLS} END) tag WHERE tag = ANY(${skills}::text[]))) * 12
      + LEAST(3, cardinality(j.required_sources)) * 12
      - coalesce(array_position(${order}::text[], j.type), 10) * 4
    ) DESC,
    CASE WHEN pr.id IS NOT NULL AND pr.provider <> ${provider} THEN 0 ELSE 1 END,
    j.created_at, j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, e.values);
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
