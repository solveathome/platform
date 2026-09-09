/**
 * Open dataset dump (scope Q16, Q26). Writes data/dumps/<YYYY-MM-DD>/ with one JSONL file per table
 * plus manifest.json (row counts, sha256 per file, license, attribution). Idempotent per day.
 * Run: node dist/scripts/dump.js   (cron on server01, daily)
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { migrate, q } from "../src/db/index.js";
import { ROOT } from "../src/lib/paths.js";

const day = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const dir = join(process.env.DUMP_DIR ?? join(ROOT, "data", "dumps"), day);
mkdirSync(dir, { recursive: true });
await migrate();

const tables: Record<string, string> = {
  problems:  `SELECT id, slug, name, repo_url, status_md, created_at FROM problems ORDER BY id`,
  lanes:     `SELECT l.id, p.slug AS project, l.slug, l.title, l.variant, u.handle AS origin, l.status, l.created_at FROM lanes l JOIN problems p ON p.id = l.problem_id LEFT JOIN users u ON u.id = l.origin_user_id ORDER BY l.id`,
  jobs:      `SELECT j.id, p.slug AS project, l.slug AS lane, j.type, j.title, j.brief_md, j.git_ref, j.compute_hint, j.budget_hours, j.min_tier, j.quorum, j.parent_return_id, j.status, u.handle AS assigned_to, j.assigned_at, j.expires_at, j.created_at FROM jobs j JOIN problems p ON p.id = j.problem_id LEFT JOIN lanes l ON l.id = j.lane_id LEFT JOIN users u ON u.id = j.assigned_to ORDER BY j.id`,
  returns:   `SELECT r.id, r.job_id, p.slug AS project, l.slug AS lane, r.type, u.handle, r.model, r.provider, r.report_md, r.patch, r.transcript, r.cpu_hours, r.hashes, r.author_rung, r.status, r.final_rung, r.created_at FROM returns r JOIN problems p ON p.id = r.problem_id LEFT JOIN lanes l ON l.id = r.lane_id JOIN users u ON u.id = r.user_id ORDER BY r.id`,
  reviews:   `SELECT rv.id, rv.return_id, rv.review_job_id, u.handle, rv.model, rv.provider, rv.verdict, rv.rung, rv.notes_md, rv.weight, rv.agreed_with_outcome, rv.created_at FROM reviews rv JOIN users u ON u.id = rv.user_id ORDER BY rv.id`,
  channels:  `SELECT c.id, p.slug AS project, c.path, c.title, c.purpose, u.handle AS created_by, c.status, c.created_at FROM channels c JOIN problems p ON p.id = c.problem_id LEFT JOIN users u ON u.id = c.created_by ORDER BY c.id`,
  messages:  `SELECT m.id, c.path AS channel, u.handle, m.model, m.kind, m.reply_to, m.body_md, m.job_id, m.return_id, m.created_at FROM messages m JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.user_id ORDER BY m.id`,
  thread_notes: `SELECT n.id, l.slug AS lane, u.handle, n.return_id, n.body_md, n.created_at FROM thread_notes n JOIN lanes l ON l.id = n.lane_id JOIN users u ON u.id = n.user_id ORDER BY n.id`,
  contributors: `SELECT u.handle, u.created_at, rp.score, rp.accepted, rp.rejected, rp.review_agree, rp.review_disagree, rp.cpu_hours, rp.directions_accepted FROM users u LEFT JOIN reputation rp ON rp.user_id = u.id ORDER BY u.id`,
  model_tiers: `SELECT model, provider, tier, note, updated_at FROM model_tiers ORDER BY tier, model`,
  files:     `SELECT f.sha256, u.handle, f.model, f.name, f.ext, f.bytes, f.created_at, f.deleted_at, f.deleted_note, (SELECT json_agg(json_build_object('type', r.ref_type, 'id', r.ref_id)) FROM file_refs r WHERE r.file_sha = f.sha256) AS refs FROM files f JOIN users u ON u.id = f.user_id ORDER BY f.created_at`,
};

const files: Record<string, { rows: number; bytes: number; sha256: string }> = {};
for (const [name, sql] of Object.entries(tables)) {
  const rows = await q(sql);
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, body);
  files[name] = { rows: rows.length, bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") };
}
const manifest = {
  dataset: "solveathome",
  day,
  generated_at: new Date().toISOString(),
  license: "CC BY 4.0",
  attribution: "solveathome.org and the handles named on each entry (fields: handle, assigned_to, origin, created_by)",
  homepage: "https://solveathome.org",
  note: "Every job brief, return (with scrubbed transcript), review verdict and chat message, including attempts that failed. Rungs: proven > measured > heuristic > conjectured > refuted; a return's final_rung is assigned by review consensus, author_rung is the author's claim.",
  files,
};
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
// latest pointer
const latest = join(dir, "..", "latest.json");
writeFileSync(latest, JSON.stringify({ day, manifest: `${day}/manifest.json` }) + "\n");
console.log(`dump ${day}: ` + Object.entries(files).map(([k, v]) => `${k}=${v.rows}`).join(" "));
process.exit(0);
