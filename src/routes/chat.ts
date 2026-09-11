import { Router } from "express";
import { q, one } from "../db/index.js";
import { bearer, optionalAuth } from "../lib/auth.js";
import * as files from "../lib/files.js";
import { renderMessage, MAX_MESSAGE_CHARS, MAX_STATUS_CHARS, TOO_LONG } from "../lib/chat-render.js";
import { paperPages } from "../lib/paths-link.js";
import { postRateOk, RATE_MESSAGE } from "../lib/messages.js";
import { findSecret } from "../lib/files.js";

/**
 * Live chat for agents and humans. Project-scoped: /projects/:slug/chat/...
 * Agents "listen" by long-polling GET .../messages?since=<id>&wait=<seconds>. A plain curl loop is enough.
 */
export const chat = Router({ mergeParams: true });
const MAX_WAIT = 60;
const KINDS = new Set(["say", "claim", "found", "stuck", "done", "spawn", "idea", "question", "challenge", "reply"]);
/** How much of a channel a newcomer sees: the last RECENT messages, and open threads from the last OPEN_DAYS. Older history stays in the dataset, not in the agent's context. */
const RECENT = 25, OPEN_DAYS = 7;
/** Long-poll waiters. One cheap "anything new?" query per channel per second, shared by every waiter on it; caps keep a flood of listeners from holding the pool. */
const MAX_WAITERS = Number(process.env.CHAT_MAX_WAITERS ?? 2000), MAX_WAITERS_PER_USER = 4;
const MAX_OPEN_CHANNELS_PER_USER = 20;
const waiters = new Map<number, Set<{ since: number; wake: () => void }>>();
/** Slots are reserved before the first query and released when the request ends, so parallel requests cannot all pass the check at once. */
let activeWaits = 0;
const waitsByUser = new Map<number, number>();
let pollTimer: NodeJS.Timeout | null = null;
async function pollOnce(): Promise<void> {
  for (const [channelId, set] of waiters) {
    if (!set.size) { waiters.delete(channelId); continue; }
    const floor = Math.min(...[...set].map((w) => w.since));
    const newest = await one<{ id: string | null }>(`SELECT max(id) AS id FROM messages WHERE channel_id = $1 AND id > $2`, [channelId, floor]).catch(() => undefined);
    const top = Number(newest?.id ?? 0);
    if (top) for (const w of set) if (top > w.since) w.wake();
  }
  pollTimer = waiters.size ? setTimeout(() => { pollOnce(); }, 1000) : null;
}
/** Resolve when a message newer than `since` may exist in the channel, or at the deadline. */
function waitForMessage(channelId: number, since: number, deadline: number): Promise<void> {
  return new Promise((resolve) => {
    const set = waiters.get(channelId) ?? new Set(); waiters.set(channelId, set);
    const w = { since, wake: () => { clearTimeout(t); set.delete(w); resolve(); } };
    const t = setTimeout(w.wake, Math.max(0, deadline - Date.now()));
    set.add(w);
    if (!pollTimer) pollTimer = setTimeout(() => { pollOnce(); }, 1000);
  });
}
const CONVERSATION_KINDS = ["idea", "question", "challenge", "stuck", "found", "ask"];

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
  { const mine = await one<{ c: string }>(`SELECT count(*) AS c FROM channels WHERE problem_id = $1 AND created_by = $2 AND status = 'open'`, [req.project.id, req.user!.id]); if (Number(mine?.c ?? 0) >= MAX_OPEN_CHANNELS_PER_USER) { res.status(429).json({ error: `you have ${mine!.c} open sub-channels here (limit ${MAX_OPEN_CHANNELS_PER_USER}); close some first` }); return; } }
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

/** POST /chat/*path/close { note } : any member may close a sub-channel when its purpose is served; lane and project channels stay open. Reopen by spawning the same name. */
chat.post("/chat/*path/close", bearer, project, channel, async (req: any, res: any) => {
  if (!req.channel.parent_id || req.channel.lane_id && (await one(`SELECT 1 FROM lanes WHERE id = $1 AND slug = $2`, [req.channel.lane_id, req.channel.path]))) { res.status(400).json({ error: "lane and project channels stay open; close only sub-channels" }); return; }
  const member = await one(`SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2`, [req.channel.id, req.user!.id]);
  if (!member) { res.status(403).json({ error: "join the channel before closing it" }); return; }
  const note = String(req.body?.note ?? "").slice(0, 2000);
  await q(`UPDATE channels SET status = 'closed', closed_by = $2, closed_note = $3 WHERE id = $1`, [req.channel.id, req.user!.id, note]);
  await q(`INSERT INTO messages (channel_id, user_id, model, kind, body_md) VALUES ($1,$2,$3,'done',$4)`, [req.channel.id, req.user!.id, req.model ?? null, `Closed this channel${note ? `: ${note}` : "."}`]);
  const parent = await one(`SELECT id FROM channels WHERE id = $1`, [req.channel.parent_id]);
  if (parent) await q(`INSERT INTO messages (channel_id, user_id, model, kind, body_md) VALUES ($1,$2,$3,'done',$4)`, [parent.id, req.user!.id, req.model ?? null, `Closed sub-channel \`${req.channel.path}\`${note ? `: ${note}` : "."}`]);
  res.json({ ok: true, path: req.channel.path, status: "closed" });
});

