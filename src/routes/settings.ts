/** /settings : what a signed-in person sets about themselves on the site. Today: the display name (src/lib/display-name.ts). */
import { Router, type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { one } from "../db/index.js";
import { optionalAuth, cookieToken } from "../lib/auth.js";
import { PUBLIC_DIR } from "../lib/paths.js";
import { hit } from "../lib/ratelimit.js";
import { nameStatus, setName, clearName, removeName, unlockName, NameRefused } from "../lib/display-name.js";

export const settings = Router();
const OWNER_SET = new Set((process.env.OWNER_HANDLES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

/**
 * A person on the site, never an agent: a browser session cookie (sahweb_), no bearer header, same origin.
 * An agent token placed in a cookie is refused too, so nothing an agent holds can name its person.
 */
function personOnSite(req: Request, res: Response): boolean {
  if (!req.user) { res.status(401).json({ error: "Sign in first." }); return false; }
  const site = req.header("sec-fetch-site");
  if ((req.header("authorization") ?? "").startsWith("Bearer ") || (site && site !== "same-origin")) { res.status(403).json({ error: "A display name is set by the person, signed in on the site. An agent cannot set it." }); return false; }
  if (!cookieToken(req).startsWith("sahweb_")) { res.status(403).json({ error: "This browser is signed in with an older kind of session. Sign out, sign in again, and it works.", code: "sign_in_again" }); return false; }
  if (hit(`display-name:${req.user.id}`, 20, 60_000).over) { res.status(429).json({ error: "Too many tries. Wait a minute." }); return false; }
  return true;
}

settings.get("/settings", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.type("text/html").send(readFileSync(join(PUBLIC_DIR, "settings.html"), "utf8"));
});

/** GET /me/display-name : the signed-in person's name, the lock if there is one, and how many changes are left. */
settings.get("/me/display-name", optionalAuth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!req.user) { res.status(401).json({ error: "Sign in first." }); return; }
  res.json(await nameStatus(req.user.id));
});

/** POST /me/display-name { name } : set it. An empty name clears it. */
settings.post("/me/display-name", optionalAuth, async (req, res) => {
  if (!personOnSite(req, res)) return;
  const raw = String(req.body?.name ?? "").slice(0, 400);
  try { res.json(raw.trim() ? await setName(req.user!.id, raw) : await clearName(req.user!.id)); }
  catch (e) { if (e instanceof NameRefused) { res.status(e.status).json({ error: e.message, code: e.code }); return; } throw e; }
});

/** DELETE /me/display-name : clear it. Always possible. */
settings.delete("/me/display-name", optionalAuth, async (req, res) => {
  if (!personOnSite(req, res)) return;
  res.json(await clearName(req.user!.id));
});

/** GET /@:handle/display-name : the lock state, for the owner's control on the contributor page. Nobody else gets it. */
settings.get("/@:handle/display-name", optionalAuth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!req.user || !OWNER_SET.has(req.user.handle.toLowerCase())) { res.status(403).json({ error: "Only the site owner can see this." }); return; }
  const target = await one<{ id: number }>(`SELECT id FROM users WHERE lower(handle) = lower($1)`, [req.params.handle]);
  if (!target) { res.status(404).json({ error: "no such contributor" }); return; }
  const st = await nameStatus(Number(target.id));
  res.json({ handle: st.handle, display_name: st.display_name, locked: st.locked, lock_note: st.lock_note });
});

/** POST /@:handle/display-name/remove { note, lock } and /unlock { note } : the site owner acts on abuse. The note goes to the person, not the public. */
settings.post("/@:handle/display-name/:act", optionalAuth, async (req, res) => {
  const act = String(req.params.act);
  if (act !== "remove" && act !== "unlock") { res.status(404).json({ error: "not found" }); return; }
  if (!personOnSite(req, res)) return;
  if (!OWNER_SET.has(req.user!.handle.toLowerCase())) { res.status(403).json({ error: "Only the site owner can do this." }); return; }
  const target = await one<{ id: number }>(`SELECT id FROM users WHERE lower(handle) = lower($1)`, [req.params.handle]);
  if (!target) { res.status(404).json({ error: "no such contributor" }); return; }
  const note = String(req.body?.note ?? "").trim().slice(0, 500);
  if (note.length < 5) { res.status(400).json({ error: "Say why, in a sentence. The person reads this note." }); return; }
  if (act === "remove") await removeName(Number(target.id), req.user!.id, note, req.body?.lock === true);
  else await unlockName(Number(target.id), req.user!.id, note);
  const st = await nameStatus(Number(target.id));
  res.json({ ok: true, handle: st.handle, display_name: st.display_name, locked: st.locked });
});
