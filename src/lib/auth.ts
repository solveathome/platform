import { hitDetailed } from "./ratelimit.js";
import { canonicalModel, providerFromModel, defaultTier, parseEffort, modelIdentityError, MODEL_IDENTITY_GUIDANCE } from "./model-id.js";
import { wantsHtml } from "./negotiate.js";
import { featuredProject } from "./projects.js";
export { providerFromModel };
import { createHash, randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { one, q, transaction } from "../db/index.js";
import { sealToken, openToken } from "./token-vault.js";
import * as reputation from "./reputation.js";
import { TERMS_VERSION } from "./terms.js";

export type AuthedUser = { id: number; handle: string };
declare global {
  namespace Express {
    interface Request { user?: AuthedUser; model?: string; provider?: string }
  }
}

export function hashToken(t: string): string { return createHash("sha256").update(t).digest("hex"); }

export class TokenRecoveryRequired extends Error {
  constructor() { super("Your existing agent token is still valid. Supply it once to restore display on this device, or explicitly invalidate it to create a replacement."); }
}

/** The account's exact agent token persists until explicit invalidation. */
export async function issueToken(userId: number, label = "default"): Promise<string> {
  return transaction(async () => {
    await q(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`agent-token:${userId}`]);
    const existing = await one(`SELECT token_ciphertext FROM tokens WHERE user_id=$1 AND revoked_at IS NULL ORDER BY id LIMIT 1`, [userId]);
    if (existing) {
      if (!existing.token_ciphertext) throw new TokenRecoveryRequired();
      try { return await openToken(existing.token_ciphertext, userId); }
      catch { throw new TokenRecoveryRequired(); }
    }
    const raw = "sah_" + randomBytes(24).toString("base64url");
    await q(`INSERT INTO tokens (user_id,token_hash,label,token_ciphertext) VALUES ($1,$2,$3,$4)`, [userId,hashToken(raw),label,await sealToken(raw,userId)]);
    return raw;
  });
}

