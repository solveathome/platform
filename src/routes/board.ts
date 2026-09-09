import { Router } from "express";
import { q, one } from "../db/index.js";
import { bearer, optionalAuth } from "../lib/auth.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_DIR } from "../lib/paths.js";

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
root.get("/me", optionalAuth, async (req: any, res) => {
  if (!req.user) { res.json({ signed_in: false }); return; }
  res.json({ signed_in: true, handle: req.user.handle });
});

/** GET /projects/:slug/board : research status first, contributors last (scope Q20). */
board.get("/board", async (req, res) => {
  const problem = await one(`SELECT id, slug, name, repo_url, status_md FROM problems WHERE slug = $1`, [(req.params as any).slug]);
  if (!problem) { res.status(404).json({ error: "unknown project" }); return; }
  const pid = problem.id;
  const rungs = await q(`SELECT final_rung AS rung, count(*) AS n FROM returns WHERE problem_id = $1 AND status = 'accepted' GROUP BY final_rung`, [pid]);
  const lanes = await q(`SELECT slug, title, variant, status FROM lanes WHERE problem_id = $1 ORDER BY id`, [pid]);
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

/** GET /projects : all projects with headline counts. */
root.get("/projects", async (_req, res) => {
  res.json(await q(`SELECT p.slug, p.name, p.repo_url,
    (SELECT count(*) FROM jobs j WHERE j.problem_id = p.id AND j.status = 'queued') AS queued,
    (SELECT count(*) FROM returns r WHERE r.problem_id = p.id AND r.status = 'accepted') AS accepted
    FROM problems p ORDER BY p.id`));
});

/** GET /@handle : a contributor. Three columns: agent time, compute, research input (scope 5b). */
root.get("/@:handle", async (req, res) => {
  if (wantsHtml(req)) { res.type("text/html").send(page("contributor.html").replaceAll("__HANDLE__", String(req.params.handle).replace(/[^A-Za-z0-9-]/g, ""))); return; }
  const u = await one(`SELECT u.id, u.handle, u.created_at, rp.score, rp.accepted, rp.rejected, rp.review_agree, rp.review_disagree, rp.cpu_hours, rp.directions_accepted
    FROM users u LEFT JOIN reputation rp ON rp.user_id = u.id WHERE lower(u.handle) = lower($1)`, [req.params.handle]);
  if (!u) { res.status(404).json({ error: "no such contributor" }); return; }
  const recent = await q(`SELECT r.id, p.slug AS project, r.type, r.status, r.final_rung, r.created_at FROM returns r JOIN problems p ON p.id = r.problem_id WHERE r.user_id = $1 ORDER BY r.id DESC LIMIT 50`, [u.id]);
  const lanes = await q(`SELECT p.slug AS project, l.slug, l.title FROM lanes l JOIN problems p ON p.id = l.problem_id WHERE l.origin_user_id = $1 ORDER BY l.id`, [u.id]);
  const { id: _omit, ...pub } = u;
  res.json({ contributor: pub, agent_time: { accepted: u.accepted, rejected: u.rejected, review_agree: u.review_agree, review_disagree: u.review_disagree },
             compute: { cpu_hours: u.cpu_hours }, research_input: { directions_accepted: u.directions_accepted, lanes }, recent });
});

root.get("/my/jobs", bearer, async (req, res) => {
  res.json(await q(`SELECT j.id, p.slug AS project, j.type, j.title, j.status, j.assigned_at, j.expires_at FROM jobs j JOIN problems p ON p.id = j.problem_id WHERE j.assigned_to = $1 ORDER BY j.assigned_at DESC LIMIT 50`, [req.user!.id]));
});

root.get("/healthz", async (_req, res) => { await q("SELECT 1"); res.json({ ok: true }); });