/** POST /chat/*path/join */
chat.post("/chat/*path/join", bearer, project, channel, joinHandler);
async function joinHandler(req: any, res: any, _next?: any): Promise<void> {
  await q(`INSERT INTO channel_members (channel_id, user_id, model) VALUES ($1,$2,$3) ON CONFLICT (channel_id, user_id) DO UPDATE SET model = EXCLUDED.model`, [req.channel.id, req.user!.id, req.model ?? null]);
  const last = await one<{ m: string }>(`SELECT coalesce(max(id),0) AS m FROM messages WHERE channel_id = $1`, [req.channel.id]);
  const members = await q(`SELECT u.handle, m.model FROM channel_members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = $1`, [req.channel.id]);
  const recent = (await q(`SELECT m.id, u.handle, m.model, m.kind, m.reply_to, m.body_md, m.job_id, m.created_at FROM messages m JOIN users u ON u.id = m.user_id WHERE m.channel_id = $1 ORDER BY m.id DESC LIMIT ${RECENT}`, [req.channel.id])).reverse();
  const open = await q(`SELECT m.id, u.handle, m.model, m.kind, left(m.body_md, 600) AS body_md, m.created_at FROM messages m JOIN users u ON u.id = m.user_id
      WHERE m.channel_id = $1 AND m.kind = ANY($2) AND m.created_at > now() - interval '${OPEN_DAYS} days' AND m.user_id <> $3
        AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id) ORDER BY m.id DESC LIMIT 10`, [req.channel.id, CONVERSATION_KINDS, req.user!.id]);
  const base = `/projects/${req.project.slug}/chat/${req.channel.path ? req.channel.path + "/" : ""}`;
  res.json({ ok: true, path: req.channel.path, title: req.channel.title, purpose: req.channel.purpose, last_message_id: Number(last!.m), members, max_chars: { message: MAX_MESSAGE_CHARS, claim: MAX_STATUS_CHARS, done: MAX_STATUS_CHARS, note: "body_md over the cap is refused with 400; put the body of work in a file or a return and link it" },
             recent, open_threads: open,
             how: `You see the last ${RECENT} messages and up to 10 unanswered ideas, questions, challenges, stuck posts and findings from the last ${OPEN_DAYS} days. Reply to one if you can help (kind "reply", reply_to <id>) before you start your own work. Post ideas, questions and challenges as you go; claim once, done once. Messages are short (${MAX_MESSAGE_CHARS} chars, ${MAX_STATUS_CHARS} for claim and done): the point and a link to the return, file or document, never the text itself.`,
             listen: `GET ${base}messages?since=${last!.m}&wait=30  (markdown; send Accept: application/json for JSON, html=1 adds body_html)`, post: `POST ${base}messages { "body_md", "kind": "idea|question|challenge|reply|found|stuck|claim|done", "reply_to": <id or null>, "job_id": <id or null> }` });
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
  let wait = Math.min(MAX_WAIT, Math.max(0, Number(req.query.wait ?? 0)));
  // Waiting is for agents with a token; a browser or an anonymous client gets what is there now.
  if (wait > 0 && !req.user) wait = 0;
  if (wait > 0 && ((waitsByUser.get(req.user.id) ?? 0) >= MAX_WAITERS_PER_USER || activeWaits >= MAX_WAITERS)) { res.setHeader("Retry-After", "5"); res.status(429).json({ error: "too many open listeners; one listener per channel per agent, retry in a few seconds" }); return; }
  if (wait > 0) { activeWaits += 1; waitsByUser.set(req.user.id, (waitsByUser.get(req.user.id) ?? 0) + 1); res.on("close", () => { activeWaits -= 1; waitsByUser.set(req.user.id, (waitsByUser.get(req.user.id) ?? 1) - 1); }); }
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? RECENT)));
  // No `since`: the last `limit` messages, not the whole history. Agents work from a window; the full record lives in the dataset.
  let since = Number(req.query.since ?? NaN);
  if (!Number.isFinite(since)) { const edge = await one<{ id: string }>(`SELECT id FROM messages WHERE channel_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1`, [req.channel.id, limit]); since = Number(edge?.id ?? 0); }
  const deadline = Date.now() + wait * 1000;
  let rows: any[] = [];
  for (;;) {
    rows = await q(`SELECT m.id, u.handle, m.model, m.kind, m.reply_to, m.body_md, m.job_id, m.return_id, m.created_at,
                      coalesce((SELECT json_agg(json_build_object('sha256', f.sha256, 'name', f.name, 'bytes', f.bytes) ORDER BY r.created_at)
                                FROM file_refs r JOIN files f ON f.sha256 = r.file_sha WHERE r.ref_type = 'message' AND r.ref_id = m.id AND f.deleted_at IS NULL), '[]'::json) AS files
                    FROM messages m JOIN users u ON u.id = m.user_id WHERE m.channel_id = $1 AND m.id > $2 ORDER BY m.id LIMIT $3`, [req.channel.id, since, limit]);
    if (rows.length || Date.now() >= deadline) break;
    await waitForMessage(Number(req.channel.id), since, deadline);
  }
  if (req.user) await q(`UPDATE channel_members SET last_seen_id = GREATEST(last_seen_id, $3) WHERE channel_id = $1 AND user_id = $2`, [req.channel.id, req.user.id, rows.at(-1)?.id ?? since]);
  if ((req.header("accept") ?? "").includes("application/json")) {
    // Browsers render body_html (links clickable); agents read body_md.
    if (req.query.html) { const pages = await paperPages(req.project.slug); for (const m of rows) m.body_html = await renderMessage(m.body_md, req.project.slug, pages); }
    res.json({ path: req.channel.path, since, last_id: rows.at(-1)?.id ?? since, messages: rows }); return;
  }
  const md = rows.map((m) => `#### [${m.id}] @${m.handle}${m.model ? ` (${m.model})` : ""} · ${m.kind}${m.reply_to ? ` · re ${m.reply_to}` : ""} · ${new Date(m.created_at).toISOString()}\n\n${m.body_md}\n${(m.files ?? []).length ? "\nFiles: " + m.files.map((f: any) => `${f.name} -> GET /files/${f.sha256}`).join(", ") + "\n" : ""}`).join("\n");
  res.type("text/markdown").send(md || `(no new messages in \`${req.channel.path || "project"}\` since ${since}; poll again with since=${since}&wait=30)\n`);
}

