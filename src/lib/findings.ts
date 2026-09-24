/**
 * Findings (Sep 24 2026, paper review integrity): a correction a trusted reviewer or an accepted audit requires in a served document.
 * The review's also_fix stays as written; the finding is its durable record: what text it was made against, the job carrying it now,
 * and how it closed. It closes only when an accepted return's revision of that document is integrated, and only for the findings that
 * return answered; it reopens if the text it was found in is served again. Job turnover never erases one: a finding whose job ended
 * without closing it goes to the next fix job.
 */
import { q, one } from "../db/index.js";

export const SCOPES = ["before_circulation", "advisory"] as const;
export type Scope = (typeof SCOPES)[number] | "unspecified";
export const scopeOf = (s: unknown): Scope => (SCOPES as readonly string[]).includes(String(s)) ? (String(s) as Scope) : "unspecified";

export type Finding = { id: number; path: string; note: string; scope: Scope; status: string; content_sha: string | null; return_id: number | null; review_id: number | null; job_id: number | null; job_status: string | null; resolved_by_return_id: number | null; resolved_sha: string | null; created_at: string };

async function event(findingId: number, status: string, note: string, returnId: number | null = null): Promise<void> {
  await q(`INSERT INTO finding_events (finding_id, status, note, return_id) VALUES ($1,$2,$3,$4)`, [findingId, status, note, returnId]);
}

/** Record a finding once per origin; the same note from the same return is the same finding. Returns its id. */
export async function recordFinding(f: { problemId: number; path: string; note: string; scope?: unknown; contentSha: string | null; returnId: number | null; reviewId?: number | null }): Promise<number> {
  const row = await one<{ id: string; fresh: boolean }>(
    `INSERT INTO findings (problem_id, path, content_sha, return_id, review_id, note, scope) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (COALESCE(return_id, 0), path, md5(note)) DO UPDATE SET scope = CASE WHEN findings.scope = 'unspecified' THEN EXCLUDED.scope ELSE findings.scope END
     RETURNING id, (xmax = 0) AS fresh`,
    [f.problemId, f.path, f.contentSha, f.returnId, f.reviewId ?? null, f.note, scopeOf(f.scope)]);
  if (row!.fresh) await event(Number(row!.id), "open", f.reviewId ? `review #${f.reviewId}` : f.returnId ? `return #${f.returnId}` : "");
  return Number(row!.id);
}

export async function linkToJob(findingId: number, jobId: number): Promise<boolean> {
  const r = await q(`UPDATE findings SET job_id = $2, linked_at = now() WHERE id = $1 AND status = 'open' AND job_id IS DISTINCT FROM $2 RETURNING id`, [findingId, jobId]);
  if (r.length) await event(findingId, "open", `carried by job #${jobId}`);
  return r.length > 0;
}

const SELECT = `SELECT f.id, f.path, f.note, f.scope, f.status, f.content_sha, f.return_id, f.review_id, f.job_id, j.status AS job_status, f.resolved_by_return_id, f.resolved_sha, f.created_at
  FROM findings f LEFT JOIN jobs j ON j.id = f.job_id`;
const shape = (r: any): Finding => ({ ...r, id: Number(r.id), return_id: r.return_id === null ? null : Number(r.return_id), review_id: r.review_id === null ? null : Number(r.review_id), job_id: r.job_id === null ? null : Number(r.job_id), resolved_by_return_id: r.resolved_by_return_id === null ? null : Number(r.resolved_by_return_id) });

export async function openFindings(problemId: number, path: string): Promise<Finding[]> {
  return (await q(`${SELECT} WHERE f.problem_id = $1 AND f.path = $2 AND f.status = 'open' ORDER BY f.id`, [problemId, path])).map(shape);
}
export async function findingsOfJob(jobId: number): Promise<Finding[]> {
  return (await q(`${SELECT} WHERE f.job_id = $1 ORDER BY f.id`, [jobId])).map(shape);
}
export async function findingsByIds(ids: number[]): Promise<Finding[]> {
  return ids.length ? (await q(`${SELECT} WHERE f.id = ANY($1::bigint[]) ORDER BY f.id`, [ids])).map(shape) : [];
}

/**
 * An accepted return's revision was integrated as `sha`: close the findings it answered. Those are the ids it named in `resolves` among the
 * open findings on its document, else the findings its job carried when the job was taken. A finding put on the job later was not in the
 * brief the author worked from and stays open. Nothing closes on a revision that was not applied.
 */
export async function resolveByReturn(ret: { id: number; problem_id: number; job_id: number | null; revision_path: string; resolves: any; created_at?: string }, sha: string): Promise<number[]> {
  const named = Array.isArray(ret.resolves) ? ret.resolves.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : null;
  const rows = named
    ? await q<{ id: string }>(`SELECT id FROM findings WHERE id = ANY($1::bigint[]) AND problem_id = $2 AND path = $3 AND status = 'open'`, [named, ret.problem_id, ret.revision_path])
    : ret.job_id ? await q<{ id: string }>(`SELECT f.id FROM findings f JOIN jobs j ON j.id = f.job_id JOIN returns r ON r.id = $4 WHERE f.job_id = $1 AND f.problem_id = $2 AND f.path = $3 AND f.status = 'open' AND f.linked_at <= COALESCE(j.assigned_at, r.created_at)`, [ret.job_id, ret.problem_id, ret.revision_path, ret.id]) : [];
  const ids = rows.map((r) => Number(r.id));
  for (const id of ids) {
    await q(`UPDATE findings SET status = 'resolved', resolved_by_return_id = $2, resolved_sha = $3, resolved_at = now() WHERE id = $1`, [id, ret.id, sha]);
    await event(id, "resolved", `revision of return #${ret.id} accepted and integrated`, ret.id);
  }
  return ids;
}

/** The text a finding was made against is served again (a restore, a mirror cut, a revert): its correction no longer holds there. */
export async function reopenRegressed(problemId: number, path: string, sha: string): Promise<number[]> {
  const rows = await q<{ id: string }>(`UPDATE findings SET status = 'open', resolved_by_return_id = NULL, resolved_sha = NULL, resolved_at = NULL WHERE problem_id = $1 AND path = $2 AND status = 'resolved' AND content_sha = $3 RETURNING id`, [problemId, path, sha]);
  for (const r of rows) await event(Number(r.id), "open", `reopened: the text it was found in (${sha.slice(0, 12)}…) is served again`);
  return rows.map((r) => Number(r.id));
}

/** Findings still open on a job that has ended (accepted without answering them, rejected, expired): they need the next fix job. */
export async function orphanedFindings(jobId: number): Promise<Finding[]> {
  return (await q(`${SELECT} WHERE f.job_id = $1 AND f.status = 'open' AND (j.id IS NULL OR j.status NOT IN ('queued','assigned','returned')) ORDER BY f.id`, [jobId])).map(shape);
}