/** A legacy token's first authenticated use recovers its original value, without rotation. */
export async function recoverToken(raw: string, userId: number): Promise<boolean> {
  const row = await one(`SELECT id FROM tokens WHERE user_id=$1 AND token_hash=$2 AND revoked_at IS NULL`, [userId,hashToken(raw)]);
  if (!row) return false;
  await q(`UPDATE tokens SET token_ciphertext=$2 WHERE id=$1`, [row.id,await sealToken(raw,userId)]);
  return true;
}
export async function invalidateToken(userId: number): Promise<void> {
  await transaction(async () => {
    await q(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`agent-token:${userId}`]);
    await q(`SELECT set_config('solveathome.invalidate_token','user-explicit',true)`);
    await q(`UPDATE tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
  });
}
export async function issueBrowserSession(userId: number): Promise<string> {
  const raw = "sahweb_" + randomBytes(24).toString("base64url");
  await q(`INSERT INTO browser_sessions(token_hash,user_id) VALUES ($1,$2)`, [hashToken(raw),userId]);
  return raw;
}
async function authenticated(raw: string, browser: boolean): Promise<any> {
  if (!raw || raw.length > 200) return null;
  const row = await one(`SELECT u.id,u.handle,u.terms_version,u.agent_account_id,t.token_ciphertext
    FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.revoked_at IS NULL`, [hashToken(raw)]);
  if (row) {
    if (!row.token_ciphertext) await recoverToken(raw,Number(row.id));
    return row;
  }
  return browser ? one(`SELECT u.id,u.handle,u.terms_version,u.agent_account_id FROM browser_sessions b JOIN users u ON u.id=b.user_id WHERE b.token_hash=$1`, [hashToken(raw)]) : null;
}

/** True when the request carries a bearer token (or session cookie) that exists and is not revoked. Used before buffering large bodies. */
export async function tokenExists(req: Request): Promise<boolean> {
  const h = req.header("authorization") ?? "";
  const raw = (h.startsWith("Bearer ") ? h.slice(7).trim() : "") || cookieToken(req);
  if (!raw || raw.length > 200) return false;
  return !!(await authenticated(raw, !h.startsWith("Bearer ")));
}

/** Bearer token auth. The agent also reports its model in X-Model, e.g. "claude-fable-5-1" or "gpt-6-astra". */
export async function bearer(req: Request, res: Response, next: NextFunction): Promise<void> {
  const h = req.header("authorization") ?? "";
  let raw = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!raw) raw = cookieToken(req);
  if (!raw) {
    // The ChatGPT app's web fetch cannot send headers or POST bodies (Chris, Sep 11 2026): say so in words the app will relay.
    if (/ChatGPT|OpenAI/i.test(req.header("user-agent") ?? "")) { res.status(401).json({ error: "You are reading this from the ChatGPT app's web fetch, which cannot send the Authorization header, the X-Model header or the POST bodies this API needs, so an agent cannot join from inside ChatGPT.", for_your_person: "Paste the same instruction into Codex (OpenAI's coding agent, CLI or cloud) or any agent with a shell, such as Claude Code. It signs in, registers and works the assignment from there; nothing else is needed.", codex: "https://openai.com/codex" }); return; }
    res.status(401).json({ error: "missing bearer token; sign in at /auth/github to get one" }); return;
  }
  const row = await authenticated(raw, !h.startsWith("Bearer "));
  if (!row) { res.status(401).json({ error: "unknown or revoked token" }); return; }
  // A session is seen on every authenticated request it makes (issue #19), not only at /start.
  const xs = String(req.header("x-session") ?? "").trim();
  if (xs && xs.length <= 64) await q(`UPDATE sessions SET last_seen = now() WHERE id = $1 AND user_id = $2 AND ended_at IS NULL AND (department_id IS NULL OR last_seen>now()-interval '120 minutes' OR NOT EXISTS(SELECT 1 FROM jobs WHERE assigned_session=sessions.id AND status='assigned'))`, [xs, row.id]);
  if (row.terms_version !== TERMS_VERSION) {
    const msg = `@${row.handle} has not accepted the current terms of participation (version ${TERMS_VERSION}). Stop and tell your person: they accept on the site, signed in, at ${process.env.BASE_URL ?? ""}/terms. An agent cannot accept for them.`;
    // Never accepted: nothing works. Accepted an earlier version: the channel, files and release still work so a session can finish tidily; everything else waits for the person.
    const tidy = /\/(release|files(\/|$)|chat\/[^?]*\/(messages|join|leave)|chat\/(join|leave))(\?|$)/.test(req.originalUrl);
    if (!row.terms_version || !tidy) { res.status(403).json({ error: msg, terms: `${process.env.BASE_URL ?? ""}/terms`, version: TERMS_VERSION }); return; }
    (req as any).termsStale = msg;
  }
  // Per-handle budget across its sessions (issue #35): the 429 says which sessions used it.
  { const limit = Number(process.env.RATE_LIMIT_PER_MIN ?? 1200); const r = hitDetailed(`user:${row.id}`, xs || "no X-Session", limit, 60_000);
    if (r.over) { res.setHeader("Retry-After", String(r.retryAfter)); res.status(429).json({ error: `rate limit: ${limit} requests per 60 s for this handle across all of its sessions; retry after ${r.retryAfter} s. Sessions on this handle in the last 60 s: ${r.top.map(([s, n]) => `${s.slice(0, 8)}: ${n}`).join(", ")}. A wait=30 listen is two requests a minute; a tight retry loop is what burns the budget.`, retry_after: r.retryAfter, sessions: Object.fromEntries(r.top) }); return; } }
  req.user = { id: Number(row.id), handle: row.handle };
  const xm = canonicalModel(req.header("x-model"));
  const identityError = modelIdentityError(xm);
  // A mistaken old identity must never prevent handing work back or ending the session.
  const ending = req.method === "POST" && /\/(?:release|sessions\/[^/]+\/end)$/.test(req.path);
  if (identityError && !ending) { res.status(400).json({ error: identityError, code: "model_identity_required", declared: xm }); return; }
  req.model = xm || undefined;
  (req as any).effort = parseEffort(req.header("x-effort")) ?? parseEffort(req.header("x-model"));
  const tier = xm ? await one<{ provider: string }>(`SELECT provider FROM model_tiers WHERE model = $1`, [xm]) : undefined;
  req.provider = xm ? (tier?.provider ?? providerFromModel(xm)) : undefined;
  next();
}

/** POST /auth/logout : clear the browser cookie. The token itself stays valid for agents; only explicit token invalidation revokes it. */
export async function logout(req: Request, res: Response): Promise<void> {
  await q(`DELETE FROM browser_sessions WHERE token_hash=$1`, [hashToken(cookieToken(req))]);
  const secure = (process.env.BASE_URL ?? "").startsWith("https");
  res.setHeader("Set-Cookie", `sah_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`);
  if (wantsHtml(req)) { res.redirect("/"); return; }
  res.json({ ok: true, signed_in: false });
}

/** Browser cookies are independent of permanent agent credentials. Legacy cookies remain usable. */
export function cookieToken(req: Request): string {
  const c = req.header("cookie") ?? "";
  const m = /(?:^|;\s*)sah_session=([^;]+)/.exec(c);
  try { return m ? decodeURIComponent(m[1]) : ""; } catch { return ""; }
}

/** Like bearer, but never 401s: sets req.user when a token is present. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const h = req.header("authorization") ?? "";
  const raw = (h.startsWith("Bearer ") ? h.slice(7).trim() : "") || cookieToken(req);
  if (raw) {
    const row = await authenticated(raw, !h.startsWith("Bearer "));
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
const safeNext = (v: unknown): string => { const n = String(v ?? ""); return /^\/(?![\/\\])[^\s\\]*$/.test(n) ? n : "/"; };

/** GET /auth/github?next=/where : send to GitHub; `next` rides along in `state`. */
export async function githubStart(req: Request, res: Response): Promise<void> {
  const id = process.env.GITHUB_CLIENT_ID;
  if (!id) { res.status(500).send("GITHUB_CLIENT_ID not set"); return; }
  const cb = `${process.env.BASE_URL}/auth/github/callback`;
  const nonce = randomBytes(12).toString("hex");
  const state = Buffer.from(JSON.stringify({ next: safeNext(req.query.next), n: nonce })).toString("base64url");
  // The nonce also lives in a short-lived cookie: the callback only completes in the browser that started it (no login CSRF).
  const secure = (process.env.BASE_URL ?? "").startsWith("https");
  res.setHeader("Set-Cookie", `sah_oauth=${nonce}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`);
  res.redirect(`https://github.com/login/oauth/authorize?client_id=${id}&redirect_uri=${encodeURIComponent(cb)}&scope=read:user&state=${state}`);
}

export async function githubCallback(req: Request, res: Response): Promise<void> {
  const code = String(req.query.code ?? "");
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(code)) { res.status(400).type("text/plain").send("Sign-in failed (no code). Go back to the site and sign in again.\n"); return; }
  let st: { next?: unknown; n?: unknown } = {};
  try { st = JSON.parse(Buffer.from(String(req.query.state ?? ""), "base64url").toString("utf8")); } catch { /* no state */ }
  const cookieNonce = /(?:^|;\s*)sah_oauth=([a-f0-9]+)/.exec(req.header("cookie") ?? "")?.[1];
  if (!st.n || !cookieNonce || st.n !== cookieNonce) { res.status(400).type("text/plain").send("Sign-in did not start in this browser (state mismatch). Go back to the site and sign in again.\n"); return; }
  const tok = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code }),
  }).then((r) => r.json() as Promise<{ access_token?: string }>);
  if (!tok.access_token) { res.status(400).send("GitHub OAuth failed"); return; }
  const gh = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${tok.access_token}`, "user-agent": "solveathome" }, signal: AbortSignal.timeout(10_000) })
    .then((r) => r.json() as Promise<{ id: number; login: string }>);
  const user = await one<{ id: number }>(
    `INSERT INTO users (github_id, handle) VALUES ($1, $2)
     ON CONFLICT (github_id) DO UPDATE SET handle = EXCLUDED.handle RETURNING id`, [gh.id, gh.login]);
  const seeded = (process.env.SEED_REVIEWERS ?? "").split(",").map((s) => s.trim().toLowerCase()).includes(gh.login.toLowerCase());
  await reputation.ensure(Number(user!.id), seeded);
  // Browser sign-in never changes or invalidates an agent credential.
  const raw = await issueBrowserSession(Number(user!.id));
  const secure = (process.env.BASE_URL ?? "").startsWith("https");
  res.setHeader("Set-Cookie", [`sah_session=${encodeURIComponent(raw)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? "; Secure" : ""}`, `sah_oauth=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`]);
  const wantsHtmlNow = wantsHtml(req);
  const accepted = (await one<{ terms_version: string | null }>(`SELECT terms_version FROM users WHERE id = $1`, [user!.id]))?.terms_version === TERMS_VERSION;
  const next = safeNext(st.next);
  // Accepting the terms is part of signing in: anyone without the current version on record lands on the acceptance step first.
  if (wantsHtmlNow) { res.redirect(accepted ? next : `/terms?signin=1&next=${encodeURIComponent(next)}`); return; }
  res.type("text/plain").send(`Signed in as @${gh.login}. Open ${process.env.BASE_URL}/projects/${(await featuredProject())?.slug ?? ""} to copy your joining instruction. Your agent token is unchanged.\n`);
}
