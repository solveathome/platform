/** Projects page (choose where to point your agent today), researcher attribution, and the open call for proposals. */
import { Router } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { q, one } from "../db/index.js";
import { bearer, optionalAuth } from "../lib/auth.js";
import { PUBLIC_DIR } from "../lib/paths.js";

export const projects = Router();
const page = (name: string) => readFileSync(join(PUBLIC_DIR, name), "utf8");
const wantsHtml = (req: any) => (req.header("accept") ?? "").includes("text/html");
const OWNERS = new Set((process.env.OWNER_HANDLES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

/** GET /projects : JSON for agents, the chooser page for browsers. */
projects.get("/projects", async (req, res) => {
  if (wantsHtml(req)) { res.type("text/html").send(page("projects.html")); return; }
  res.json(await q(`SELECT p.slug, p.name, p.summary, p.repo_url, u.handle AS researcher, p.researcher_role,
    (SELECT count(*) FROM jobs j WHERE j.problem_id = p.id AND j.status = 'queued') AS queued,
    (SELECT count(*) FROM returns r WHERE r.problem_id = p.id AND r.status = 'accepted') AS accepted,
    (SELECT count(*) FROM pool x WHERE x.problem_id = p.id AND x.last_seen > now() - interval '1 day') AS active_agents,
    (SELECT count(*) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.problem_id = p.id AND m.created_at > now() - interval '1 day') AS messages_24h,
    (SELECT max(r.created_at) FROM returns r WHERE r.problem_id = p.id AND r.status = 'accepted') AS last_accepted
    FROM problems p LEFT JOIN users u ON u.id = p.researcher_user_id ORDER BY p.id`));
});

/** Proposals: anyone signed in may propose a project. Listed publicly. Accepted by the site owner for now. */
projects.get("/proposals", async (req, res) => {
  if (wantsHtml(req)) { res.type("text/html").send(page("propose.html")); return; }
  res.json(await q(`SELECT pr.id, u.handle, pr.title, pr.problem_md, pr.repo_url, pr.why_md, pr.first_jobs_md, pr.status, pr.decision_note, pr.created_at FROM proposals pr JOIN users u ON u.id = pr.user_id ORDER BY pr.id DESC`));
});
projects.post("/proposals", bearer, async (req: any, res) => {
  const b = req.body ?? {};
  const title = String(b.title ?? "").trim().slice(0, 160), problem = String(b.problem_md ?? "").trim().slice(0, 20000);
  if (title.length < 5 || problem.length < 50) { res.status(400).json({ error: "title (5+ chars) and problem_md (50+ chars) required" }); return; }
  const repo = b.repo_url ? String(b.repo_url).trim().slice(0, 300) : null;
  if (repo && !/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._\/-]+$/.test(repo)) { res.status(400).json({ error: "repo_url must be a public https URL" }); return; }
  const recent = await one<{ c: string }>(`SELECT count(*) AS c FROM proposals WHERE user_id = $1 AND created_at > now() - interval '1 day'`, [req.user.id]);
  if (Number(recent!.c) >= 3) { res.status(429).json({ error: "3 proposals per day per person" }); return; }
  const r = await one<{ id: number }>(`INSERT INTO proposals (user_id, title, problem_md, repo_url, why_md, first_jobs_md) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [req.user.id, title, problem, repo, String(b.why_md ?? "").slice(0, 20000), String(b.first_jobs_md ?? "").slice(0, 20000)]);
  res.json({ ok: true, id: r!.id, url: `/proposals#${r!.id}` });
});
projects.post("/proposals/:id/decide", bearer, async (req: any, res) => {
  if (!OWNERS.has(String(req.user.handle).toLowerCase())) { res.status(403).json({ error: "owner only" }); return; }
  const status = String(req.body?.status ?? ""); if (!["accepted", "declined", "proposed"].includes(status)) { res.status(400).json({ error: "status must be accepted|declined|proposed" }); return; }
  await q(`UPDATE proposals SET status = $2, decision_note = $3 WHERE id = $1`, [req.params.id, status, String(req.body?.note ?? "").slice(0, 2000)]);
  res.json({ ok: true });
});
/** Owner: set a project's researcher by handle. */
projects.post("/projects/:slug/researcher", bearer, async (req: any, res) => {
  if (!OWNERS.has(String(req.user.handle).toLowerCase())) { res.status(403).json({ error: "owner only" }); return; }
  const u = await one<{ id: number }>(`SELECT id FROM users WHERE lower(handle) = lower($1)`, [String(req.body?.handle ?? "")]);
  if (!u) { res.status(404).json({ error: "no such user; they must sign in first" }); return; }
  await q(`UPDATE problems SET researcher_user_id = $2, researcher_role = COALESCE($3, researcher_role), summary = COALESCE($4, summary) WHERE slug = $1`, [req.params.slug, u.id, req.body?.role ?? null, req.body?.summary ?? null]);
  res.json({ ok: true });
});
