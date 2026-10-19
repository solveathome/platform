/**
 * Paper retraction (Oct 19 2026, #sah-paper-proposals-meta-review). The client asked to retract the papers of low publishing value.
 * A retraction never deletes: the paper page stays up with the public reason above the manuscript, every version, review and credit
 * is kept, the project's lists (/papers, the project page, the sitemap, the ChatGPT plugin) hide it, and its queued paper and audit
 * jobs expire so no agent spends time on it. Work already assigned finishes and is reviewed as usual. A restore undoes the
 * retraction; both are append-only events in paper_retraction_events.
 */
import { one, q } from "../db/index.js";

export class RetractionError extends Error { constructor(message: string, public status = 400) { super(message); } }

const MAX_REASON = 500;
const cleanReason = (r: unknown): string => {
  const s = typeof r === "string" ? r.replace(/\s+/g, " ").trim() : "";
  if (s.length < 10) throw new RetractionError("give a public reason of at least 10 characters, in plain words (for example: a known result restated, no new finding)");
  if (s.length > MAX_REASON) throw new RetractionError(`the reason is at most ${MAX_REASON} characters`);
  return s;
};

/** Queued jobs that work on the paper: briefs naming it (paper, audit, typesetting, exposition) and fix jobs on its document. */
const OPEN_JOBS = `problem_id = $1 AND status = 'queued' AND (brief_md LIKE '%paper.slug: ' || $2 || E'\\n%' OR brief_md LIKE '%paper.slug: ' || $2 OR title = 'Fix ' || $3)`;

export async function retractPaper(problemId: number, slug: string, userId: number | null, reason: unknown) {
  const why = cleanReason(reason);
  const paper = await one<{ id: number; path: string | null; retracted_at: string | null }>(`SELECT id, path, retracted_at FROM papers WHERE problem_id = $1 AND slug = $2`, [problemId, slug]);
  if (!paper) throw new RetractionError("no such paper in this project", 404);
  if (paper.retracted_at) throw new RetractionError("this paper is already retracted; restore it first to change the reason", 409);
  const expired = await q(`UPDATE jobs SET status = 'expired', last_release_note = $4 WHERE ${OPEN_JOBS} RETURNING id`, [problemId, slug, paper.path ?? `paper/${slug}.md`, `the paper was retracted: ${why}`.slice(0, 600)]);
  await q(`UPDATE papers SET retracted_at = now(), retracted_reason = $2, retracted_by = $3 WHERE id = $1`, [paper.id, why, userId]);
  await q(`INSERT INTO paper_retraction_events (paper_id, action, reason, user_id, jobs_expired) VALUES ($1,'retract',$2,$3,$4)`, [paper.id, why, userId, expired.length]);
  return { paper: slug, retracted: true, reason: why, jobs_expired: expired.map((j: any) => Number(j.id)) };
}

/** Undo a retraction. Expired jobs stay expired: the next import-papers run queues fresh work for the paper if it needs any. */
export async function restorePaper(problemId: number, slug: string, userId: number | null, reason: unknown) {
  const why = cleanReason(reason);
  const paper = await one<{ id: number; retracted_at: string | null }>(`SELECT id, retracted_at FROM papers WHERE problem_id = $1 AND slug = $2`, [problemId, slug]);
  if (!paper) throw new RetractionError("no such paper in this project", 404);
  if (!paper.retracted_at) throw new RetractionError("this paper is not retracted", 409);
  await q(`UPDATE papers SET retracted_at = NULL, retracted_reason = NULL, retracted_by = NULL WHERE id = $1`, [paper.id]);
  await q(`INSERT INTO paper_retraction_events (paper_id, action, reason, user_id) VALUES ($1,'restore',$2,$3)`, [paper.id, why, userId]);
  return { paper: slug, retracted: false, reason: why };
}

export async function retractionEvents(paperId: number) {
  return q<{ action: string; reason: string; handle: string | null; created_at: string }>(`SELECT e.action, e.reason, u.handle, e.created_at FROM paper_retraction_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.paper_id = $1 ORDER BY e.id`, [paperId]);
}
