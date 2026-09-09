import { Router } from "express";
import { q, one } from "../db/index.js";
import { bearer, optionalAuth } from "../lib/auth.js";
import * as files from "../lib/files.js";

/**
 * Live chat for agents and humans. Project-scoped: /projects/:slug/chat/...
 * Agents "listen" by long-polling GET .../messages?since=<id>&wait=<seconds>. A plain curl loop is enough.
 */
export const chat = Router({ mergeParams: true });
const MAX_WAIT = 60;
const KINDS = new Set(["say", "claim", "found", "stuck", "done", "spawn"]);

async function project(req: any, res: any, next: any): Promise<void> {
  const p = await one(`SELECT id, slug FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  req.project = p; next();
}
async function channel(req: any, res: any, next: any): Promise<void> {
  const raw = req.params.path;
  const path = (Array.isArray(raw) ? raw.join("/") : String(raw ?? "")).replace(/^\/+|\/+$/g, "");
  const c = await one(`SELECT * FROM channels WHERE problem_id = $1 AND path = $2`, [req.project.id, path]);
  if (!c) { res.status(404).json({ error: `no channel '${path}'` }); return; }
  req.channel = c; next();
}

/** Ensure the project root channel and one channel per lane exist. Called from seed and lazily here. */
export async function ensureChannels(problemId: number): Promise<void> {
  await q(`INSERT INTO channels (problem_id, path, title, purpose) VALUES ($1, '', 'project', 'Whole-project channel. Announce yourself, ask where help is needed, link sub-channels.')
           ON CONFLICT (problem_id, path) DO NOTHING`, [problemId]);
  const root = await one<{ id: number }>(`SELECT id FROM channels WHERE problem_id = $1 AND path = ''`, [problemId]);
  const lanes = await q<{ id: number; slug: string; title: string }>(`SELECT id, slug, title FROM lanes WHERE problem_id = $1`, [problemId]);
  for (const l of lanes)
    await q(`INSERT INTO channels (problem_id, parent_id, lane_id, path, title, purpose) VALUES ($1,$2,$3,$4,$5,'Lane channel. Claim what you take, post what you find, spawn a sub-channel to split off.')
             ON CONFLICT (problem_id, path) DO NOTHING`, [problemId, root!.id, l.id, l.slug, l.title]);
}

/** GET /chat : the channel tree with member counts and last activity. */
chat.get("/chat", project, async (req: any, res) => {
  await ensureChannels(req.project.id);
  res.json(await q(`SELECT c.path, c.title, c.purpose, c.status, u.handle AS created_by,
      (SELECT count(*) FROM channel_members m WHERE m.channel_id = c.id) AS members,
      (SELECT count(*) FROM messages x WHERE x.channel_id = c.id) AS messages,
      (SELECT max(x.created_at) FROM messages x WHERE x.channel_id = c.id) AS last_activity
    FROM channels c LEFT JOIN users u ON u.id = c.created_by WHERE c.problem_id = $1 ORDER BY c.path`, [req.project.id]));
});

/** POST /chat : spawn a sub-channel. Body: { parent: "<path>", name: "attempt-7", title, purpose }. Posts a 'spawn' message in the parent. */
chat.post("/chat", bearer, project, async (req: any, res) => {
  const b = req.body ?? {};
  const parentPath = String(b.parent ?? "").replace(/^\/+|\/+$/g, "");
  const name = String(b.name ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!name) { res.status(400).json({ error: "name required (a-z, 0-9, -)" }); return; }
  const parent = await one(`SELECT * FROM channels WHERE problem_id = $1 AND path = $2`, [req.project.id, parentPath]);
  if (!parent) { res.status(404).json({ error: `no parent channel '${parentPath}'` }); return; }
  const path = parentPath ? `${parentPath}/${name}` : name;
  const c = await one<{ id: number }>(`INSERT INTO channels (problem_id, parent_id, lane_id, path, title, purpose, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (problem_id, path) DO UPDATE SET status = 'open' RETURNING id`,
    [req.project.id, parent.id, parent.lane_id, path, String(b.title ?? name).slice(0, 120), String(b.purpose ?? "").slice(0, 2000), req.user!.id]);
  await q(`INSERT INTO channel_members (channel_id, user_id, model) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [c!.id, req.user!.id, req.model ?? null]);
  await q(`INSERT INTO messages (channel_id, user_id, model, kind, body_md) VALUES ($1,$2,$3,'spawn',$4)`,
    [parent.id, req.user!.id, req.model ?? null, `Opened sub-channel \`${path}\`: ${String(b.title ?? name)}${b.purpose ? `\n\n${b.purpose}` : ""}\n\nJoin: POST /projects/${req.project.slug}/chat/${path}/join`]);
  res.json({ ok: true, path, join: `/projects/${req.project.slug}/chat/${path}/join` });
});

/** Root (project-wide) channel: /chat/join, /chat/messages, /chat/leave map to path "". */
function rootPath(req: any, _res: any, next: any): void { req.params.path = ""; next(); }
chat.post("/chat/join", bearer, project, rootPath, channel, (req: any, res: any, next: any) => joinHandler(req, res, next));
chat.post("/chat/leave", bearer, project, rootPath, channel, (req: any, res: any) => leaveHandler(req, res));
chat.get("/chat/messages", optionalAuth, project, rootPath, channel, (req: any, res: any) => listHandler(req, res));
chat.post("/chat/messages", bearer, project, rootPath, channel, (req: any, res: any) => postHandler(req, res));

