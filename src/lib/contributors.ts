/**
 * Who helped on a project between two times, one row per person (#sah-contributor-credit-build, mba notes/solveathome-contributor-credit.md).
 * The week page's contributors table, the weekly post's list, the Monday email's names and "Your week" line, and the project page's
 * "Helping this week" strip all read this one query, so they never disagree.
 *  - A person is a handle: every agent, model and session under it rolls up into one row (Chris, #r2081: many agents of different
 *    models run under one handle). A handle is never listed once per agent or per model.
 *  - Helping is a return, a triage or a review in the window. Triages count: they are work a person's agent did (a triage is not a
 *    review and never a truth grade, but it is never invisible either; Max's profile read "0 reviews given" beside 3 triages, 2 Nov 2026).
 *  - Points are the credit paid in the window, which includes older work accepted now and insight credit when someone builds on an
 *    earlier return. People paid that way with no work in the window are "built on", listed apart, never as helpers.
 *  - The project's own account (weekly config `exclude_handles`) is left out of the list and given back as `excluded`, so a page can say
 *    what it did. Display names are on the rows for rendering only; `compact` keeps handles, because the stored week is in the public dump.
 */
import { q } from "../db/index.js";
import { withoutKindPrefix } from "./research-format.js";

export type Contributor = {
  user_id: number; handle: string; display_name: string | null;
  returns: number; accepted: number; recorded: number; rejected: number; pending: number; by_rung: Record<string, number>;
  triages: number; escalated: number; reviews: number; points: number; models: string[];
  best: { id: number; rung: string | null; title: string } | null;
};
export type BuiltOn = { user_id: number; handle: string; display_name: string | null; points: number };
export type Contributors = { people: Contributor[]; built_on: BuiltOn[]; excluded: Contributor[] };
/** What a stored week keeps of a person: handles and counts, no display name (weekly_digests is in the public dump). */
export type CompactContributor = { handle: string; returns: number; accepted: number; triages: number; reviews: number; points: number; proven: number; verified: number };

const RUNG_RANK = `array_position(ARRAY['proven','verified','measured','heuristic','conjectured','refuted'], r.final_rung)`;

export async function contributorsBetween(problemId: number, from: Date, to: Date, exclude: string[] = []): Promise<Contributors> {
  const P = [problemId, from, to];
  const rows = await q<any>(`WITH ret AS (
      SELECT r.user_id, count(*)::int AS returns, count(*) FILTER (WHERE r.status = 'accepted')::int AS accepted,
        count(*) FILTER (WHERE r.status = 'recorded')::int AS recorded, count(*) FILTER (WHERE r.status = 'rejected')::int AS rejected,
        count(*) FILTER (WHERE r.status IN ('pending','contested'))::int AS pending, array_agg(DISTINCT r.model) AS models
      FROM returns r WHERE r.problem_id = $1 AND r.created_at >= $2 AND r.created_at < $3 GROUP BY 1
    ), rung AS (
      SELECT user_id, jsonb_object_agg(final_rung, n) AS by_rung FROM (SELECT r.user_id, r.final_rung, count(*)::int AS n FROM returns r
        WHERE r.problem_id = $1 AND r.created_at >= $2 AND r.created_at < $3 AND r.status = 'accepted' AND r.final_rung IS NOT NULL GROUP BY 1, 2) x GROUP BY 1
    ), tri AS (
      SELECT t.user_id, count(*)::int AS triages, count(*) FILTER (WHERE t.escalate)::int AS escalated, array_agg(DISTINCT t.model) AS models
      FROM triages t JOIN returns r ON r.id = t.return_id WHERE r.problem_id = $1 AND t.created_at >= $2 AND t.created_at < $3 GROUP BY 1
    ), rev AS (
      SELECT rv.user_id, count(*)::int AS reviews, array_agg(DISTINCT rv.model) AS models
      FROM reviews rv JOIN returns r ON r.id = rv.return_id WHERE r.problem_id = $1 AND rv.created_at >= $2 AND rv.created_at < $3 GROUP BY 1
    ), pts AS (
      SELECT c.user_id, sum(c.points)::float AS points FROM credits c WHERE c.problem_id = $1 AND c.created_at >= $2 AND c.created_at < $3 GROUP BY 1
    ), best AS (
      SELECT DISTINCT ON (r.user_id) r.user_id, r.id, r.type, r.final_rung, j.title AS job_title, left(r.report_md, 400) AS report_md
      FROM returns r LEFT JOIN jobs j ON j.id = r.job_id
      WHERE r.problem_id = $1 AND r.created_at >= $2 AND r.created_at < $3 AND r.status = 'accepted' AND NOT coalesce(r.provisional, false)
      ORDER BY r.user_id, ${RUNG_RANK} NULLS LAST, r.id DESC
    ), who AS (SELECT user_id FROM ret UNION SELECT user_id FROM tri UNION SELECT user_id FROM rev UNION SELECT user_id FROM pts WHERE points > 0)
    SELECT u.id AS user_id, u.handle, u.display_name, coalesce(ret.returns, 0) AS returns, coalesce(ret.accepted, 0) AS accepted,
      coalesce(ret.recorded, 0) AS recorded, coalesce(ret.rejected, 0) AS rejected, coalesce(ret.pending, 0) AS pending, coalesce(rung.by_rung, '{}') AS by_rung,
      coalesce(tri.triages, 0) AS triages, coalesce(tri.escalated, 0) AS escalated, coalesce(rev.reviews, 0) AS reviews, coalesce(pts.points, 0) AS points,
      ARRAY(SELECT DISTINCT m FROM unnest(coalesce(ret.models, '{}') || coalesce(tri.models, '{}') || coalesce(rev.models, '{}')) m WHERE m IS NOT NULL AND m <> '' ORDER BY 1) AS models,
      best.id AS best_id, best.type AS best_type, best.final_rung AS best_rung, best.job_title AS best_job_title, best.report_md AS best_report_md
    FROM who JOIN users u ON u.id = who.user_id LEFT JOIN ret ON ret.user_id = u.id LEFT JOIN rung ON rung.user_id = u.id LEFT JOIN tri ON tri.user_id = u.id
      LEFT JOIN rev ON rev.user_id = u.id LEFT JOIN pts ON pts.user_id = u.id LEFT JOIN best ON best.user_id = u.id`, P);
  const out: Contributors = { people: [], built_on: [], excluded: [] };
  const ex = new Set(exclude.map((h) => h.toLowerCase()));
  for (const r of rows) {
    const c: Contributor = { user_id: Number(r.user_id), handle: r.handle, display_name: r.display_name ?? null, returns: r.returns, accepted: r.accepted,
      recorded: r.recorded, rejected: r.rejected, pending: r.pending, by_rung: r.by_rung ?? {}, triages: r.triages, escalated: r.escalated, reviews: r.reviews,
      points: Math.round(Number(r.points)), models: r.models ?? [], best: r.best_id ? { id: Number(r.best_id), rung: r.best_rung, title: titleOf(r) } : null };
    const helped = c.returns + c.triages + c.reviews > 0;
    if (ex.has(String(c.handle).toLowerCase())) { if (helped) out.excluded.push(c); }
    else if (helped) out.people.push(c);
    else if (c.points > 0) out.built_on.push({ user_id: c.user_id, handle: c.handle, display_name: c.display_name, points: c.points });
  }
  out.people.sort(byWork); out.excluded.sort(byWork);
  out.built_on.sort((a, b) => b.points - a.points || a.handle.localeCompare(b.handle));
  return out;
}

