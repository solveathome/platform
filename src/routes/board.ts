import { Router } from "express";
import { q, one } from "../db/index.js";
import { bearer, optionalAuth } from "../lib/auth.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_DIR } from "../lib/paths.js";
import { leaderboard, type Window } from "../lib/credit.js";

const page = (name: string) => readFileSync(join(PUBLIC_DIR, name), "utf8");
const wantsHtml = (req: any) => (req.header("accept") ?? "").includes("text/html");

export const board = Router({ mergeParams: true });
export const root = Router();

/** GET /projects/:slug : the project page for browsers (board on top, chat, contributors at the bottom). */
board.get("/", async (req: any, res) => {
  const p = await one(`SELECT slug, name FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).type("text/plain").send("unknown project"); return; }
  if (!wantsHtml(req)) { res.redirect(`/projects/${p.slug}/board`); return; }
  res.type("text/html").send(page("project.html").replaceAll("__SLUG__", p.slug).replaceAll("__NAME__", String(p.name).replace(/</g, "&lt;")));
});

/** GET /me : who the cookie or bearer token belongs to (for the browser UI). */
const OWNER_SET = new Set((process.env.OWNER_HANDLES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
root.get("/me", optionalAuth, async (req: any, res) => {
  if (!req.user) { res.json({ signed_in: false }); return; }
  res.json({ signed_in: true, handle: req.user.handle, owner: OWNER_SET.has(String(req.user.handle).toLowerCase()) });
});

/** GET /projects/:slug/board : research status first, contributors last (scope Q20). */
board.get("/board", async (req, res) => {
  const problem = await one(`SELECT id, slug, name, repo_url, status_md FROM problems WHERE slug = $1`, [(req.params as any).slug]);
  if (!problem) { res.status(404).json({ error: "unknown project" }); return; }
  const pid = problem.id;
  const rungs = await q(`SELECT final_rung AS rung, count(*) AS n FROM returns WHERE problem_id = $1 AND status = 'accepted' GROUP BY final_rung`, [pid]);
  const lanes = await q(`SELECT l.slug, l.title, l.variant, l.status,
    (SELECT count(*) FROM jobs j WHERE j.lane_id = l.id AND j.status = 'queued') AS queued,
    (SELECT count(*) FROM returns r WHERE r.lane_id = l.id AND r.status = 'accepted') AS accepted
    FROM lanes l WHERE l.problem_id = $1 ORDER BY l.id`, [pid]);
  const queue = await q(`SELECT type, status, count(*) AS n FROM jobs WHERE problem_id = $1 GROUP BY type, status ORDER BY type, status`, [pid]);
  const recent = await q(`SELECT r.id, r.type, r.status, r.final_rung, u.handle, r.created_at FROM returns r JOIN users u ON u.id = r.user_id WHERE r.problem_id = $1 ORDER BY r.id DESC LIMIT 50`, [pid]);
  const health = await one(`
    SELECT
      (SELECT count(*) FROM returns WHERE problem_id = $1 AND status IN ('accepted','rejected')) AS decided,
      (SELECT count(*) FROM returns WHERE problem_id = $1 AND status = 'contested') AS contested,
      (SELECT count(*) FROM returns WHERE problem_id = $1 AND status = 'pending') AS pending,
      (SELECT count(*) FROM jobs WHERE problem_id = $1 AND status = 'queued') AS queued,
      (SELECT round(avg(CASE WHEN rv.agreed_with_outcome THEN 1 ELSE 0 END)::numeric, 3) FROM reviews rv JOIN returns r ON r.id = rv.return_id WHERE r.problem_id = $1 AND rv.agreed_with_outcome IS NOT NULL) AS reviewer_agreement`, [pid]);
  const contributors = await q(`
    SELECT u.handle, count(*) FILTER (WHERE r.status = 'accepted') AS accepted, sum(r.cpu_hours) AS cpu_hours,
           count(*) FILTER (WHERE r.type = 'direction' AND r.status = 'accepted') AS directions_accepted
    FROM returns r JOIN users u ON u.id = r.user_id WHERE r.problem_id = $1 GROUP BY u.handle ORDER BY accepted DESC, cpu_hours DESC LIMIT 200`, [pid]);
  const { id: _omit, ...pub } = problem;
  res.json({ project: pub, rungs, lanes, queue, health, recent, contributors });
});

/** POST /projects/:slug/claims (owner): upsert provenance claims. Never touches the credit ledger. */
const OWNERS = new Set((process.env.OWNER_HANDLES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
board.post("/claims", bearer, async (req: any, res) => {
  if (!OWNERS.has(String(req.user.handle).toLowerCase())) { res.status(403).json({ error: "owner only" }); return; }
  const p = await one(`SELECT id FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  const b = req.body ?? {}; const list = Array.isArray(b.claims) ? b.claims : [];
  let n = 0;
  for (const c of list) {
    if (!c?.path || !c?.ledger_id) continue;
    await q(`INSERT INTO claims (problem_id, ledger_id, path, kind, status, question, verdict, origin_handle, origin_role, origin_model, origin_model_role, origin_note, first_commit, last_commit, commits, corpus, session_commits, model_commits)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
             ON CONFLICT (problem_id, path) DO UPDATE SET ledger_id = EXCLUDED.ledger_id, kind = EXCLUDED.kind, status = EXCLUDED.status, question = EXCLUDED.question, verdict = EXCLUDED.verdict,
               origin_handle = EXCLUDED.origin_handle, origin_role = EXCLUDED.origin_role, origin_model = EXCLUDED.origin_model, origin_model_role = EXCLUDED.origin_model_role, origin_note = EXCLUDED.origin_note,
               first_commit = EXCLUDED.first_commit, last_commit = EXCLUDED.last_commit, commits = EXCLUDED.commits, corpus = EXCLUDED.corpus, session_commits = EXCLUDED.session_commits, model_commits = EXCLUDED.model_commits, updated_at = now()`,
      [p.id, String(c.ledger_id), String(c.path), String(c.kind ?? "note"), String(c.status ?? "UNKNOWN"), String(c.question ?? ""), String(c.verdict ?? ""), String(b.origin_handle ?? "unknown"), String(b.origin_role ?? ""), b.origin_model ?? null, String(b.origin_model_role ?? ""), String(b.origin_note ?? ""), c.first ?? null, c.last ?? null, Number(c.commits ?? 0), !!c.corpus, Number(c.session_commits ?? 0), c.model_commits ? JSON.stringify(c.model_commits) : null]);
    n++;
  }
  res.json({ ok: true, upserted: n });
});

/** GET /projects/:slug/claims : provenance list. */
board.get("/claims", async (req: any, res) => {
  const p = await one(`SELECT id FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  const rows = await q(`SELECT ledger_id, path, kind, status, question, verdict, origin_handle, origin_role, origin_model, origin_model_role, first_commit, last_commit, commits, corpus, session_commits, model_commits, scored FROM claims WHERE problem_id = $1 ORDER BY kind, path`, [p.id]);
  const by_status = await q(`SELECT status, count(*) AS n FROM claims WHERE problem_id = $1 GROUP BY status ORDER BY n DESC`, [p.id]);
  const by_origin = await q(`SELECT origin_handle, origin_role, origin_model, origin_model_role, max(origin_note) AS origin_note, count(*) AS n, count(*) FILTER (WHERE corpus) AS corpus_claims, min(first_commit) AS first, max(last_commit) AS last, sum(commits) AS commits, sum(session_commits) AS session_commits,
      sum((model_commits->>'claude')::int) AS claude_commits, sum((model_commits->>'claude-marked')::int) AS claude_marked_commits, sum((model_commits->>'gpt-6-astra')::int) AS astra_commits, sum((model_commits->>'claude-dispatched')::int) AS dispatched_commits
    FROM claims WHERE problem_id = $1 GROUP BY origin_handle, origin_role, origin_model, origin_model_role ORDER BY n DESC`, [p.id]);
  res.json({ by_status, by_origin, claims: rows });
});

/** GET /projects/:slug/leaderboard?window=all|30d|7d */
board.get("/leaderboard", async (req: any, res) => {
  const p = await one(`SELECT id FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  const w = (["all", "30d", "7d"].includes(String(req.query.window)) ? String(req.query.window) : "all") as Window;
  res.json(await leaderboard(Number(p.id), w));
});
/** GET /leaderboard?window= : across all projects. */
root.get("/leaderboard", async (req, res) => {
  const w = (["all", "30d", "7d"].includes(String(req.query.window)) ? String(req.query.window) : "all") as Window;
  res.json(await leaderboard(null, w));
});
/** GET /credit : the points table. */
root.get("/credit", async (_req, res) => { res.json((await leaderboard(null, "all", 1)).points); });

/** GET /@handle : a contributor. Three columns: agent time, compute, research input (scope 5b). */
root.get("/@:handle", async (req, res) => {
  if (wantsHtml(req)) { res.type("text/html").send(page("contributor.html").replaceAll("__HANDLE__", String(req.params.handle).replace(/[^A-Za-z0-9-]/g, ""))); return; }
  const u = await one(`SELECT u.id, u.handle, u.created_at, rp.score, rp.accepted, rp.rejected, rp.review_agree, rp.review_disagree, rp.cpu_hours, rp.directions_accepted
    FROM users u LEFT JOIN reputation rp ON rp.user_id = u.id WHERE lower(u.handle) = lower($1)`, [req.params.handle]);
  if (!u) { res.status(404).json({ error: "no such contributor" }); return; }
  const recent = await q(`SELECT r.id, p.slug AS project, r.type, r.status, r.final_rung, r.created_at FROM returns r JOIN problems p ON p.id = r.problem_id WHERE r.user_id = $1 ORDER BY r.id DESC LIMIT 50`, [u.id]);
  const lanes = await q(`SELECT p.slug AS project, l.slug, l.title FROM lanes l JOIN problems p ON p.id = l.problem_id WHERE l.origin_user_id = $1 ORDER BY l.id`, [u.id]);
  const ledger = await q(`SELECT c.kind, c.points, c.model, c.source_type, c.source_id, c.note, c.created_at FROM credits c WHERE c.user_id = $1 ORDER BY c.id DESC LIMIT 100`, [u.id]);
  const provenance = await q(`SELECT p.slug AS project, max(c.origin_role) AS role, max(c.origin_model) AS model, max(c.origin_model_role) AS model_role, count(*) AS claims, count(*) FILTER (WHERE c.kind = 'note') AS notes, count(*) FILTER (WHERE c.kind = 'script') AS scripts, count(*) FILTER (WHERE c.corpus) AS corpus_claims, min(c.first_commit) AS first, max(c.last_commit) AS last, sum(c.commits) AS commits
    FROM claims c JOIN problems p ON p.id = c.problem_id WHERE lower(c.origin_handle) = lower($1) GROUP BY p.slug`, [u.handle]);
  const totals = await q(`SELECT kind, sum(points) AS points FROM credits WHERE user_id = $1 GROUP BY kind`, [u.id]);
  const researcher_of = await q(`SELECT slug, name, researcher_role FROM problems WHERE researcher_user_id = $1`, [u.id]);
  const { id: _omit, ...pub } = u;
  res.json({ contributor: pub, researcher_of, provenance, credit: { total: totals.reduce((s: number, t: any) => s + Number(t.points), 0), by_kind: Object.fromEntries(totals.map((t: any) => [t.kind, Number(t.points)])), ledger }, agent_time: { accepted: u.accepted, rejected: u.rejected, review_agree: u.review_agree, review_disagree: u.review_disagree },
             compute: { cpu_hours: u.cpu_hours }, research_input: { directions_accepted: u.directions_accepted, lanes }, recent });
});

root.get("/my/jobs", bearer, async (req, res) => {
  res.json(await q(`SELECT j.id, p.slug AS project, j.type, j.title, j.status, j.assigned_at, j.expires_at FROM jobs j JOIN problems p ON p.id = j.problem_id WHERE j.assigned_to = $1 ORDER BY j.assigned_at DESC LIMIT 50`, [req.user!.id]));
});

root.get("/healthz", async (_req, res) => { await q("SELECT 1"); res.json({ ok: true }); });
