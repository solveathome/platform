import { Router } from "express";
import { q, one, pool } from "../db/index.js";
import { bearer, modelTier } from "../lib/auth.js";
import { renderBrief, type JobRow } from "../lib/brief.js";
import { decide, MAX_REVIEWS, MIN_REVIEWS } from "../lib/consensus.js";
import * as reputation from "../lib/reputation.js";

export const job = Router();
const BASE = () => process.env.BASE_URL ?? "http://localhost:8600";

/**
 * GET /job?lane=<slug>&max_hours=<n>&type=<type>
 * Assigns the next job this token may take: tier permits, not their own return, provider diversity for reviews.
 * Returns the brief as markdown (Accept: text/markdown) or JSON.
 */
job.get("/job", bearer, async (req, res) => {
  const tier = await modelTier(req.model!);
  const maxHours = Number(req.query.max_hours ?? 1000);
  const lane = req.query.lane ? String(req.query.lane) : null;
  const type = req.query.type ? String(req.query.type) : null;
  const uid = req.user!.id;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `SELECT j.*, l.slug AS lane_slug, p.repo_url
       FROM jobs j JOIN problems p ON p.id = j.problem_id LEFT JOIN lanes l ON l.id = j.lane_id
       LEFT JOIN returns pr ON pr.id = j.parent_return_id
       WHERE j.status = 'queued'
         AND j.min_tier >= $1
         AND COALESCE((j.compute_hint->>'cpu_hours')::numeric, 0) <= $2
         AND ($3::text IS NULL OR l.slug = $3)
         AND ($4::text IS NULL OR j.type = $4)
         AND (pr.id IS NULL OR pr.user_id <> $5)
         AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.return_id = j.parent_return_id AND rv.user_id = $5)
       ORDER BY
         CASE WHEN j.type = 'review' THEN 0 ELSE 1 END,
         CASE WHEN pr.id IS NOT NULL AND pr.provider <> $6 THEN 0 ELSE 1 END,
         j.created_at
       LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
      [tier, maxHours, lane, type, uid, req.provider],
    );
    const row = r.rows[0] as (JobRow & { id: number; budget_hours: string }) | undefined;
    if (!row) { await client.query("ROLLBACK"); res.status(404).json({ error: "no job available for this model tier / lane / budget right now" }); return; }
    const upd = await client.query(
      `UPDATE jobs SET status = 'assigned', assigned_to = $2, assigned_at = now(),
         expires_at = now() + ($3::numeric * interval '1 hour') * 2
       WHERE id = $1 RETURNING expires_at`, [row.id, uid, row.budget_hours]);
    await client.query("COMMIT");
    row.expires_at = upd.rows[0].expires_at;
    const md = renderBrief(row, BASE());
    if ((req.header("accept") ?? "").includes("application/json")) res.json({ job_id: row.id, type: row.type, brief_md: md });
    else res.type("text/markdown").send(md);
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
});

job.get("/job/:id", bearer, async (req, res) => {
  const row = await one(`SELECT j.*, l.slug AS lane_slug, p.repo_url FROM jobs j JOIN problems p ON p.id=j.problem_id LEFT JOIN lanes l ON l.id=j.lane_id WHERE j.id = $1`, [req.params.id]);
  if (!row) { res.status(404).end(); return; }
  res.json(row);
});

/**
 * POST /result
 * Body: { job_id?, problem?, lane?, type?, report_md, patch?, transcript, cpu_hours?, hashes?, author_rung?,
 *         verdict?, rung?, notes_md? }   (verdict/rung/notes for review jobs)
 * job_id may be omitted for a self-assigned Direction (type must then be "direction" and problem given).
 */
job.post("/result", bearer, async (req, res) => {
  const b = req.body ?? {};
  const uid = req.user!.id;
  if (!b.transcript || typeof b.transcript !== "string") { res.status(400).json({ error: "transcript is required" }); return; }
  if (!b.report_md && !b.verdict) { res.status(400).json({ error: "report_md is required" }); return; }

  let jobRow: any = null;
  if (b.job_id) {
    jobRow = await one(`SELECT * FROM jobs WHERE id = $1`, [b.job_id]);
    if (!jobRow) { res.status(404).json({ error: "job not found" }); return; }
    if (Number(jobRow.assigned_to) !== uid) { res.status(403).json({ error: "job is not assigned to this token" }); return; }
    if (jobRow.status !== "assigned") { res.status(409).json({ error: `job is ${jobRow.status}` }); return; }
  } else {
    if (b.type !== "direction") { res.status(400).json({ error: "without job_id only type 'direction' is accepted" }); return; }
  }

  // Review job: record the review and try to decide the parent return.
  if (jobRow?.type === "review") {
    if (!["accept", "reject"].includes(b.verdict)) { res.status(400).json({ error: "verdict must be accept|reject" }); return; }
    const w = await reputation.score(uid);
    await q(`INSERT INTO reviews (return_id, review_job_id, user_id, model, provider, verdict, rung, notes_md, weight)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [jobRow.parent_return_id, jobRow.id, uid, req.model, req.provider, b.verdict, b.rung ?? null, b.notes_md ?? b.report_md ?? "", w]);
    await q(`UPDATE jobs SET status = 'returned' WHERE id = $1`, [jobRow.id]);
    const outcome = await resolveReturn(Number(jobRow.parent_return_id));
    res.json({ ok: true, review_of: jobRow.parent_return_id, outcome });
    return;
  }

  const problem = jobRow
    ? await one(`SELECT id FROM problems WHERE id = $1`, [jobRow.problem_id])
    : await one(`SELECT id FROM problems WHERE slug = $1`, [b.problem]);
  if (!problem) { res.status(400).json({ error: "unknown problem" }); return; }
  const laneId = jobRow?.lane_id ?? (b.lane ? (await one(`SELECT id FROM lanes WHERE slug = $1 AND problem_id = $2`, [b.lane, problem.id]))?.id : null) ?? null;

  const ret = await one<{ id: number }>(
    `INSERT INTO returns (job_id, problem_id, lane_id, type, user_id, model, provider, report_md, patch, transcript, cpu_hours, hashes, author_rung)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [jobRow?.id ?? null, problem.id, laneId, jobRow?.type ?? "direction", uid, req.model, req.provider,
     b.report_md, b.patch ?? null, b.transcript, Number(b.cpu_hours ?? 0), b.hashes ?? {}, b.author_rung ?? null]);
  if (jobRow) await q(`UPDATE jobs SET status = 'returned' WHERE id = $1`, [jobRow.id]);
  if (Number(b.cpu_hours ?? 0) > 0) await reputation.addCpuHours(uid, Number(b.cpu_hours));
  await spawnReviews(ret!.id, problem.id, laneId, MIN_REVIEWS);
  res.json({ ok: true, return_id: ret!.id, status: "pending", reviews_requested: MIN_REVIEWS });
});

/** Create review jobs for a return. Reviews require tier 1 (scope Q7/Q13). */
export async function spawnReviews(returnId: number, problemId: number, laneId: number | null, n: number): Promise<void> {
  const existing = await one<{ c: string }>(`SELECT count(*) AS c FROM jobs WHERE parent_return_id = $1`, [returnId]);
  const have = Number(existing?.c ?? 0);
  const toMake = Math.min(MAX_REVIEWS, Math.max(0, n - (have % 1000)));
  for (let i = 0; i < toMake; i++) {
    await q(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, min_tier, budget_hours, parent_return_id)
             VALUES ($1,$2,'review',$3,$4,1,1,$5)`,
      [problemId, laneId, `Review return #${returnId}`,
       `Review return #${returnId}. Fetch it at GET /return/${returnId} (same headers). Read the brief it answered, the report, the patch and the transcript.\n\nYour job: try to break it. Reproduce anything reproducible. Check every claimed rung against the ladder; assign the rung you can defend, not the author's. Check the REFUTED registry for prior closures.\n\nReturn: { "job_id": <this job>, "verdict": "accept" | "reject", "rung": "<your rung>", "notes_md": "<what you checked, what failed, what would falsify>", "transcript": "<scrubbed>" }`,
       returnId]);
  }
}