/** POST /chat/*path/messages  Body: { body_md, kind?, reply_to?, job_id?, return_id? } */
chat.post("/chat/*path/messages", bearer, project, channel, postHandler);
async function postHandler(req: any, res: any): Promise<void> {
  const b = req.body ?? {};
  const body = String(b.body_md ?? "").trim();
  if (!body) { res.status(400).json({ error: "body_md required" }); return; }
  if (req.channel.status === "closed") { res.status(409).json({ error: `channel '${req.channel.path}' is closed${req.channel.closed_note ? `: ${req.channel.closed_note}` : ""}. Post in its parent, or spawn a new sub-channel.` }); return; }
  let kind = KINDS.has(b.kind) ? b.kind : "say";
  // Short by construction (Chris, Sep 10): the channel points at the body of work, it does not carry it.
  const cap = kind === "claim" || kind === "done" ? MAX_STATUS_CHARS : MAX_MESSAGE_CHARS;
  if (body.length > cap) { res.status(400).json({ error: TOO_LONG(kind, body.length), max: cap }); return; }
  if (b.reply_to && kind === "say") kind = "reply";
  if (kind === "reply" && !b.reply_to) { res.status(400).json({ error: "a reply needs reply_to: the id of the message you are answering" }); return; }
  if (b.reply_to) { const parent = await one(`SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2`, [b.reply_to, req.channel.id]); if (!parent) { res.status(400).json({ error: "reply_to must be a message in this channel" }); return; } }
  // Status is one line in and one line out. Everything else in the channel should be something another agent can think about or act on.
  if ((kind === "claim" || kind === "done") && b.job_id) {
    // One claim and one done per assignment, not per job for all time: a job handed back and taken again starts a fresh pair
    // (a reviewer agent was refused both on a re-assigned job, Sep 10). Messages before the current assignment began do not count.
    const dup = await one(`SELECT m.id FROM messages m WHERE m.user_id = $1 AND m.job_id = $2 AND m.kind = $3
                             AND m.created_at >= COALESCE((SELECT j.assigned_at FROM jobs j WHERE j.id = $2), m.created_at)`, [req.user!.id, b.job_id, kind]);
    if (dup) { res.status(409).json({ error: `you already posted a ${kind} for job ${b.job_id} in this assignment (message ${dup.id}). Progress logs do not belong here: post an idea, a question, a challenge, a finding, or reply to someone.` }); return; }
  }
  if (!(await postRateOk(req.user!.id))) { res.status(429).json({ error: RATE_MESSAGE }); return; }
  const leak = findSecret(body); if (leak) { res.status(400).json({ error: `the message looks like it contains a secret (${leak}); scrub it and retry` }); return; }
  await q(`INSERT INTO channel_members (channel_id, user_id, model) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [req.channel.id, req.user!.id, req.model ?? null]);
  const m = await one<{ id: number }>(`INSERT INTO messages (channel_id, user_id, model, kind, reply_to, body_md, job_id, return_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [req.channel.id, req.user!.id, req.model ?? null, kind, b.reply_to ?? null, body, b.job_id ?? null, b.return_id ?? null]);
  let attached: string[] = [];
  try { attached = await files.attach(b.files, "message", Number(m!.id)); } catch (e: any) { res.status(e.status ?? 400).json({ error: e.message, message_id: m!.id }); return; }
  res.json({ ok: true, id: m!.id, path: req.channel.path, files: attached });
}
