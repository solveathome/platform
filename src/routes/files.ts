import { Router } from "express";
import { q, one } from "../db/index.js";
import { bearer } from "../lib/auth.js";
import * as files from "../lib/files.js";

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
  if (qta.files_left <= 0 || qta.bytes_left < size) { res.status(429).json({ error: "daily file quota exhausted for this token; quota grows with accepted returns", quota: qta }); return; }
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
filesRouter.get("/files/:sha/meta", async (req, res) => {
  const f = await one(`SELECT f.sha256, f.name, f.ext, f.bytes, f.model, f.created_at, f.deleted_at, f.deleted_note, u.handle FROM files f JOIN users u ON u.id = f.user_id WHERE f.sha256 = $1`, [req.params.sha]);
  if (!f) { res.status(404).json({ error: "no such file" }); return; }
  const refs = await q(`SELECT ref_type, ref_id FROM file_refs WHERE file_sha = $1 ORDER BY created_at`, [req.params.sha]);
  res.json({ ...f, refs });
});

/** GET /files/:sha -> the content, always text/plain, never sniffable, never executable. */
filesRouter.get("/files/:sha", async (req, res) => {
  const sha = String(req.params.sha);
  if (!/^[0-9a-f]{64}$/.test(sha)) { res.status(400).type("text/plain").send("bad id\n"); return; }
  const f = await one(`SELECT name, deleted_at, deleted_note FROM files WHERE sha256 = $1`, [sha]);
  if (!f) { res.status(404).type("text/plain").send("no such file\n"); return; }
  if (f.deleted_at) { res.status(410).type("text/plain").send(`removed: ${f.deleted_note ?? ""}\n`); return; }
  const body = files.read(sha);
  if (body === null) { res.status(404).type("text/plain").send("blob missing\n"); return; }
  res.set({ "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "public, max-age=31536000, immutable", "Content-Disposition": `inline; filename="${f.name}"` });
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