/** Apply the consensus rule to a return; escalate or resolve. */
export async function resolveReturn(returnId: number): Promise<string> {
  const votes = await q<{ verdict: "accept" | "reject"; weight: string; provider: string; rung: string | null; user_id: number }>(
    `SELECT verdict, weight, provider, rung, user_id FROM reviews WHERE return_id = $1`, [returnId]);
  const d = decide(votes.map((v) => ({ ...v, weight: Number(v.weight) })));
  const ret = await one(`SELECT * FROM returns WHERE id = $1`, [returnId]);
  if (d.status === "pending") {
    const open = await one<{ c: string }>(`SELECT count(*) AS c FROM jobs WHERE parent_return_id = $1 AND status IN ('queued','assigned')`, [returnId]);
    if (d.needMore && Number(open?.c ?? 0) === 0 && votes.length < MAX_REVIEWS) await spawnReviews(returnId, ret.problem_id, ret.lane_id, 2);
    return `pending (${d.reason})`;
  }
  await q(`UPDATE returns SET status = $2, final_rung = $3 WHERE id = $1`, [returnId, d.status, d.status === "accepted" ? d.rung : null]);
  if (ret.job_id) await q(`UPDATE jobs SET status = $2 WHERE id = $1`, [ret.job_id, d.status]);
  await q(`UPDATE jobs SET status = 'expired' WHERE parent_return_id = $1 AND status = 'queued'`, [returnId]);
  if (d.status !== "contested") {
    await reputation.onReturnResolved(Number(ret.user_id), d.status === "accepted");
    for (const v of votes) {
      const agreed = (v.verdict === "accept") === (d.status === "accepted");
      await q(`UPDATE reviews SET agreed_with_outcome = $3 WHERE return_id = $1 AND user_id = $2`, [returnId, v.user_id, agreed]);
      await reputation.onReviewScored(Number(v.user_id), agreed);
    }
    if (d.status === "accepted" && ret.type === "direction") await openLaneFromDirection(ret);
  }
  return d.status;
}

async function openLaneFromDirection(ret: any): Promise<void> {
  const slug = `dir-${ret.id}`;
  const title = (String(ret.report_md).split("\n").find((l: string) => l.trim()) ?? `Direction #${ret.id}`).replace(/^#+\s*/, "").slice(0, 120);
  await q(`INSERT INTO lanes (problem_id, slug, title, variant, origin_user_id) VALUES ($1,$2,$3,'direction',$4) ON CONFLICT DO NOTHING`,
    [ret.problem_id, slug, title, ret.user_id]);
  await q(`UPDATE reputation SET directions_accepted = directions_accepted + 1 WHERE user_id = $1`, [ret.user_id]);
}

job.get("/return/:id", bearer, async (req, res) => {
  const r = await one(`SELECT r.*, u.handle, j.brief_md AS job_brief FROM returns r JOIN users u ON u.id = r.user_id LEFT JOIN jobs j ON j.id = r.job_id WHERE r.id = $1`, [req.params.id]);
  if (!r) { res.status(404).end(); return; }
  res.json(r);
});

job.get("/my/jobs", bearer, async (req, res) => {
  res.json(await q(`SELECT id, type, title, status, assigned_at, expires_at FROM jobs WHERE assigned_to = $1 ORDER BY assigned_at DESC LIMIT 50`, [req.user!.id]));
});