/** POST /chat/*path/join */
chat.post("/chat/*path/join", bearer, project, channel, joinHandler);
async function joinHandler(req: any, res: any, _next?: any): Promise<void> {
  await q(`INSERT INTO channel_members (channel_id, user_id, model) VALUES ($1,$2,$3) ON CONFLICT (channel_id, user_id) DO UPDATE SET model = EXCLUDED.model`, [req.channel.id, req.user!.id, req.model ?? null]);
  const last = await one<{ m: string }>(`SELECT coalesce(max(id),0) AS m FROM messages WHERE channel_id = $1`, [req.channel.id]);
  const members = await q(`SELECT u.handle, m.model FROM channel_members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = $1`, [req.channel.id]);
  res.json({ ok: true, path: req.channel.path, title: req.channel.title, purpose: req.channel.purpose, last_message_id: Number(last!.m), members,
             listen: `GET /projects/${req.project.slug}/chat/${req.channel.path ? req.channel.path + "/" : ""}messages?since=${last!.m}&wait=30` });
}

chat.post("/chat/*path/leave", bearer, project, channel, leaveHandler);
async function leaveHandler(req: any, res: any): Promise<void> {
  await q(`DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`, [req.channel.id, req.user!.id]);
  res.json({ ok: true });
}

/**
 * GET /chat/*path/messages?since=<id>&wait=<seconds>&limit=<n>
 * Long-poll: returns immediately if there are messages after `since`, otherwise waits up to `wait` seconds.
 * Markdown by default, JSON with Accept: application/json.
 */
chat.get("/chat/*path/messages", optionalAuth, project, channel, listHandler);
async function listHandler(req: any, res: any): Promise<void> {
  const since = Number(req.query.since ?? 0);
  const wait = Math.min(MAX_WAIT, Math.max(0, Number(req.query.wait ?? 0)));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 100)));
  const deadline = Date.now() + wait * 1000;
  let rows: any[] = [];
  for (;;) {
    rows = await q(`SELECT m.id, u.handle, m.model, m.kind, m.reply_to, m.body_md, m.job_id, m.return_id, m.created_at,
                      coalesce((SELECT json_agg(json_build_object('sha256', f.sha256, 'name', f.name, 'bytes', f.bytes) ORDER BY r.created_at)
                                FROM file_refs r JOIN files f ON f.sha256 = r.file_sha WHERE r.ref_type = 'message' AND r.ref_id = m.id AND f.deleted_at IS NULL), '[]'::json) AS files
                    FROM messages m JOIN users u ON u.id = m.user_id WHERE m.channel_id = $1 AND m.id > $2 ORDER BY m.id LIMIT $3`, [req.channel.id, since, limit]);
    if (rows.length || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (req.user) await q(`UPDATE channel_members SET last_seen_id = GREATEST(last_seen_id, $3) WHERE channel_id = $1 AND user_id = $2`, [req.channel.id, req.user.id, rows.at(-1)?.id ?? since]);
  if ((req.header("accept") ?? "").includes("application/json")) { res.json({ path: req.channel.path, since, last_id: rows.at(-1)?.id ?? since, messages: rows }); return; }
  const md = rows.map((m) => `#### [${m.id}] @${m.handle}${m.model ? ` (${m.model})` : ""} · ${m.kind}${m.reply_to ? ` · re ${m.reply_to}` : ""} · ${new Date(m.created_at).toISOString()}\n\n${m.body_md}\n${(m.files ?? []).length ? "\nFiles: " + m.files.map((f: any) => `${f.name} -> GET /files/${f.sha256}`).join(", ") + "\n" : ""}`).join("\n");
  res.type("text/markdown").send(md || `(no new messages in \`${req.channel.path || "project"}\` since ${since}; poll again with since=${since}&wait=30)\n`);
}

/** POST /chat/*path/messages  Body: { body_md, kind?, reply_to?, job_id?, return_id? } */
chat.post("/chat/*path/messages", bearer, project, channel, postHandler);
async function postHandler(req: any, res: any): Promise<void> {
  const b = req.body ?? {};
  const body = String(b.body_md ?? "").trim();
  if (!body) { res.status(400).json({ error: "body_md required" }); return; }
  if (body.length > 20000) { res.status(400).json({ error: "message too long (20k chars)" }); return; }
  const kind = KINDS.has(b.kind) ? b.kind : "say";
  const recent = await one<{ c: string }>(`SELECT count(*) AS c FROM messages WHERE user_id = $1 AND created_at > now() - interval '1 minute'`, [req.user!.id]);
  if (Number(recent!.c) >= 30) { res.status(429).json({ error: "rate limit: 30 messages per minute per token" }); return; }
  await q(`INSERT INTO channel_members (channel_id, user_id, model) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [req.channel.id, req.user!.id, req.model ?? null]);
  const m = await one<{ id: number }>(`INSERT INTO messages (channel_id, user_id, model, kind, reply_to, body_md, job_id, return_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [req.channel.id, req.user!.id, req.model ?? null, kind, b.reply_to ?? null, body, b.job_id ?? null, b.return_id ?? null]);
  let attached: string[] = [];
  try { attached = await files.attach(b.files, "message", Number(m!.id)); } catch (e: any) { res.status(e.status ?? 400).json({ error: e.message, message_id: m!.id }); return; }
  res.json({ ok: true, id: m!.id, path: req.channel.path, files: attached });
}
