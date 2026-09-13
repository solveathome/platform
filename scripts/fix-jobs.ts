/**
 * Fix jobs on the record (Chris, Sep 12 2026: a fix is a job like any other).
 * 1. Re-derives `file_notes` on every return from its attached files and queues one "Fix files of return #N" job per return whose files
 *    will not run as shipped (kept: notes already marked fixed_by), through the same spawn as intake (never for a fix return, never for a
 *    file already noted elsewhere), and closes queued fix jobs whose notes no longer stand. Idempotent: one open job per return.
 * 2. `--review <id> --path <served path>` (repeatable pairs): opens an audit fix job for a served file from a review that recorded the fix in
 *    its notes before also_fix opened jobs; the review's notes are the brief. One open job per file.
 *   bash scripts/prod-exec.sh node dist/scripts/fix-jobs.js --review 48 --path research/localized-04-maxsum.js --review 49 --path research/maxgap-law.js
 */
import { q, one, pool } from "../src/db/index.js";
import * as files from "../src/lib/files.js";
import { spawnFixJob, spawnFileFixJob, FILE_FIX_TITLE } from "../src/routes/job.js";

const args = process.argv.slice(2);
const pairs: { review: number; path: string }[] = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--review") pairs.push({ review: Number(args[i + 1]), path: String(args[i + 3] ?? "") });

const rows = await q<any>(`SELECT r.id, r.type, r.problem_id, r.lane_id, r.job_id, j.title AS job_title, r.file_notes, f.sha256, f.name FROM returns r JOIN file_refs x ON x.ref_type = 'return' AND x.ref_id = r.id JOIN files f ON f.sha256 = x.file_sha LEFT JOIN jobs j ON j.id = r.job_id WHERE f.deleted_at IS NULL ORDER BY r.id`);
const byReturn = new Map<number, { ret: any; notes: { sha: string; name: string; notes: string[]; fixed_by?: string }[] }>();
for (const r of rows) {
  const e = byReturn.get(Number(r.id)) ?? { ret: r, notes: [] }; byReturn.set(Number(r.id), e);
  const prior = (Array.isArray(r.file_notes) ? r.file_notes : []).find((n: any) => n.sha === r.sha256);
  const notes = files.portabilityNotes(r.name, files.read(r.sha256) ?? "");
  if (notes.length) e.notes.push({ sha: r.sha256, name: r.name, notes, ...(prior?.fixed_by ? { fixed_by: prior.fixed_by } : {}) });
}
let spawned = 0, closed = 0;
// Notes first, so the shared dedupe (a file already noted on another return) sees the re-derived record, then jobs.
for (const [id, e] of byReturn) await q(`UPDATE returns SET file_notes = $2 WHERE id = $1`, [id, e.notes.length ? JSON.stringify(e.notes) : null]);
for (const [id, e] of byReturn) {
  const remaining = e.notes.filter((n) => !n.fixed_by);
  if (!remaining.length) {
    // The detection no longer stands (a tightened heuristic, or the file was replaced): a queued fix job for it is closed, an assigned one runs out.
    const j = await one<{ id: string }>(`UPDATE jobs SET status = 'expired', last_release_note = 'the files no longer carry a defect the server detects' WHERE follow_up_of = $1 AND title LIKE $2 AND status = 'queued' RETURNING id`, [id, `${FILE_FIX_TITLE}%`]);
    if (j) { closed++; console.log(`return #${id}: fix job #${j.id} closed, nothing left to fix`); }
    continue;
  }
  const jid = await spawnFileFixJob({ id, type: e.ret.type, problem_id: Number(e.ret.problem_id), lane_id: e.ret.lane_id === null ? null : Number(e.ret.lane_id), job_id: e.ret.job_id === null ? null : Number(e.ret.job_id), job_title: e.ret.job_title ?? null }, remaining);
  const isNew = jid && !(await one(`SELECT 1 FROM jobs WHERE id = $1 AND created_at < now() - interval '10 seconds'`, [jid]));
  if (isNew) { spawned++; console.log(`return #${id}: fix job #${jid} queued for ${remaining.map((f) => f.name).join(", ")}`); }
}
console.log(`file notes re-derived on ${byReturn.size} returns with files; ${spawned} fix job(s) queued, ${closed} closed`);
for (const p of pairs) {
  const rv = await one<any>(`SELECT rv.id, rv.return_id, rv.notes_md, u.handle, rt.problem_id, rt.lane_id, pr.slug FROM reviews rv JOIN users u ON u.id = rv.user_id JOIN returns rt ON rt.id = rv.return_id JOIN problems pr ON pr.id = rt.problem_id WHERE rv.id = $1`, [p.review]);
  if (!rv) { console.log(`review #${p.review}: not found`); continue; }
  const jid = await spawnFixJob(Number(rv.problem_id), rv.lane_id === null ? null : Number(rv.lane_id), rv.slug, p.path, `(from the review's notes)\n\n${String(rv.notes_md ?? "").slice(0, 6000)}`, { reviewId: Number(rv.id), returnId: Number(rv.return_id), handle: rv.handle });
  console.log(`review #${p.review} → ${p.path}: ${jid ? `fix job #${jid}` : "not a served file; nothing queued"}`);
}
await pool.end();
