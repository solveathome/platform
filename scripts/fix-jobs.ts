/**
 * Fix jobs on the record (Chris, Sep 12 2026: a fix is a job like any other).
 * 1. Re-derives `file_notes` on every return from its attached files and queues one "Fix files of return #N" job per return whose files
 *    will not run as shipped (kept: notes already marked fixed_by). Idempotent: one open job per return.
 * 2. `--review <id> --path <served path>` (repeatable pairs): opens an audit fix job for a served file from a review that recorded the fix in
 *    its notes before also_fix opened jobs; the review's notes are the brief. One open job per file.
 *   bash scripts/prod-exec.sh node dist/scripts/fix-jobs.js --review 48 --path research/localized-04-maxsum.js --review 49 --path research/maxgap-law.js
 */
import { q, one, pool } from "../src/db/index.js";
import * as files from "../src/lib/files.js";
import { spawnFixJob } from "../src/routes/job.js";

const args = process.argv.slice(2);
const pairs: { review: number; path: string }[] = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--review") pairs.push({ review: Number(args[i + 1]), path: String(args[i + 3] ?? "") });

const rows = await q<any>(`SELECT r.id, r.type, r.problem_id, r.lane_id, r.job_id, r.file_notes, f.sha256, f.name FROM returns r JOIN file_refs x ON x.ref_type = 'return' AND x.ref_id = r.id JOIN files f ON f.sha256 = x.file_sha WHERE f.deleted_at IS NULL ORDER BY r.id`);
const byReturn = new Map<number, { ret: any; notes: { sha: string; name: string; notes: string[]; fixed_by?: string }[] }>();
for (const r of rows) {
  const e = byReturn.get(Number(r.id)) ?? { ret: r, notes: [] }; byReturn.set(Number(r.id), e);
  const prior = (Array.isArray(r.file_notes) ? r.file_notes : []).find((n: any) => n.sha === r.sha256);
  const notes = files.portabilityNotes(r.name, files.read(r.sha256) ?? "");
  if (notes.length) e.notes.push({ sha: r.sha256, name: r.name, notes, ...(prior?.fixed_by ? { fixed_by: prior.fixed_by } : {}) });
}
let spawned = 0;
for (const [id, e] of byReturn) {
  await q(`UPDATE returns SET file_notes = $2 WHERE id = $1`, [id, e.notes.length ? JSON.stringify(e.notes) : null]);
  const remaining = e.notes.filter((n) => !n.fixed_by);
  if (!remaining.length) continue;
  if (await one(`SELECT 1 FROM jobs WHERE follow_up_of = $1 AND title LIKE 'Fix files of return %' AND status IN ('queued','assigned')`, [id])) continue;
  const P = "<project base>";
  const brief = `Return #${id} (${e.ret.type}, ${P}/return/${id}) carries ${remaining.length === 1 ? "a file" : "files"} that will not run or reproduce as shipped, as the server detected:
${remaining.map((f) => `- ${f.name} (GET /files/${f.sha}): ${f.notes.join(" ")}`).join("\n")}

Fix ${remaining.length === 1 ? "it" : "them"}; do not redo the work. Upload a corrected copy of each file under the same name (POST /files; paths relative to the repository, progress and timing to stderr), run it from a fresh directory against the served scripts to check it works, and return as this job with the new sha(s) in \`files\`, \`"cites": { "returns": [${id}] }\`, a recipe that runs the corrected file, and a one-line report of what changed. The original return keeps its record; yours carries the working copy.`;
  await q(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, follow_up_of) VALUES ($1,$2,$3,$4,$5,'main','{}',1,99,1,$6)`,
    [e.ret.problem_id, e.ret.lane_id, e.ret.type, `Fix files of return #${id}: ${remaining.map((f) => f.name).join(", ")}`.slice(0, 200), brief, id]);
  spawned++; console.log(`return #${id}: fix job queued for ${remaining.map((f) => f.name).join(", ")}`);
}
console.log(`file notes re-derived on ${byReturn.size} returns with files; ${spawned} fix job(s) queued`);
for (const p of pairs) {
  const rv = await one<any>(`SELECT rv.id, rv.return_id, rv.notes_md, u.handle, rt.problem_id, rt.lane_id, pr.slug FROM reviews rv JOIN users u ON u.id = rv.user_id JOIN returns rt ON rt.id = rv.return_id JOIN problems pr ON pr.id = rt.problem_id WHERE rv.id = $1`, [p.review]);
  if (!rv) { console.log(`review #${p.review}: not found`); continue; }
  const jid = await spawnFixJob(Number(rv.problem_id), rv.lane_id === null ? null : Number(rv.lane_id), rv.slug, p.path, `(from the review's notes)\n\n${String(rv.notes_md ?? "").slice(0, 6000)}`, { reviewId: Number(rv.id), returnId: Number(rv.return_id), handle: rv.handle });
  console.log(`review #${p.review} → ${p.path}: ${jid ? `fix job #${jid}` : "not a served file; nothing queued"}`);
}
await pool.end();
