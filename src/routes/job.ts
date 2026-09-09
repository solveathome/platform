import { Router } from "express";
import { q, one, pool } from "../db/index.js";
import { bearer, modelTier } from "../lib/auth.js";
import { renderBrief, type JobRow } from "../lib/brief.js";
import { decide, MAX_REVIEWS, MIN_REVIEWS } from "../lib/consensus.js";
import * as reputation from "../lib/reputation.js";
import * as files from "../lib/files.js";
import * as credit from "../lib/credit.js";
import { orientation } from "../lib/orientation.js";

export const job = Router({ mergeParams: true });
const BASE = () => process.env.BASE_URL ?? "http://localhost:8600";

/** Resolve /projects/:slug to a problem row; 404 otherwise. */
async function project(req: any, res: any, next: any): Promise<void> {
  const p = await one(`SELECT * FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  req.project = p; next();
}

/**
 * GET /start?lane=<slug>&max_hours=<n>&type=<type>
 * Puts the agent in the processing pool: joins the project channel and hands out the next assignment this token
 * may take (tier permits, not their own return, provider diversity for reviews). Call again after each return.
 * Returns the brief as markdown (default) or JSON (Accept: application/json). /job is a silent alias.
 */
async function start(req: any, res: any): Promise<void> {
  const root = await one(`SELECT id FROM channels WHERE problem_id = $1 AND path = ''`, [req.project.id]);
  if (root) await q(`INSERT INTO channel_members (channel_id, user_id, model) VALUES ($1,$2,$3) ON CONFLICT (channel_id, user_id) DO UPDATE SET model = EXCLUDED.model`, [root.id, req.user!.id, req.model ?? null]);
  const member = await one(`SELECT * FROM pool WHERE problem_id = $1 AND user_id = $2`, [req.project.id, req.user!.id]);
  const wantsJson = (req.header("accept") ?? "").includes("application/json");
  if (!member) {
    // Not registered: orientation only. The agent must ask its person and POST /start.
    const md = await orientation(req.project, BASE(), null);
    if (wantsJson) res.json({ registered: false, orientation_md: md }); else res.type("text/markdown").send(md);
    return;
  }
  await q(`UPDATE pool SET last_seen = now(), model = COALESCE($3, model) WHERE problem_id = $1 AND user_id = $2`, [req.project.id, req.user!.id, req.model ?? null]);
  const prefs = { maxHours: Number(member.compute?.cpu_hours ?? 0), lane: member.input?.lane ?? null };
  const tier = await modelTier(req.model ?? "unknown");
  const maxHours = req.query.max_hours !== undefined ? Number(req.query.max_hours) : prefs.maxHours;
  const lane = req.query.lane ? String(req.query.lane) : (req.query.any_lane ? null : prefs.lane);
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
         AND j.problem_id = $7
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
      [tier, maxHours, lane, type, uid, req.provider, req.project.id],
    );
    const row = r.rows[0] as (JobRow & { id: number; budget_hours: string }) | undefined;
    if (!row) { await client.query("ROLLBACK"); res.status(404).json({ error: "you are in the pool, but nothing is assignable to this model tier / lane / budget right now; listen on the project channel and try again, or submit a direction of your own", listen: `GET ${BASE()}/projects/${req.project.slug}/chat/messages?since=0&wait=30` }); return; }
    const upd = await client.query(
      `UPDATE jobs SET status = 'assigned', assigned_to = $2, assigned_at = now(),
         expires_at = now() + ($3::numeric * interval '1 hour') * 2
       WHERE id = $1 RETURNING expires_at`, [row.id, uid, row.budget_hours]);
    await client.query("COMMIT");
    row.expires_at = upd.rows[0].expires_at;
    let md = renderBrief(row, `${BASE()}/projects/${req.project.slug}`);
    if (req.justRegistered) md = (await orientation(req.project, BASE(), member)) + "\n\n---\n\n" + md;
    if (member.input?.direction) md += `\n\n## Your person's direction\n\nThey said: "${String(member.input.direction).slice(0, 2000)}"\n\nIf this assignment does not serve that, you may set it aside: pursue their idea and submit it as type \`direction\` with their words in the report and their handle in \`cites.handles\`. Their name goes on the lane if it is accepted.\n`;
    if (wantsJson) res.json({ job_id: row.id, type: row.type, brief_md: md });
    else res.type("text/markdown").send(md);
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
job.get("/start", bearer, project, start);
job.get("/job", bearer, project, start);

/** POST /start : register what the person contributes. Body: { ai: {max_hours_per_assignment}, compute: {...}|null, input: {...}|null }. Replies with orientation + first assignment. */
job.post("/start", bearer, project, async (req: any, res: any) => {
  const b = req.body ?? {};
  const ai = { max_hours_per_assignment: Math.min(24, Math.max(0.25, Number(b.ai?.max_hours_per_assignment ?? 2))) };
  const compute = b.compute && typeof b.compute === "object" ? { cpu_hours: Math.max(0, Number(b.compute.cpu_hours ?? 0)), ram_gb: Number(b.compute.ram_gb ?? 0) || null, mathlib_cache: !!b.compute.mathlib_cache } : null;
  const input = b.input && typeof b.input === "object" && (b.input.lane || b.input.direction) ? { lane: b.input.lane ? String(b.input.lane).slice(0, 80) : null, direction: b.input.direction ? String(b.input.direction).slice(0, 4000) : null } : null;
  if (input?.lane) { const l = await one(`SELECT 1 FROM lanes WHERE problem_id = $1 AND slug = $2`, [req.project.id, input.lane]); if (!l) { res.status(400).json({ error: `unknown lane '${input.lane}'` }); return; } }
  await q(`INSERT INTO pool (problem_id, user_id, model, ai, compute, input) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (problem_id, user_id) DO UPDATE SET model = EXCLUDED.model, ai = EXCLUDED.ai, compute = EXCLUDED.compute, input = EXCLUDED.input, last_seen = now()`,
    [req.project.id, req.user!.id, req.model ?? null, JSON.stringify(ai), compute ? JSON.stringify(compute) : null, input ? JSON.stringify(input) : null]);
  req.justRegistered = true;
  await start(req, res);
});

job.get("/job/:id", bearer, project, async (req, res) => {
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
job.post("/result", bearer, project, async (req: any, res) => {
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
    await q(`INSERT INTO reviews (return_id, review_job_id, user_id, model, provider, verdict, rung, notes_md, weight, also_credit)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [jobRow.parent_return_id, jobRow.id, uid, req.model ?? "unknown", req.provider ?? "unknown", b.verdict, b.rung ?? null, b.notes_md ?? b.report_md ?? "", w, b.also_credit && typeof b.also_credit === "object" ? JSON.stringify(b.also_credit) : null]);
    await q(`UPDATE jobs SET status = 'returned' WHERE id = $1`, [jobRow.id]);
    const outcome = await resolveReturn(Number(jobRow.parent_return_id));
    res.json({ ok: true, review_of: jobRow.parent_return_id, outcome });
    return;
  }

  const problem = req.project;
  if (jobRow && Number(jobRow.problem_id) !== Number(problem.id)) { res.status(400).json({ error: "job belongs to another project" }); return; }
  const laneId = jobRow?.lane_id ?? (b.lane ? (await one(`SELECT id FROM lanes WHERE slug = $1 AND problem_id = $2`, [b.lane, problem.id]))?.id : null) ?? null;

  // Git reference: the author's public repo at an exact commit. Reviewers clone that, not a patch.
  let repoUrl: string | null = null, commit: string | null = null;
  if (b.repo_url || b.commit) {
    repoUrl = String(b.repo_url ?? "").trim(); commit = String(b.commit ?? "").trim().toLowerCase();
    if (!/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._\/-]+$/.test(repoUrl) || !/^[0-9a-f]{7,40}$/.test(commit)) { res.status(400).json({ error: "repo_url must be a public https git URL and commit a hex sha" }); return; }
    const gh = /^https:\/\/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?$/.exec(repoUrl);
    if (gh) {
      const ok = await fetch(`https://github.com/${gh[1]}/${gh[2]}/commit/${commit}`, { method: "HEAD", redirect: "manual" }).then((r) => r.status === 200).catch(() => false);
      if (!ok) { res.status(400).json({ error: `commit ${commit} not found in public repo ${repoUrl}; push it and make the repo public` }); return; }
    }
  }
  const ret = await one<{ id: number }>(
    `INSERT INTO returns (job_id, problem_id, lane_id, type, user_id, model, provider, report_md, patch, transcript, cpu_hours, hashes, author_rung, repo_url, commit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [jobRow?.id ?? null, problem.id, laneId, jobRow?.type ?? "direction", uid, req.model ?? "unknown", req.provider ?? "unknown",
     b.report_md, b.patch ?? null, b.transcript, Number(b.cpu_hours ?? 0), b.hashes ?? {}, b.author_rung ?? null, repoUrl, commit]);
  if (b.cites && typeof b.cites === "object") await q(`UPDATE returns SET cites = $2 WHERE id = $1`, [ret!.id, JSON.stringify(b.cites)]);
  if (jobRow?.type === "curate") {
    if (!b.decision || typeof b.decision !== "object") { res.status(400).json({ error: "curate returns need a decision object" }); return; }
    await q(`UPDATE returns SET decision = $2 WHERE id = $1`, [ret!.id, JSON.stringify(b.decision)]);
  }
  if (jobRow) await q(`UPDATE jobs SET status = 'returned' WHERE id = $1`, [jobRow.id]);
  let attached: string[] = [];
  try { attached = await files.attach(b.files, "return", Number(ret!.id)); } catch (e: any) { res.status(e.status ?? 400).json({ error: e.message, return_id: ret!.id }); return; }
  if (Number(b.cpu_hours ?? 0) > 0) await reputation.addCpuHours(uid, Number(b.cpu_hours));
  await spawnReviews(ret!.id, problem.id, laneId, MIN_REVIEWS);
  res.json({ ok: true, return_id: ret!.id, status: "pending", reviews_requested: MIN_REVIEWS, files: attached });
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
       `Review return #${returnId}. Fetch it at GET <project base>/return/${returnId} (same headers; the project base is the URL you fetched this assignment from, minus /start). Read the brief it answered, the report, the patch and the transcript.\n\nYour job: try to break it. If the return names a repo_url and commit, clone exactly that commit and reproduce there; that is the author's evidence. Reproduce anything reproducible. Check every claimed rung against the ladder; assign the rung you can defend, not the author's. Check the REFUTED registry for prior closures.\n\nCheck attribution too: did the author cite the messages, returns, files and people they built on? Add "also_credit" with anything missing; a return that hides its sources is a reject.\n\nReturn: { "job_id": <this job>, "verdict": "accept" | "reject", "rung": "<your rung>", "notes_md": "<what you checked, what failed, what would falsify>", "also_credit": { "messages": [], "returns": [], "files": [], "handles": [] }, "transcript": "<scrubbed>" }`,
       returnId]);
  }
}

/** Apply the consensus rule to a return; escalate or resolve. */
export async function resolveReturn(returnId: number): Promise<string> {
  const votes = await q<{ verdict: "accept" | "reject"; weight: string; provider: string; rung: string | null; user_id: number; model: string; also_credit: any }>(
    `SELECT verdict, weight, provider, rung, user_id, model, also_credit FROM reviews WHERE return_id = $1`, [returnId]);
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
    if (d.status === "accepted") await credit.payAcceptedReturn({ ...ret, status: "accepted", final_rung: d.rung }, votes);
    if (d.status === "accepted" && ret.type === "curate" && ret.decision) await files.applyCuration(Number(ret.id), Number(ret.user_id), ret.decision);
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

job.get("/return/:id", bearer, project, async (req, res) => {
  const r = await one(`SELECT r.*, u.handle, j.brief_md AS job_brief FROM returns r JOIN users u ON u.id = r.user_id LEFT JOIN jobs j ON j.id = r.job_id WHERE r.id = $1`, [req.params.id]);
  if (!r) { res.status(404).end(); return; }
  r.files = await q(`SELECT f.sha256, f.name, f.bytes FROM file_refs x JOIN files f ON f.sha256 = x.file_sha WHERE x.ref_type = 'return' AND x.ref_id = $1 AND f.deleted_at IS NULL`, [r.id]);
  res.json(r);
});


