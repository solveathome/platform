import { Router } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";
import { q, one } from "../db/index.js";
import { optionalAuth, cookieToken } from "../lib/auth.js";
import { PUBLIC_DIR } from "../lib/paths.js";
import { TERMS_VERSION, termsMd } from "../lib/terms.js";

export const terms = Router();
const BASE = () => process.env.BASE_URL ?? "http://localhost:8600";

/** GET /terms : the terms. HTML for browsers, markdown for everything else. */
terms.get("/terms", (req, res) => {
  const md = termsMd(BASE());
  if ((req.header("accept") ?? "").includes("text/html")) {
    const html = readFileSync(join(PUBLIC_DIR, "terms.html"), "utf8").replace("__TERMS__", marked.parse(md) as string).replaceAll("__VERSION__", TERMS_VERSION);
    res.type("text/html").send(html); return;
  }
  res.type("text/markdown").send(md);
});

/** GET /terms/status : has the signed-in person accepted the current version? */
terms.get("/terms/status", optionalAuth, async (req: any, res) => {
  if (!req.user) { res.json({ signed_in: false, version: TERMS_VERSION, accepted: false }); return; }
  const u = await one<{ terms_version: string | null; terms_accepted_at: string | null }>(`SELECT terms_version, terms_accepted_at FROM users WHERE id = $1`, [req.user.id]);
  const accepted = u?.terms_version === TERMS_VERSION;
  res.json({ signed_in: true, handle: req.user.handle, version: TERMS_VERSION, accepted, accepted_version: u?.terms_version ?? null, accepted_at: accepted ? u?.terms_accepted_at ?? null : null });
});

/** POST /terms/accept { version } : the person accepts on the site. Cookie sessions only: an agent's bearer token cannot accept for its person. */
terms.post("/terms/accept", optionalAuth, async (req: any, res) => {
  if (!req.user) { res.status(401).json({ error: "sign in first" }); return; }
  if ((req.header("authorization") ?? "").startsWith("Bearer ") || !cookieToken(req)) { res.status(403).json({ error: "terms are accepted by the person on the site, not by an agent" }); return; }
  if (String(req.body?.version ?? "") !== TERMS_VERSION) { res.status(400).json({ error: `version must be ${TERMS_VERSION}` }); return; }
  await q(`UPDATE users SET terms_version = $2, terms_accepted_at = now() WHERE id = $1`, [req.user.id, TERMS_VERSION]);
  res.json({ ok: true, accepted: true, version: TERMS_VERSION });
});
