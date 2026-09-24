/**
 * What a paper's review says about the text readers get (Sep 24 2026, paper review integrity). A paper is "reviewed" only when a
 * trusted, final acceptance is bound to the exact text served now (the accepted return's revised file has the served hash). The
 * registry's stored status, the newest acceptance and an acceptance of an earlier text never stand in for that. Open corrections,
 * accepted revisions that could not be applied, and a reopened decision are separate facts, each shown. One resolver serves the paper
 * list, the paper page and its JSON, so they agree. A review is a scoped assessment, not a guarantee of correctness or permission to
 * submit anywhere.
 */
import { q, one } from "../db/index.js";
import { openFindings, type Finding } from "./findings.js";

export type ReviewState = "reviewed" | "corrections_required" | "corrections_recorded" | "under_reassessment" | "earlier_version_reviewed" | "unreviewed";
export type PaperReview = {
  state: ReviewState; label: string; current_sha: string | null;
  review_return_id: number | null; rung: string | null;          // the acceptance bound to the served text
  earlier_return_id: number | null;                               // the latest acceptance of another text of this paper
  findings: Finding[]; advisory: Finding[];                       // open corrections on the served document
  awaiting_integration: Array<{ return_id: number; integration: string }>;
};

const LABEL: Record<ReviewState, string> = {
  reviewed: "Reviewed version; no required corrections recorded",
  corrections_required: "Reviewed draft; corrections required before circulation",
  corrections_recorded: "Reviewed version; corrections recorded",
  under_reassessment: "Current review under reassessment",
  earlier_version_reviewed: "Current version unreviewed; an earlier version was reviewed",
  unreviewed: "Unreviewed",
};

export async function paperReview(problemId: number, paper: { slug: string; path: string | null; current_file_sha: string | null }, servedSha: string | null = null): Promise<PaperReview> {
  const path = paper.path ?? `paper/${paper.slug}.md`;
  const sha = paper.current_file_sha ?? servedSha;
  const mine = `problem_id = $1 AND (paper_slug = $2 OR revision_path = $3)`;
  const bound = sha ? await one<{ id: string; final_rung: string | null }>(`SELECT id, final_rung FROM returns WHERE ${mine} AND revision_sha = $4 AND status = 'accepted' AND NOT provisional ORDER BY id DESC LIMIT 1`, [problemId, paper.slug, path, sha]) : null;
  // A decision on the served text that was reopened: final before, pending now.
  const reopened = !bound && sha ? await one<{ id: string }>(`SELECT r.id FROM returns r WHERE r.problem_id = $1 AND (r.paper_slug = $2 OR r.revision_path = $3) AND r.revision_sha = $4 AND r.status = 'pending' AND EXISTS (SELECT 1 FROM return_decisions d WHERE d.return_id = r.id AND d.status = 'accepted' AND NOT d.provisional) ORDER BY r.id DESC LIMIT 1`, [problemId, paper.slug, path, sha]) : null;
  const earlier = await one<{ id: string }>(`SELECT id FROM returns WHERE ${mine} AND status = 'accepted' AND NOT provisional AND revision_sha IS DISTINCT FROM $4 ORDER BY id DESC LIMIT 1`, [problemId, paper.slug, path, sha]);
  const awaiting = await q<{ id: string; integration: string }>(`SELECT id, integration FROM returns WHERE ${mine} AND status = 'accepted' AND NOT provisional AND integration IN ('conflict','missing') ORDER BY id`, [problemId, paper.slug, path]);
  const open = await openFindings(problemId, path);
  const required = open.filter((f) => f.scope !== "advisory");
  const state: ReviewState = bound
    ? (required.some((f) => f.scope === "before_circulation") ? "corrections_required" : required.length ? "corrections_recorded" : "reviewed")
    : reopened ? "under_reassessment" : earlier ? "earlier_version_reviewed" : "unreviewed";
  return {
    state, label: LABEL[state], current_sha: sha,
    review_return_id: bound ? Number(bound.id) : reopened ? Number(reopened.id) : null, rung: bound?.final_rung ?? null,
    earlier_return_id: !bound && earlier ? Number(earlier.id) : null,
    findings: required, advisory: open.filter((f) => f.scope === "advisory"),
    awaiting_integration: awaiting.map((a) => ({ return_id: Number(a.id), integration: a.integration })),
  };
}

/** The registry status the review supports: "reviewed" only for a reviewed served text; a pending submission shows as under review otherwise. */
export function coarseStatus(review: PaperReview, paper: { kind: string; path: string | null }, pending: number): string {
  if (review.state === "reviewed" || review.state === "corrections_required" || review.state === "corrections_recorded") return "reviewed";
  if (pending > 0 || review.state === "under_reassessment") return "under_review";
  return paper.kind === "proposal" || !paper.path ? "proposed" : "draft";
}
