import { Router } from "express";
import { q, one } from "../db/index.js";
import { bearer } from "../lib/auth.js";

export const lane = Router({ mergeParams: true });

lane.get("/lanes", async (req, res) => {
  res.json(await q(`SELECT l.id, l.slug, l.title, l.variant, l.status, u.handle AS origin,
    (SELECT count(*) FROM jobs j WHERE j.lane_id = l.id AND j.status = 'queued') AS queued,
    (SELECT count(*) FROM returns r WHERE r.lane_id = l.id AND r.status = 'accepted') AS accepted
    FROM lanes l JOIN problems p ON p.id = l.problem_id LEFT JOIN users u ON u.id = l.origin_user_id
    WHERE p.slug = $1 ORDER BY l.id`, [(req.params as any).slug]));
});

lane.get("/lane/:lane/thread", async (req, res) => {
  const l = await one(`SELECT l.id FROM lanes l JOIN problems p ON p.id = l.problem_id WHERE l.slug = $1 AND p.slug = $2`, [(req.params as any).lane, (req.params as any).slug]);
  if (!l) { res.status(404).end(); return; }
  const notes = await q(`SELECT n.id, u.handle, n.return_id, n.body_md, n.created_at FROM thread_notes n JOIN users u ON u.id = n.user_id WHERE n.lane_id = $1 ORDER BY n.id`, [l.id]);
  if ((req.header("accept") ?? "").includes("application/json")) { res.json(notes); return; }
  res.type("text/markdown").send(notes.map((n: any) => `## @${n.handle} · ${new Date(n.created_at).toISOString()}${n.return_id ? ` · return #${n.return_id}` : ""}\n\n${n.body_md}\n`).join("\n---\n\n") || "(empty thread)\n");
});

lane.post("/lane/:lane/note", bearer, async (req, res) => {
  const l = await one(`SELECT l.id FROM lanes l JOIN problems p ON p.id = l.problem_id WHERE l.slug = $1 AND p.slug = $2 AND l.status = 'open'`, [(req.params as any).lane, (req.params as any).slug]);
  if (!l) { res.status(404).json({ error: "no open lane with that slug" }); return; }
  const body = String(req.body?.body_md ?? "").trim();
  if (!body) { res.status(400).json({ error: "body_md required" }); return; }
  const n = await one<{ id: number }>(`INSERT INTO thread_notes (lane_id, user_id, return_id, body_md) VALUES ($1,$2,$3,$4) RETURNING id`,
    [l.id, req.user!.id, req.body?.return_id ?? null, body]);
  res.json({ ok: true, note_id: n!.id });
});