/** Most accepted first, then most work of any kind, then points; ties by handle so the order is stable. */
function byWork(a: Contributor, b: Contributor): number {
  return b.accepted - a.accepted || (b.returns + b.triages + b.reviews) - (a.returns + a.triages + a.reviews) || b.points - a.points || a.handle.localeCompare(b.handle);
}

function titleOf(r: any): string {
  if (r.best_job_title) return String(r.best_job_title);
  const first = String(r.best_report_md ?? "").split("\n").find((l: string) => l.trim())?.replace(/^#+\s*/, "").trim();
  return first ? withoutKindPrefix(first).slice(0, 160) : `${r.best_type} #${r.best_id}`;
}

export function compact(c: Contributor): CompactContributor {
  return { handle: c.handle, returns: c.returns, accepted: c.accepted, triages: c.triages, reviews: c.reviews, points: c.points, proven: c.by_rung.proven ?? 0, verified: c.by_rung.verified ?? 0 };
}

/** One person's week in a few words, the same in Discord and email: "58 returns, 48 accepted (1 proven), 9 triages". */
export function workPhrase(c: { returns: number; accepted: number; triages: number; reviews: number; proven?: number; verified?: number }): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const pl = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;
  const top = [c.proven ? `${n(c.proven)} proven` : "", c.verified ? `${n(c.verified)} verified` : ""].filter(Boolean).join(", ");
  return [c.returns ? pl(c.returns, "return", "returns") : "", c.accepted ? `${n(c.accepted)} accepted${top ? ` (${top})` : ""}` : "",
    c.triages ? pl(c.triages, "triage", "triages") : "", c.reviews ? pl(c.reviews, "review", "reviews") : ""].filter(Boolean).join(", ");
}

/** Who wrote each return: for the What moved lines, which name returns by number and, from now on, their authors. */
export async function returnAuthors(ids: number[]): Promise<Map<number, { handle: string; display_name: string | null }>> {
  const want = [...new Set(ids.filter((i) => Number.isInteger(i) && i > 0))];
  if (!want.length) return new Map();
  const rows = await q<any>(`SELECT r.id, u.handle, u.display_name FROM returns r JOIN users u ON u.id = r.user_id WHERE r.id = ANY($1::bigint[])`, [want]);
  return new Map(rows.map((r) => [Number(r.id), { handle: r.handle, display_name: r.display_name ?? null }]));
}

/** "return 6431" in a line, with or without an author already written after it. */
export const RETURN_REF = /\breturn #?(\d+)(?: by [A-Za-z0-9_.-]+)?/g;
export function returnIdsIn(texts: string[]): number[] {
  const ids: number[] = [];
  for (const t of texts) for (const m of String(t).matchAll(RETURN_REF)) ids.push(Number(m[1]));
  return ids;
}
/** The author after each return a line names, as a plain handle (Discord, email): "route 424 (return 6431 by maxime-fleury)". */
export function withAuthors(text: string, authors: Map<number, { handle: string }> | Record<string, string>): string {
  const get = (id: number) => authors instanceof Map ? authors.get(id)?.handle : (authors as Record<string, string>)[String(id)];
  return text.replace(RETURN_REF, (m, id) => { const h = get(Number(id)); return h ? `return ${id} by ${String(h).replace(/[^A-Za-z0-9_.-]/g, "")}` : m; });
}
