import { assignmentMutation } from "../lib/assignments.js";
import {timeHtml} from "../lib/timestamps.js";
import { Router } from "express";
import { wantsHtml } from "../lib/negotiate.js";
import { marked } from "marked";
import { protectMath } from "../lib/math.js";
import { documentRenderer, escapeSource } from "../lib/markdown.js";
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
filesRouter.post("/files", bearer, async (req:any,res,next) => {
  const sid=req.header('x-session');
  const s=sid ? await one(`SELECT problem_id FROM sessions WHERE id=$1 AND user_id=$2`,[sid,req.user.id]) : null;
  if(sid && !s) { res.status(403).json({error:'unknown upload session'}); return; }
  req.project={id:s?.problem_id ?? 0}; next();
}, assignmentMutation(async (req: any, res) => {
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
    // Never refused (Chris, Sep 12 2026): a file that will not run or reproduce elsewhere is stored and the author told where; the reviewer hears it too.
    const warnings = files.portabilityNotes(chk.name, b.content).map((n) => `${chk.name} ${n} The file is stored as sent; fix it and upload again to spare the reviewer, or leave it and they will fix it when rerunning.`);
    // The name is kept, served as Content-Disposition and returned by /files/<sha>/meta; echo it so an author can see the stored
    // form and cite it in a manifest, and say so when the sanitiser changed it (issue #85).
    if (chk.name !== String(b.name ?? "")) warnings.push(`the file is stored as "${chk.name}": a name is reduced to letters, digits, dot, dash and underscore, and to 120 characters. Use the stored name where a recipe or a manifest names this file.`);
    res.json({ ok: true, sha256: r.sha, name: chk.name, existed: r.existed, url: `/files/${r.sha}`, bytes: size, quota: await files.quota(req.user.id), warnings });
  } catch (e: any) { res.status(e.status ?? 500).json({ error: e.message }); }
}));

filesRouter.get("/files/quota", bearer, async (req: any, res) => { res.json(await files.quota(req.user.id)); });

/** GET /files/:sha/meta */
// A content address is 64 hex characters. When it is not, say so: "no such file" for a hash that was mistyped or truncated in
// transit reads as a blob that went missing from the store, and that is a costly thing for an agent to conclude (issue #67,
// where 62 characters of a real hash were fetched, 404ed, and reported as a dropped file that was in fact present).
filesRouter.param("sha", (req, res, next, sha) => {
  const raw = String(sha);
  if (SHA256.test(raw)) { next(); return; }
  const bad = raw.replace(/[0-9a-f]/gi, "").slice(0, 12);
  const error = `not a content address: a file is named by 64 hex characters and this is ${raw.length}${bad ? `, and contains ${JSON.stringify(bad)}` : ""}. Nothing is missing from the store; check the sha256 you copied, whole, from the return's "files" list or from GET /files/<sha256>/meta.`;
  res.status(404);
  if (/\/meta$/.test(req.path)) res.json({ error }); else res.type("text/plain").send(error + "\n");   // the same shape the route itself answers in
});
filesRouter.get("/files/:sha/meta", async (req, res) => {
  const f = await one(`SELECT f.sha256, f.name, f.ext, f.bytes, f.model, f.created_at, f.deleted_at, f.deleted_note, u.handle FROM files f JOIN users u ON u.id = f.user_id WHERE f.sha256 = $1`, [req.params.sha]);
  if (!f) { res.status(404).json({ error: "no such file" }); return; }
  const refs = await q(`SELECT ref_type, ref_id FROM file_refs WHERE file_sha = $1 ORDER BY created_at`, [req.params.sha]);
  res.json({ ...f, refs });
});

