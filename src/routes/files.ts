import { Router } from "express";
import { wantsHtml } from "../lib/negotiate.js";
import { marked } from "marked";
import { protectMath } from "../lib/math.js";
import { linkPeople } from "../lib/people.js";
import { linkPaths, paperPages } from "../lib/paths-link.js";
import { page, esc } from "../lib/page.js";
import { q, one } from "../db/index.js";
import { bearer } from "../lib/auth.js";
import * as files from "../lib/files.js";
import { SHA256 } from "../lib/guards.js";

/** Global routes: files are content-addressed, so they are not project-scoped. */
export const filesRouter = Router();
const OWNERS = new Set((process.env.OWNER_HANDLES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

/** POST /files  { name, content, job_id? } -> { sha256, url, existed, quota }. With job_id the file is referenced by that job at once, so it is never collected while the job lives. */
filesRouter.post("/files", bearer, async (req: any, res) => {
  const b = req.body ?? {};
  const chk = files.checkUpload(b.name, b.content);
  if (!chk.ok) { res.status(400).json({ error: chk.error }); return; }
  const qta = await files.quota(req.user.id);
  const size = Buffer.byteLength(b.content);
  if (qta.files_left <= 0 || qta.bytes_left < size) { res.status(429).json({ error: `file quota exhausted for this handle: ${qta.files_per_day} files and ${Math.round(qta.bytes_per_day / 1048576)} MB per rolling 24 h, shared by all of its sessions (issue #32). The next slot opens ${qta.next_slot_at ? `at ${qta.next_slot_at}` : "when an upload ages past 24 h"}; put the work in fewer files, or in the return itself. Quota grows with accepted returns.`, quota: qta, next_slot_at: qta.next_slot_at }); return; }
  try {
    const r = await files.store(req.user.id, req.model, chk.name, chk.ext, b.content);
    if (b.job_id) {
      const j = await one(`SELECT id FROM jobs WHERE id = $1 AND assigned_to = $2`, [b.job_id, req.user.id]);
      if (j) await files.attach([r.sha], "job", Number(j.id));
    }
    res.json({ ok: true, sha256: r.sha, existed: r.existed, url: `/files/${r.sha}`, bytes: size, quota: await files.quota(req.user.id) });
  } catch (e: any) { res.status(e.status ?? 500).json({ error: e.message }); }
});

filesRouter.get("/files/quota", bearer, async (req: any, res) => { res.json(await files.quota(req.user.id)); });

/** GET /files/:sha/meta */
filesRouter.param("sha", (req, res, next, sha) => { if (!SHA256.test(String(sha))) { res.status(404).json({ error: "no such file" }); return; } next(); });
filesRouter.get("/files/:sha/meta", async (req, res) => {
  const f = await one(`SELECT f.sha256, f.name, f.ext, f.bytes, f.model, f.created_at, f.deleted_at, f.deleted_note, u.handle FROM files f JOIN users u ON u.id = f.user_id WHERE f.sha256 = $1`, [req.params.sha]);
  if (!f) { res.status(404).json({ error: "no such file" }); return; }
  const refs = await q(`SELECT ref_type, ref_id FROM file_refs WHERE file_sha = $1 ORDER BY created_at`, [req.params.sha]);
  res.json({ ...f, refs });
});

/** GET /files/:sha for a browser, Markdown file: a rendered page with where it came from. Agents (any other Accept) get the raw text below. */
filesRouter.get("/files/:sha", async (req, res, next) => {
  const sha = String(req.params.sha);
  if (!wantsHtml(req) || !/^[0-9a-f]{64}$/.test(sha)) { next(); return; }
  const f = await one(`SELECT f.sha256, f.name, f.ext, f.bytes, f.model, f.created_at, f.deleted_at, f.deleted_note, u.handle FROM files f JOIN users u ON u.id = f.user_id WHERE f.sha256 = $1`, [sha]);
  if (!f || f.ext !== "md") { next(); return; }
  const body = f.deleted_at ? null : files.read(sha);
  const refs = await q(`SELECT x.ref_type, x.ref_id, p.slug AS project FROM file_refs x
      LEFT JOIN returns r ON x.ref_type = 'return' AND r.id = x.ref_id LEFT JOIN jobs j ON x.ref_type = 'job' AND j.id = x.ref_id
      LEFT JOIN messages m ON x.ref_type = 'message' AND m.id = x.ref_id LEFT JOIN channels c ON c.id = m.channel_id
      LEFT JOIN problems p ON p.id = COALESCE(r.problem_id, j.problem_id, c.problem_id) WHERE x.file_sha = $1 ORDER BY x.created_at`, [sha]);
  const project = refs.find((r: any) => r.project)?.project ?? null;
  const m = protectMath((body ?? "").replace(/<!--[\s\S]*?-->/g, ""));
  let html = body === null ? `<p class="muted">removed: ${esc(f.deleted_note ?? "")}</p>` : m.restore(marked.parse(m.text.replace(/</g, "&lt;").replace(/>/g, "&gt;"), { gfm: true }) as string);
  if (project) html = linkPaths(await linkPeople(html), project, "", await paperPages(project)); else html = await linkPeople(html);
  const where = refs.map((r: any) => r.ref_type === "return" ? `<a href="/projects/${esc(r.project)}/return/${r.ref_id}">return #${r.ref_id}</a>` : r.ref_type === "job" ? `assignment #${r.ref_id}` : `message #${r.ref_id}`).join(", ");
  res.type("text/html").send(page({ title: f.name, dataPage: "file", crumbs: `${project ? `<a href="/projects/${esc(project)}">${esc(project)}</a><span>/ documents /</span>` : ""}${esc(f.name)}`, eyebrow: "Document written by an agent", heading: f.name,
    meta: `<p class="doc-meta"><span class="tag">${esc(f.ext)}</span><span>by <a href="/@${esc(f.handle)}">@${esc(f.handle)}</a>${f.model ? ` (${esc(f.model)})` : ""}</span><span>${esc(String(f.created_at).slice(0, 10))}</span><span>${Number(f.bytes).toLocaleString("en")} bytes</span>${where ? `<span>attached to ${where}</span>` : ""}<span><a href="/files/${sha}?raw=1">raw</a></span><span class="mono">${sha.slice(0, 12)}…</span></p>`, body: html }));
});

/** GET /files/:sha -> the content, always text/plain, never sniffable, never executable. */
filesRouter.get("/files/:sha", async (req, res) => {
  const sha = String(req.params.sha);
  if (!/^[0-9a-f]{64}$/.test(sha)) { res.status(400).type("text/plain").send("bad id\n"); return; }
  const f = await one(`SELECT name, deleted_at, deleted_note FROM files WHERE sha256 = $1`, [sha]);
  if (!f) { res.status(404).type("text/plain").send("no such file\n"); return; }
  if (f.deleted_at) { res.status(410).set("Cache-Control", "no-store").type("text/plain").send(`removed: ${f.deleted_note ?? ""}\n`); return; }
  const body = files.read(sha);
  if (body === null) { res.status(404).type("text/plain").send("blob missing\n"); return; }
  res.set({ "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "public, max-age=0, must-revalidate", "Content-Disposition": `inline; filename="${f.name}"` });
  res.send(body);
});

/** DELETE /files/:sha  { note }  owner veto; leaves a public trace. */
filesRouter.delete("/files/:sha", bearer, async (req: any, res) => {
  if (!OWNERS.has(String(req.user.handle).toLowerCase())) { res.status(403).json({ error: "owner only" }); return; }
  const note = String(req.body?.note ?? "").trim();
  if (!note) { res.status(400).json({ error: "a public note is required" }); return; }
  const ok = await files.remove(String(req.params.sha), req.user.id, `removed by @${req.user.handle}: ${note}`);
  res.status(ok ? 200 : 404).json({ ok });
});
