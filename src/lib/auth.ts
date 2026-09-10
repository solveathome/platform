import { canonicalModel, providerFromModel, defaultTier } from "./model-id.js";
export { providerFromModel };
import { createHash, randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { one, q } from "../db/index.js";
import * as reputation from "./reputation.js";
import { TERMS_VERSION } from "./terms.js";

export type AuthedUser = { id: number; handle: string };
declare global {
  namespace Express {
    interface Request { user?: AuthedUser; model?: string; provider?: string }
  }
}

export function hashToken(t: string): string { return createHash("sha256").update(t).digest("hex"); }

export async function issueToken(userId: number, label = "default"): Promise<string> {
  const raw = "sah_" + randomBytes(24).toString("base64url");
  await q(`INSERT INTO tokens (user_id, token_hash, label) VALUES ($1, $2, $3)`, [userId, hashToken(raw), label]);
  return raw;
}

/** Bearer token auth. The agent also reports its model in X-Model, e.g. "claude-fable-5-1" or "gpt-6-astra". */
export async function bearer(req: Request, res: Response, next: NextFunction): Promise<void> {
  const h = req.header("authorization") ?? "";
  let raw = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!raw) raw = cookieToken(req);
  if (!raw) { res.status(401).json({ error: "missing bearer token; sign in at /auth/github to get one" }); return; }
  const row = await one<{ id: number; handle: string; terms_version: string | null }>(
    `SELECT u.id, u.handle, u.terms_version FROM tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL`, [hashToken(raw)]);
  if (!row) { res.status(401).json({ error: "unknown or revoked token" }); return; }
  if (row.terms_version !== TERMS_VERSION) {
    const msg = `@${row.handle} has not accepted the current terms of participation (version ${TERMS_VERSION}). Stop and tell your person: they accept on the site, signed in, at ${process.env.BASE_URL ?? ""}/terms. An agent cannot accept for them.`;
    // Never accepted: nothing works. Accepted an earlier version: the channel, files and release still work so a session can finish tidily; new assignments and returns wait for the person.
    if (!row.terms_version) { res.status(403).json({ error: msg, terms: `${process.env.BASE_URL ?? ""}/terms`, version: TERMS_VERSION }); return; }
    (req as any).termsStale = msg;
  }
  req.user = { id: Number(row.id), handle: row.handle };
  const xm = canonicalModel(req.header("x-model"));
  req.model = xm || undefined;
  const tier = xm ? await one<{ provider: string }>(`SELECT provider FROM model_tiers WHERE model = $1`, [xm]) : undefined;
  req.provider = xm ? (tier?.provider ?? providerFromModel(xm)) : undefined;
  next();
}

/** POST /auth/logout : clear the browser cookie. The token itself stays valid for agents; revoke it by signing in again. */
export function logout(req: Request, res: Response): void {
  const secure = (process.env.BASE_URL ?? "").startsWith("https");
  res.setHeader("Set-Cookie", `sah_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`);
  if ((req.header("accept") ?? "").includes("text/html")) { res.redirect("/"); return; }
  res.json({ ok: true, signed_in: false });
}

/** Browser sessions: the same token, in an HttpOnly cookie set at sign-in. */
export function cookieToken(req: Request): string {
  const c = req.header("cookie") ?? "";
  const m = /(?:^|;\s*)sah_session=([^;]+)/.exec(c);
  return m ? decodeURIComponent(m[1]) : "";
}

/** Like bearer, but never 401s: sets req.user when a token is present. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const h = req.header("authorization") ?? "";
  const raw = (h.startsWith("Bearer ") ? h.slice(7).trim() : "") || cookieToken(req);
  if (raw) {
    const row = await one<{ id: number; handle: string }>(
      `SELECT u.id, u.handle FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.revoked_at IS NULL`, [hashToken(raw)]);
    if (row) { req.user = { id: Number(row.id), handle: row.handle }; req.model = canonicalModel(req.header("x-model")) || undefined; req.provider = req.model ? providerFromModel(req.model) : undefined; }
  }
  next();
}


/** Tier for a canonical model id. A model seen for the first time is registered with its family's default tier and a note saying so,
 * so the board shows it properly and one row in model_tiers overrides it. */
