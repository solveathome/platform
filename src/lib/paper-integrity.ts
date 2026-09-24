/**
 * The read-only inventory of paper and document review integrity (Sep 24 2026): where the served text and its review disagree, where an
 * accepted revision was displaced or never applied, and which required corrections have no work carrying them. It names cases and a
 * suggested action; it changes nothing and decides nothing. Recovery is a separate, explicit step (restoreVersion in revisions.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { q } from "../db/index.js";
import * as files from "./files.js";
import { mirrorPath } from "./revisions.js";
import { listPapers } from "../routes/papers.js";

export async function inventory(problemId: number, slug: string) {
  const papers = (await listPapers(problemId, slug)).map((p: any) => ({ slug: p.slug, path: p.path ?? `paper/${p.slug}.md`, registry_status: p.registry_status, status: p.status, review: p.review.state, served_sha: p.review.current_sha, review_return_id: p.review.review_return_id, earlier_return_id: p.review.earlier_return_id, open_findings: p.review.findings.map((f: any) => f.id), awaiting_integration: p.review.awaiting_integration }));
  const mislabelled = papers.filter((p) => p.registry_status === "reviewed" && p.status !== "reviewed");
  // An accepted version followed by a version nobody reviewed: the accepted text is no longer served.
  const displaced = (await q(`SELECT DISTINCT ON (l.path) l.path, l.version AS latest, l.content_sha AS latest_sha, l.summary, a.version AS accepted_version, a.return_id, a.content_sha AS accepted_sha
      FROM (SELECT DISTINCT ON (path) * FROM document_versions WHERE problem_id = $1 ORDER BY path, version DESC) l
      JOIN document_versions a ON a.problem_id = l.problem_id AND a.path = l.path AND a.version < l.version AND a.return_id IS NOT NULL
      WHERE l.return_id IS NULL AND l.content_sha IS DISTINCT FROM a.content_sha
        AND NOT EXISTS (SELECT 1 FROM returns r WHERE r.problem_id = l.problem_id AND r.revision_path = l.path AND r.revision_sha = l.content_sha AND r.status = 'accepted' AND NOT r.provisional)
      ORDER BY l.path, a.version DESC`, [problemId])).map((d: any) => {
    return { path: d.path, served_version: Number(d.latest), displaced_version: Number(d.accepted_version), return_id: Number(d.return_id), served_summary: d.summary, suggestion: `inspect: restore version ${d.accepted_version} (scripts/paper-integrity --restore ${d.path}@${d.accepted_version}) if nothing newer is meant, else reconcile the accepted changes onto the served text` };
  });
  // The mirror file equals an older version: the next cut is stale and leaves the served text alone.
  const latest = await q<{ path: string; version: string; content_sha: string | null }>(`SELECT DISTINCT ON (path) path, version, content_sha FROM document_versions WHERE problem_id = $1 ORDER BY path, version DESC`, [problemId]);
  const staleMirror: Array<{ path: string; served_version: number; mirror_equals_version: number }> = [];
  for (const l of latest) {
    const mp = mirrorPath(slug, l.path); if (!existsSync(mp)) continue;
    const sha = files.sha256(readFileSync(mp, "utf8")); if (sha === l.content_sha) continue;
    const m = await q<{ version: string }>(`SELECT max(version) AS version FROM document_versions WHERE problem_id = $1 AND path = $2 AND content_sha = $3`, [problemId, l.path, sha]);
    if (m[0]?.version) staleMirror.push({ path: l.path, served_version: Number(l.version), mirror_equals_version: Number(m[0].version) });
  }
  const unintegrated = (await q(`SELECT r.id, r.revision_path, r.integration FROM returns r WHERE r.problem_id = $1 AND r.status = 'accepted' AND NOT r.provisional AND r.revision_sha IS NOT NULL
      AND (r.integration IN ('conflict','missing') OR (r.integration IS NULL AND NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.return_id = r.id))) ORDER BY r.id`, [problemId])).map((r: any) => ({ return_id: Number(r.id), path: r.revision_path, integration: r.integration ?? "never recorded" }));
  const unworked = (await q(`SELECT f.id, f.path, f.scope, f.note, f.job_id, j.status AS job_status FROM findings f LEFT JOIN jobs j ON j.id = f.job_id WHERE f.problem_id = $1 AND f.status = 'open' AND f.scope <> 'advisory' AND (j.id IS NULL OR j.status NOT IN ('queued','assigned','returned')) ORDER BY f.id`, [problemId])).map((f: any) => ({ ...f, id: Number(f.id) }));
  const reassessing = (await q(`SELECT r.id, r.revision_path FROM returns r WHERE r.problem_id = $1 AND r.status = 'pending' AND r.revision_sha IS NOT NULL AND EXISTS (SELECT 1 FROM return_decisions d WHERE d.return_id = r.id AND d.status = 'accepted' AND NOT d.provisional) ORDER BY r.id`, [problemId])).map((r: any) => ({ return_id: Number(r.id), path: r.revision_path }));
  return { project: slug, observed_at: new Date().toISOString(), papers, mislabelled, displaced, stale_mirror: staleMirror, unintegrated, findings_without_work: unworked, under_reassessment: reassessing,
    not_checked: "Whether a manuscript and a research note share one address (a paper derived from a note that replaced it) is a reviewer's judgment; this inventory does not infer it." };
}