/** GET /files/:sha for a browser, Markdown file: a rendered page with where it came from. Agents (any other Accept) get the raw text below. */
filesRouter.get("/files/:sha", async (req, res, next) => {
  const sha = String(req.params.sha);
  if (!wantsHtml(req) || req.query.raw || !/^[0-9a-f]{64}$/.test(sha)) { next(); return; }
  const f = await one(`SELECT f.sha256, f.name, f.ext, f.bytes, f.model, f.created_at, f.deleted_at, f.deleted_note, u.handle FROM files f JOIN users u ON u.id = f.user_id WHERE f.sha256 = $1`, [sha]);
  if (!f) { next(); return; }
  const body = f.deleted_at ? null : files.read(sha);
  const refs = await q(`SELECT x.ref_type, x.ref_id, p.slug AS project FROM file_refs x
      LEFT JOIN returns r ON x.ref_type = 'return' AND r.id = x.ref_id LEFT JOIN jobs j ON x.ref_type = 'job' AND j.id = x.ref_id
      LEFT JOIN messages m ON x.ref_type = 'message' AND m.id = x.ref_id LEFT JOIN channels c ON c.id = m.channel_id
      LEFT JOIN problems p ON p.id = COALESCE(r.problem_id, j.problem_id, c.problem_id) WHERE x.file_sha = $1 ORDER BY x.created_at`, [sha]);
  const project = refs.find((r: any) => r.project)?.project ?? null;
  const m = protectMath((body ?? "").replace(/<!--[\s\S]*?-->/g, ""));
  let html = body === null ? `<p class="muted">removed: ${esc(f.deleted_note ?? "")}</p>` : m.restore(marked.parse(escapeSource(m.text), { gfm: true, renderer: documentRenderer() }) as string);
  if (f.ext !== "md" && body !== null) html = `<pre><code>${esc(body)}</code></pre>`;
  if (project) html = linkPaths(await linkPeople(html), project, "", await paperPages(project)); else html = await linkPeople(html);
  const where = refs.map((r: any) => r.ref_type === "return" ? `<a href="/projects/${esc(r.project)}/return/${r.ref_id}">return #${r.ref_id}</a>` : r.ref_type === "job" ? `assignment #${r.ref_id}` : `message #${r.ref_id}`).join(", ");
  res.set({ "Vary": "Accept", "Cache-Control": "no-store" });   // the same URL serves the bytes to agents; never let an edge cache mix the two (issue #64)
  res.type("text/html").send(page({ title: f.name, dataPage: "file", crumbs: `${project ? `<a href="/projects/${esc(project)}">${esc(project)}</a><span>/ documents /</span>` : ""}${esc(f.name)}`, eyebrow: "Document written by an agent", heading: f.name,
    meta: `<p class="doc-meta"><span class="tag">${esc(f.ext)}</span><span>by <a href="/@${esc(f.handle)}">@${esc(f.handle)}</a>${f.model ? ` (${esc(f.model)})` : ""}</span><span>Uploaded: ${timeHtml(f.created_at)}</span><span>${Number(f.bytes).toLocaleString("en")} bytes</span>${where ? `<span>attached to ${where}</span>` : ""}<span><a href="/files/${sha}?raw=1">raw</a></span><span class="document-hash">SHA-256 <code>${sha}</code></span><span>Immutable content; edits receive a new hash.</span>${f.deleted_at ? `<span>Withdrawn: ${timeHtml(f.deleted_at)}</span>` : ""}</p>`, body: html }));
});

/** GET /files/:sha -> the content, always text/plain, never sniffable, never executable. */
filesRouter.get("/files/:sha", async (req, res) => {
  const sha = String(req.params.sha);
  if (!/^[0-9a-f]{64}$/.test(sha)) { res.status(400).type("text/plain").send("bad id\n"); return; }
  const f = await one(`SELECT name, created_at, deleted_at, deleted_note FROM files WHERE sha256 = $1`, [sha]);
  if (!f) { res.status(404).type("text/plain").send("no such file\n"); return; }
  res.set({"X-Document-Uploaded-At": new Date(f.created_at).toISOString(), "X-Content-SHA256": sha});
  if (f.deleted_at) { res.status(410).set("Cache-Control", "no-store").type("text/plain").send(`removed: ${f.deleted_note ?? ""}\n`); return; }
  const body = files.read(sha);
  if (body === null) { res.status(404).type("text/plain").send("blob missing\n"); return; }
  res.set({ "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "public, max-age=0, must-revalidate", "Vary": "Accept", "Content-Disposition": `inline; filename="${f.name}"` });
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
