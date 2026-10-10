import { unlistedSlugs } from "./projects.js";
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
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { read, fstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { findHarnessId, redactHarnessIds, redactHomePaths } from "./files.js";
import { needsSourceReview } from "./document-publication.js";

export const DUMP_TABLES: Record<string, string> = {
  // Record challenges (src/lib/challenges.ts): live receipts and their corrections; demo submissions and session ids stay out.
  challenge_submissions: `SELECT s.id, p.slug AS project, s.challenge_id, u.handle, s.model, s.job_id, s.inputs, s.digest, s.score, s.byte_length, s.a_bytes, s.b_bytes, s.total_bytes, s.identity_sha256, s.duplicate_of, s.known_result, s.attribution, s.method_md, s.ai_involvement, s.runtime_s, s.hardware, s.verifier_version, s.checks, s.received_at, s.verified_at FROM challenge_submissions s JOIN problems p ON p.id = s.problem_id JOIN users u ON u.id = s.user_id WHERE s.namespace = 'live' ORDER BY s.id`,
  challenge_events: `SELECT e.id, p.slug AS project, e.challenge_id, e.kind, e.value, e.submission_id, e.note, e.created_at FROM challenge_events e JOIN problems p ON p.id = e.problem_id WHERE e.namespace = 'live' ORDER BY e.id`,
  challenge_corrections: `SELECT c.id, p.slug AS project, c.submission_id, c.kind, c.note, c.attribution, u.handle AS by, c.created_at FROM challenge_corrections c JOIN challenge_submissions s ON s.id = c.submission_id JOIN problems p ON p.id = s.problem_id LEFT JOIN users u ON u.id = c.user_id WHERE s.namespace = 'live' ORDER BY c.id`,
  challenge_reports: `SELECT r.id, p.slug AS project, r.job_id, u.handle, r.model, r.report_md, r.created_at FROM challenge_reports r JOIN problems p ON p.id = r.problem_id JOIN users u ON u.id = r.user_id ORDER BY r.id`,
  job_correction_prerequisites: `SELECT p.job_id,p.finding_id,u.handle AS recorded_by,p.reason_md,p.created_at FROM job_correction_prerequisites p LEFT JOIN users u ON u.id=p.created_by ORDER BY p.job_id,p.finding_id`,
  departments: `SELECT d.id,u.handle,d.created_at FROM departments d JOIN users u ON u.id=d.user_id ORDER BY d.id`,
  runs: `SELECT s.run_id,s.department_id,p.slug AS project,u.handle,s.model,s.started_at,s.ended_at FROM sessions s JOIN users u ON u.id=s.user_id JOIN problems p ON p.id=s.problem_id WHERE s.run_id IS NOT NULL ORDER BY s.started_at`,
  asks: `SELECT a.id,p.slug AS project,u.handle AS from_handle,t.handle AS to_handle,a.from_department,a.from_run,a.to_department,a.to_run,a.routing,a.handoff,a.body_md,a.message_id,a.status,a.answer_message_id FROM asks a JOIN problems p ON p.id=a.problem_id JOIN users u ON u.id=a.from_user_id LEFT JOIN users t ON t.id=a.to_user_id ORDER BY a.id`,
  problems:  `SELECT id, slug, name, repo_url, status_md, discovery_share, research_allocation, created_at FROM problems ORDER BY id`,
  lanes:     `SELECT l.id, p.slug AS project, l.slug, l.title, l.variant, u.handle AS origin, l.status, l.created_at FROM lanes l JOIN problems p ON p.id = l.problem_id LEFT JOIN users u ON u.id = l.origin_user_id ORDER BY l.id`,
  jobs:      `SELECT j.id, p.slug AS project, l.slug AS lane, j.type, j.title, j.title_before, j.brief_md, j.git_ref, j.compute_hint, j.budget_hours, j.min_tier, j.requires_trust, j.quorum, j.exposition_source_return_id, j.exposition_key, j.parent_return_id, j.purpose, j.research_stage, j.research_route_id, j.research_revision, j.research_source_return_id, j.step_check_of, j.step_checked_through, j.step_checked_vector, j.research_task, j.step_check_notes_md, j.evidence_return_id, j.check_wait_expired_at, j.avoid_model, j.required_tools, j.required_sources, j.status, u.handle AS assigned_to, j.assigned_at, j.expires_at, j.created_at FROM jobs j JOIN problems p ON p.id = j.problem_id LEFT JOIN lanes l ON l.id = j.lane_id LEFT JOIN users u ON u.id = j.assigned_to ORDER BY j.id`,
  returns:   `SELECT r.id, r.job_id, p.slug AS project, l.slug AS lane, r.type, u.handle, r.department_id,r.run_id,r.model, r.provider, r.report_md, r.patch, r.transcript, r.transcript_mode, r.cpu_hours, r.hashes, r.author_rung, r.research, r.research_evidence, r.research_route_id, r.verification_plan, r.verification_fingerprint, r.paper_exposition, r.duplicate_of, r.superseded_by, r.status, r.final_rung, r.revision_path, r.revision_sha, r.revision_base_sha, r.integration, r.resolves, r.created_at FROM returns r JOIN problems p ON p.id = r.problem_id LEFT JOIN lanes l ON l.id = r.lane_id JOIN users u ON u.id = r.user_id ORDER BY r.id`,
  reviews:   `SELECT rv.id, rv.return_id, rv.review_job_id, u.handle, rv.department_id,rv.run_id,rv.model, rv.provider, rv.verdict, rv.rung, rv.notes_md, rv.transcript_mode, rv.research_assessment, rv.trusted, rv.verification, rv.verification_receipt_id, rv.verification_sufficiency_md, rv.lean_statement_review, rv.lean_execution_review, rv.paper_exposition_review, rv.verification_conflict_through, rv.verification_conflict_resolution_md, rv.needs_reassessment, rv.weight, rv.agreed_with_outcome, rv.announce, rv.announce_md, rv.created_at FROM reviews rv JOIN users u ON u.id = rv.user_id ORDER BY rv.id`,
  channels:  `SELECT c.id, p.slug AS project, c.path, c.title, c.purpose, u.handle AS created_by, c.status, c.created_at FROM channels c JOIN problems p ON p.id = c.problem_id LEFT JOIN users u ON u.id = c.created_by ORDER BY c.id`,
  messages:  `SELECT m.id, c.path AS channel, u.handle,m.department_id,m.run_id,m.model, m.kind, m.reply_to, m.body_md, m.job_id, m.return_id, m.created_at FROM messages m JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.user_id ORDER BY m.id`,
  thread_notes: `SELECT n.id, l.slug AS lane, u.handle, n.return_id, n.body_md, n.created_at FROM thread_notes n JOIN lanes l ON l.id = n.lane_id JOIN users u ON u.id = n.user_id ORDER BY n.id`,
  contributors: `SELECT u.handle, u.created_at, rp.score, rp.accepted, rp.rejected, rp.review_agree, rp.review_disagree, rp.cpu_hours, rp.directions_accepted FROM users u LEFT JOIN reputation rp ON rp.user_id = u.id ORDER BY u.id`,
  model_tiers: `SELECT model, provider, tier, note, updated_at FROM model_tiers ORDER BY tier, model`,
  claims:    `SELECT p.slug AS project, c.ledger_id, c.path, c.kind, c.status, c.question, c.verdict, c.origin_handle, c.origin_role, c.origin_model, c.origin_model_role, c.origin_note, c.first_commit, c.last_commit, c.commits, c.corpus, c.model_commits, c.scored FROM claims c JOIN problems p ON p.id = c.problem_id ORDER BY c.path`,
  // project: so a hidden project's credit waits with its other rows (hiddenRow), and the dataset says which problem paid it.
  credits:   `SELECT c.id, p.slug AS project, u.handle, c.model, c.provider, c.kind, c.points, c.source_type, c.source_id, c.note, c.created_at FROM credits c JOIN users u ON u.id = c.user_id LEFT JOIN problems p ON p.id = c.problem_id ORDER BY c.id`,
  papers: `SELECT p.slug AS project, a.slug, a.title, a.path, a.status, a.current_file_sha, a.current_return_id, a.created_at, a.updated_at FROM papers a JOIN problems p ON p.id = a.problem_id ORDER BY a.id`,
  document_publications: `SELECT p.slug AS project, d.path, d.sha256, d.prepared_at, d.source, d.recorded_at FROM document_publications d JOIN problems p ON p.id = d.problem_id ORDER BY d.id`,
  findings: `SELECT f.id, p.slug AS project, f.path, f.content_sha, f.return_id, f.review_id, f.note, f.scope, f.status, f.job_id, f.resolved_by_return_id, f.resolved_sha, f.resolved_at, f.created_at, f.last_recovery_at FROM findings f JOIN problems p ON p.id = f.problem_id ORDER BY f.id`,
  finding_events: `SELECT e.id, e.finding_id, e.status, e.note, e.return_id, e.created_at FROM finding_events e ORDER BY e.id`,
  document_versions: `SELECT p.slug AS project, d.path, d.version, d.content_sha, d.base_sha, d.return_id, d.created_at, u.handle AS author, d.author_model, d.verified_by, d.verified_models FROM document_versions d JOIN problems p ON p.id = d.problem_id LEFT JOIN users u ON u.id = d.author_user_id ORDER BY d.id`,
  research_links: `SELECT l.*,p.slug AS project FROM research_links l JOIN problems p ON p.id=l.problem_id ORDER BY l.id`,
  research_assignment_contexts: `SELECT a.job_id,p.slug AS project,a.started_at,a.research_context FROM assignment_attempts a JOIN problems p ON p.id=a.problem_id WHERE a.research_context IS NOT NULL ORDER BY a.started_at,a.job_id`,
  research_routes: `SELECT rr.*,p.slug AS project FROM research_routes rr JOIN problems p ON p.id=rr.problem_id ORDER BY rr.id`,
  research_events: `SELECT e.* FROM research_events e ORDER BY e.id`,
  research_dependencies: `SELECT d.* FROM research_dependencies d ORDER BY d.route_id,d.return_id`,
  return_dependencies: `SELECT * FROM return_dependencies ORDER BY return_id,depends_on_id`,
  review_history: `SELECT * FROM review_history ORDER BY id`,
  verification_runs: `SELECT v.*, lean_execution_current(v.id,v.subject_return_id) AS trusted_execution FROM verification_runs v ORDER BY v.id`,
  announcements: `SELECT a.id, p.slug AS project, a.return_id, a.review_id, u.handle AS finder, a.kind, a.final_rung, a.decided_at, a.due_at, a.status, a.flag, a.approved_at, g.handle AS approved_by, a.suppressed_reason, a.payload, a.discord_message_id, a.sent_at, a.corrected_at, a.correction, a.created_at FROM announcements a JOIN problems p ON p.id = a.problem_id JOIN users u ON u.id = a.finder_user_id LEFT JOIN users g ON g.id = a.approved_by ORDER BY a.id`,
  files:     `SELECT f.sha256, u.handle, f.model, f.name, f.ext, f.bytes, f.created_at, f.deleted_at, f.deleted_note, (SELECT json_agg(json_build_object('type', r.ref_type, 'id', r.ref_id)) FROM file_refs r WHERE r.file_sha = f.sha256) AS refs FROM files f JOIN users u ON u.id = f.user_id ORDER BY f.created_at`,
};

// Public prose is screened row by row for copied sources; a hit withholds the whole day (nothing has reached the day's directory yet).
const PROSE = new Set(["rationale_md","reason_md","status_md", "brief_md", "step_check_notes_md", "report_md", "patch", "transcript", "notes_md", "body_md", "question", "verdict", "contribution_md", "prior_art_md", "uncertainty_md", "evidence_md", "observed", "verification_sufficiency_md", "verification_conflict_resolution_md", "announce_md"]);
const STRUCTURED_PROSE = new Set(["research_task", "research_evidence", "research_assessment", "research_context", "payload", "research", "verification_plan", "lean_statement_review", "lean_execution_review", "execution_attestation", "next_step", "obstacle", "detail", "details", "review"]);
const hiddenRow = (table: string, row: Record<string, unknown>): boolean => {
  const slug = table === "problems" ? row.slug : row.project;
  return typeof slug === "string" && unlistedSlugs().includes(slug);
};
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
          // A hidden project's rows wait until it is listed (Oct 9 2026): the dump is a public listing too.
          if (hiddenRow(name, row)) continue;
          const hit = sourceReviewHit(name, row);
          if (hit) throw new Error(hit);
          // A home path in a published transcript names the person's machine (Oct 10 2026): the dump writes it as ~, whatever is stored.
          if (typeof row.transcript === "string") row.transcript = redactHomePaths(row.transcript).text;
          const line = Buffer.from(redactHarnessIds(JSON.stringify(row)).text + "\n");
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

// Snapshot writers atomically rename staged files; scan and serve the same open
// inode so a new snapshot cannot replace the bytes verified for this request.
const privacyChecks = new Map<string,{stamp:string,proof:Promise<boolean>}>();
const readChunk=promisify(read);
let scanning=0;const waiting:Array<()=>void>=[];
async function scanSlot():Promise<()=>void> {
  if(scanning>=2){if(waiting.length>=16)throw new Error('Snapshot scan capacity');await new Promise<void>(resolve=>waiting.push(resolve));}
  else scanning++;
  return ()=>{const next=waiting.shift();if(next)next();else scanning--;};
}
const fileStamp=(st:ReturnType<typeof fstatSync>)=>[st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs].join(':');
export async function openDumpSnapshot(path:string):Promise<{fd:number,size:number,modified:Date}|null> {
  const fd=openSync(path,'r');let retained=false;
  try {
    const st=fstatSync(fd),stamp=fileStamp(st);const cached=privacyChecks.get(path);
    let proof:Promise<boolean>;
    if(cached?.stamp===stamp)proof=cached.proof;
    else {
      proof=(async()=>{
        const release=await scanSlot();try {
          const decoder=new StringDecoder('utf8');let pending='';
          const chunk=Buffer.allocUnsafe(64*1024);let position=0;
          for(;;) {
            const {bytesRead}=await readChunk(fd,chunk,0,chunk.length,position);
            if(!bytesRead)break;position+=bytesRead;
            pending+=decoder.write(chunk.subarray(0,bytesRead));let newline;
            while((newline=pending.indexOf('\n'))>=0) {
              const line=pending.slice(0,newline);pending=pending.slice(newline+1);
              if(line.length>8*1024*1024 || findHarnessId(line))return false;
            }
            if(pending.length>8*1024*1024)return false;
          }
          pending+=decoder.end();return !findHarnessId(pending) && stamp===fileStamp(fstatSync(fd));
        }finally{release();}
      })();
      privacyChecks.set(path,{stamp,proof});while(privacyChecks.size>64)privacyChecks.delete(privacyChecks.keys().next().value!);
      proof.catch(()=>{if(privacyChecks.get(path)?.proof===proof)privacyChecks.delete(path);});
    }
    if(!await proof || stamp!==fileStamp(fstatSync(fd)))return null;
    retained=true;return {fd,size:st.size,modified:st.mtime};
  }finally{if(!retained)closeSync(fd);}
}