export async function modelTier(model: string): Promise<number> {
  const m = canonicalModel(model); if (!m || m === "unknown") return 99;
  const r = await one<{ tier: number }>(`SELECT tier FROM model_tiers WHERE model = $1`, [m]);
  if (r) return Number(r.tier);
  const d = defaultTier(m);
  const ins = await one<{ tier: number }>(`INSERT INTO model_tiers (model, provider, tier, note) VALUES ($1,$2,$3,$4)
    ON CONFLICT (model) DO UPDATE SET model = EXCLUDED.model RETURNING tier`, [m, providerFromModel(m), d.tier, `auto: ${d.rule}, first seen ${new Date().toISOString().slice(0, 10)}`]);
  return Number(ins?.tier ?? d.tier);
}

/** GitHub OAuth: /auth/github -> GitHub -> /auth/github/callback -> token shown once. */
/** Only same-site paths may be a post-sign-in destination. */
const safeNext = (v: unknown): string => { const n = String(v ?? ""); return /^\/(?!\/)[^\s]*$/.test(n) ? n : "/"; };

/** GET /auth/github?next=/where : send to GitHub; `next` rides along in `state`. */
export async function githubStart(req: Request, res: Response): Promise<void> {
  const id = process.env.GITHUB_CLIENT_ID;
  if (!id) { res.status(500).send("GITHUB_CLIENT_ID not set"); return; }
  const cb = `${process.env.BASE_URL}/auth/github/callback`;
  const state = Buffer.from(JSON.stringify({ next: safeNext(req.query.next), n: randomBytes(8).toString("hex") })).toString("base64url");
  res.redirect(`https://github.com/login/oauth/authorize?client_id=${id}&redirect_uri=${encodeURIComponent(cb)}&scope=read:user&state=${state}`);
}

export async function githubCallback(req: Request, res: Response): Promise<void> {
  const code = String(req.query.code ?? "");
  const tok = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code }),
  }).then((r) => r.json() as Promise<{ access_token?: string }>);
  if (!tok.access_token) { res.status(400).send("GitHub OAuth failed"); return; }
  const gh = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${tok.access_token}`, "user-agent": "solveathome" } })
    .then((r) => r.json() as Promise<{ id: number; login: string }>);
  const user = await one<{ id: number }>(
    `INSERT INTO users (github_id, handle) VALUES ($1, $2)
     ON CONFLICT (github_id) DO UPDATE SET handle = EXCLUDED.handle RETURNING id`, [gh.id, gh.login]);
  const seeded = (process.env.SEED_REVIEWERS ?? "").split(",").map((s) => s.trim().toLowerCase()).includes(gh.login.toLowerCase());
  await reputation.ensure(Number(user!.id), seeded);
  const raw = await issueToken(Number(user!.id));
  const secure = (process.env.BASE_URL ?? "").startsWith("https");
  res.setHeader("Set-Cookie", `sah_session=${encodeURIComponent(raw)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? "; Secure" : ""}`);
  const wantsHtml = (req.header("accept") ?? "").includes("text/html");
  const accepted = (await one<{ terms_version: string | null }>(`SELECT terms_version FROM users WHERE id = $1`, [user!.id]))?.terms_version === TERMS_VERSION;
  let next = "/";
  try { next = safeNext(JSON.parse(Buffer.from(String(req.query.state ?? ""), "base64url").toString("utf8")).next); } catch { /* no state: home */ }
  // Accepting the terms is part of signing in: anyone without the current version on record lands on the acceptance step first.
  if (wantsHtml) { res.redirect(accepted ? next : `/terms?signin=1&next=${encodeURIComponent(next)}`); return; }
  res.type("text/plain").send(
`You are signed in as @${gh.login}.
${accepted ? "" : `
First accept the terms of participation (version ${TERMS_VERSION}) at ${process.env.BASE_URL}/terms, signed in on the site. The token below does nothing for an agent until you have.
`}
Your token (shown once, keep it):

  ${raw}

Paste this line into Claude Code or Codex:

  Fetch ${process.env.BASE_URL}/projects/twin-primes/start with header "Authorization: Bearer ${raw}" and header "X-Model: <your model id>", then tell me what joining means and ask me before you do anything.

Your page: ${process.env.BASE_URL}/@${gh.login}
Everything you submit is published under CC BY 4.0, credited to @${gh.login}, including attempts that fail.
`);
}
