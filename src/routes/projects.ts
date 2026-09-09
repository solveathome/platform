/** Project-list API and researcher attribution. Browser visitors enter through the front page. */
import { Router } from "express";
import { q, one } from "../db/index.js";
import { bearer } from "../lib/auth.js";

export const projects = Router();
const wantsHtml = (req: any) => (req.header("accept") ?? "").includes("text/html");
const OWNERS = new Set((process.env.OWNER_HANDLES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

/** GET /projects : JSON for agents; the single-project front page for browsers. */
projects.get("/projects", async (req, res) => {
  if (wantsHtml(req)) { res.redirect(302, "/"); return; }
  const rows = await q(`SELECT p.slug, p.name, p.summary, p.repo_url, u.handle AS researcher, p.researcher_role,
    (SELECT count(*) FROM jobs j WHERE j.problem_id = p.id AND j.status = 'queued') AS queued,
    (SELECT count(*) FROM returns r WHERE r.problem_id = p.id AND r.status = 'accepted') AS accepted,
    (SELECT count(*) FROM pool x WHERE x.problem_id = p.id AND x.last_seen > now() - interval '1 day') AS active_agents,
    (SELECT count(*) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.problem_id = p.id AND m.created_at > now() - interval '1 day') AS messages_24h,
    (SELECT max(r.created_at) FROM returns r WHERE r.problem_id = p.id AND r.status = 'accepted') AS last_accepted
    FROM problems p LEFT JOIN users u ON u.id = p.researcher_user_id ORDER BY p.id`);
  res.json(rows);
});

/** Owner: set a project's researcher by handle. */
projects.post("/projects/:slug/researcher", bearer, async (req: any, res) => {
  if (!OWNERS.has(String(req.user.handle).toLowerCase())) { res.status(403).json({ error: "owner only" }); return; }
  const u = await one<{ id: number }>(`SELECT id FROM users WHERE lower(handle) = lower($1)`, [String(req.body?.handle ?? "")]);
  if (!u) { res.status(404).json({ error: "no such user; they must sign in first" }); return; }
  await q(`UPDATE problems SET researcher_user_id = $2, researcher_role = COALESCE($3, researcher_role), summary = COALESCE($4, summary) WHERE slug = $1`, [req.params.slug, u.id, req.body?.role ?? null, req.body?.summary ?? null]);
  res.json({ ok: true });
});
