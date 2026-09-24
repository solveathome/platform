/**
 * Open dataset dump (scope Q16, Q26): data/dumps/<YYYY-MM-DD>/ holds one JSONL file per table plus manifest.json
 * (row counts, sha256 per file, license, attribution). Idempotent per day.
 *
 * Rows stream to disk one at a time. The export used to build each table as a single string; returns.jsonl (transcripts) passed
 * 334 MB on 2026-09-17 and the next day the join crossed V8's string limit (~512 MiB), so the cron died after jobs.jsonl for five
 * days: directories without a manifest, nothing to stamp. Nothing here holds a table in memory.
 *
 * The day's directory is only touched once every table has passed source review: files are written to a staging directory
 * beside it and moved in one by one, so a withheld export never partially replaces a published day. Proofs from an earlier run
 * of the same day (manifest.json.ots, superseded proofs, attestation.json) stay where they are; scripts/attest-dumps.sh re-stamps.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { needsSourceReview } from "./document-publication.js";

export const DUMP_TABLES: Record<string, string> = {
  departments: `SELECT d.id,u.handle,d.created_at FROM departments d JOIN users u ON u.id=d.user_id ORDER BY d.id`,
  runs: `SELECT s.run_id,s.department_id,p.slug AS project,u.handle,s.model,s.started_at,s.ended_at FROM sessions s JOIN users u ON u.id=s.user_id JOIN problems p ON p.id=s.problem_id WHERE s.run_id IS NOT NULL ORDER BY s.started_at`,
  asks: `SELECT a.id,p.slug AS project,u.handle AS from_handle,t.handle AS to_handle,a.from_department,a.from_run,a.to_department,a.to_run,a.routing,a.handoff,a.body_md,a.message_id,a.status,a.answer_message_id FROM asks a JOIN problems p ON p.id=a.problem_id JOIN users u ON u.id=a.from_user_id LEFT JOIN users t ON t.id=a.to_user_id ORDER BY a.id`,
  problems:  `SELECT id, slug, name, repo_url, status_md, discovery_share, research_allocation, created_at FROM problems ORDER BY id`,
  lanes:     `SELECT l.id, p.slug AS project, l.slug, l.title, l.variant, u.handle AS origin, l.status, l.created_at FROM lanes l JOIN problems p ON p.id = l.problem_id LEFT JOIN users u ON u.id = l.origin_user_id ORDER BY l.id`,
  jobs:      `SELECT j.id, p.slug AS project, l.slug AS lane, j.type, j.title, j.brief_md, j.git_ref, j.compute_hint, j.budget_hours, j.min_tier, j.quorum, j.parent_return_id, j.purpose, j.research_stage, j.research_route_id, j.research_revision, j.research_source_return_id, j.evidence_return_id, j.check_wait_expired_at, j.avoid_model, j.required_tools, j.required_sources, j.status, u.handle AS assigned_to, j.assigned_at, j.expires_at, j.created_at FROM jobs j JOIN problems p ON p.id = j.problem_id LEFT JOIN lanes l ON l.id = j.lane_id LEFT JOIN users u ON u.id = j.assigned_to ORDER BY j.id`,
  returns:   `SELECT r.id, r.job_id, p.slug AS project, l.slug AS lane, r.type, u.handle, r.department_id,r.run_id,r.model, r.provider, r.report_md, r.patch, r.transcript, r.cpu_hours, r.hashes, r.author_rung, r.research, r.research_route_id, r.verification_plan, r.verification_fingerprint, r.duplicate_of, r.superseded_by, r.status, r.final_rung, r.revision_path, r.revision_sha, r.revision_base_sha, r.integration, r.resolves, r.created_at FROM returns r JOIN problems p ON p.id = r.problem_id LEFT JOIN lanes l ON l.id = r.lane_id JOIN users u ON u.id = r.user_id ORDER BY r.id`,
  reviews:   `SELECT rv.id, rv.return_id, rv.review_job_id, u.handle, rv.department_id,rv.run_id,rv.model, rv.provider, rv.verdict, rv.rung, rv.notes_md, rv.trusted, rv.verification, rv.verification_receipt_id, rv.verification_sufficiency_md, rv.verification_conflict_through, rv.verification_conflict_resolution_md, rv.needs_reassessment, rv.weight, rv.agreed_with_outcome, rv.created_at FROM reviews rv JOIN users u ON u.id = rv.user_id ORDER BY rv.id`,
  channels:  `SELECT c.id, p.slug AS project, c.path, c.title, c.purpose, u.handle AS created_by, c.status, c.created_at FROM channels c JOIN problems p ON p.id = c.problem_id LEFT JOIN users u ON u.id = c.created_by ORDER BY c.id`,
  messages:  `SELECT m.id, c.path AS channel, u.handle,m.department_id,m.run_id,m.model, m.kind, m.reply_to, m.body_md, m.job_id, m.return_id, m.created_at FROM messages m JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.user_id ORDER BY m.id`,
  thread_notes: `SELECT n.id, l.slug AS lane, u.handle, n.return_id, n.body_md, n.created_at FROM thread_notes n JOIN lanes l ON l.id = n.lane_id JOIN users u ON u.id = n.user_id ORDER BY n.id`,
  contributors: `SELECT u.handle, u.created_at, rp.score, rp.accepted, rp.rejected, rp.review_agree, rp.review_disagree, rp.cpu_hours, rp.directions_accepted FROM users u LEFT JOIN reputation rp ON rp.user_id = u.id ORDER BY u.id`,
  model_tiers: `SELECT model, provider, tier, note, updated_at FROM model_tiers ORDER BY tier, model`,
  claims:    `SELECT p.slug AS project, c.ledger_id, c.path, c.kind, c.status, c.question, c.verdict, c.origin_handle, c.origin_role, c.origin_model, c.origin_model_role, c.origin_note, c.first_commit, c.last_commit, c.commits, c.corpus, c.model_commits, c.scored FROM claims c JOIN problems p ON p.id = c.problem_id ORDER BY c.path`,
  credits:   `SELECT c.id, u.handle, c.model, c.provider, c.kind, c.points, c.source_type, c.source_id, c.note, c.created_at FROM credits c JOIN users u ON u.id = c.user_id ORDER BY c.id`,
  papers: `SELECT p.slug AS project, a.slug, a.title, a.path, a.status, a.current_file_sha, a.current_return_id, a.created_at, a.updated_at FROM papers a JOIN problems p ON p.id = a.problem_id ORDER BY a.id`,
  document_publications: `SELECT p.slug AS project, d.path, d.sha256, d.prepared_at, d.source, d.recorded_at FROM document_publications d JOIN problems p ON p.id = d.problem_id ORDER BY d.id`,
  findings: `SELECT f.id, p.slug AS project, f.path, f.content_sha, f.return_id, f.review_id, f.note, f.scope, f.status, f.job_id, f.resolved_by_return_id, f.resolved_sha, f.resolved_at, f.created_at FROM findings f JOIN problems p ON p.id = f.problem_id ORDER BY f.id`,
  finding_events: `SELECT e.id, e.finding_id, e.status, e.note, e.return_id, e.created_at FROM finding_events e ORDER BY e.id`,
  document_versions: `SELECT p.slug AS project, d.path, d.version, d.content_sha, d.base_sha, d.return_id, d.created_at, u.handle AS author, d.author_model, d.verified_by, d.verified_models FROM document_versions d JOIN problems p ON p.id = d.problem_id LEFT JOIN users u ON u.id = d.author_user_id ORDER BY d.id`,
  research_routes: `SELECT rr.*,p.slug AS project FROM research_routes rr JOIN problems p ON p.id=rr.problem_id ORDER BY rr.id`,
  research_events: `SELECT e.* FROM research_events e ORDER BY e.id`,
  research_dependencies: `SELECT d.* FROM research_dependencies d ORDER BY d.route_id,d.return_id`,
  return_dependencies: `SELECT * FROM return_dependencies ORDER BY return_id,depends_on_id`,
  review_history: `SELECT * FROM review_history ORDER BY id`,
  verification_runs: `SELECT v.* FROM verification_runs v ORDER BY v.id`,
  files:     `SELECT f.sha256, u.handle, f.model, f.name, f.ext, f.bytes, f.created_at, f.deleted_at, f.deleted_note, (SELECT json_agg(json_build_object('type', r.ref_type, 'id', r.ref_id)) FROM file_refs r WHERE r.file_sha = f.sha256) AS refs FROM files f JOIN users u ON u.id = f.user_id ORDER BY f.created_at`,
};

// Public prose is screened row by row for copied sources; a hit withholds the whole day (nothing has reached the day's directory yet).
const PROSE = new Set(["status_md", "brief_md", "report_md", "patch", "transcript", "notes_md", "body_md", "question", "verdict", "contribution_md", "prior_art_md", "uncertainty_md", "evidence_md", "observed", "verification_sufficiency_md", "verification_conflict_resolution_md"]);
const STRUCTURED_PROSE = new Set(["research", "verification_plan", "next_step", "obstacle", "detail", "details", "review"]);
export function sourceReviewHit(table: string, row: Record<string, unknown>): string | null {
  for (const [field, value] of Object.entries(row)) {
    if ((PROSE.has(field) && typeof value === "string" && needsSourceReview(value)) || (STRUCTURED_PROSE.has(field) && value != null && needsSourceReview(JSON.stringify(value)))) {
      return `Export withheld pending source review: ${table} ${row.id ?? row.path ?? ""} ${field}`;
    }
  }
  return null;
}

export type DumpFile = { rows: number; bytes: number; sha256: string };
export type DumpManifest = { dataset: "solveathome"; day: string; generated_at: string; license: "CC BY 4.0"; attribution: string; homepage: string; note: string; files: Record<string, DumpFile> };
export type RowSource = (sql: string) => AsyncIterable<Record<string, unknown>>;

/** Files a re-run of the same day must keep: the OpenTimestamps proofs and the attestation record written on the host. */
const KEEP = /^(manifest\.json(\..*)?\.ots|attestation\.json)$/;

export async function writeDump(opts: { day: string; dumpDir: string; rows: RowSource; tables?: Record<string, string> }): Promise<DumpManifest> {
  const { day, dumpDir, rows } = opts;
  const tables = opts.tables ?? DUMP_TABLES;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`dump day must be YYYY-MM-DD, got ${day}`);
  const dir = join(dumpDir, day);
  const staging = join(dumpDir, `.${day}.staging-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(staging, { recursive: true });
  const files: Record<string, DumpFile> = {};
  try {
    for (const [name, sql] of Object.entries(tables)) {
      const fd = openSync(join(staging, `${name}.jsonl`), "w");
      const hash = createHash("sha256");
      let count = 0, bytes = 0;
      try {
        for await (const row of rows(sql)) {
          const hit = sourceReviewHit(name, row);
          if (hit) throw new Error(hit);
          const line = Buffer.from(JSON.stringify(row) + "\n");
          writeSync(fd, line); hash.update(line);
          count++; bytes += line.length;
        }
      } finally { closeSync(fd); }
      files[name] = { rows: count, bytes, sha256: hash.digest("hex") };
    }
    const manifest: DumpManifest = {
      dataset: "solveathome",
      day,
      generated_at: new Date().toISOString(),
      license: "CC BY 4.0",
      attribution: "solveathome.org and the handles named on each entry (fields: handle, assigned_to, origin, created_by)",
      homepage: "https://solveathome.org",
      note: "Every job brief, return (with scrubbed transcript), review verdict and chat message, including attempts that failed. Rungs: proven > verified > measured > heuristic > conjectured > refuted; a return's final_rung is assigned by trusted review; research investment state and worker-reported execution receipts are separate, author_rung is the author's claim.",
      files,
    };
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    // Every table passed: move the files into the day's directory (same filesystem, one rename each), manifest last.
    mkdirSync(dir, { recursive: true });
    for (const name of Object.keys(files)) renameSync(join(staging, `${name}.jsonl`), join(dir, `${name}.jsonl`));
    renameSync(join(staging, "manifest.json"), join(dir, "manifest.json"));
    // A table dropped from the export leaves no orphan from an earlier run of the same day; proofs are kept.
    for (const f of readdirSync(dir)) if (f.endsWith(".jsonl") && !(f.slice(0, -6) in files) && !KEEP.test(f)) rmSync(join(dir, f));
    writeFileSync(join(dumpDir, "latest.json"), JSON.stringify({ day, manifest: `${day}/manifest.json` }) + "\n");
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Days with a manifest, newest first. A directory without one is a run that died (or is still writing) and is not a snapshot. */
export function dumpDays(dumpDir: string): string[] {
  if (!existsSync(dumpDir)) return [];
  return readdirSync(dumpDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && existsSync(join(dumpDir, d, "manifest.json"))).sort().reverse();
}
