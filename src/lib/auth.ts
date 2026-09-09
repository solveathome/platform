import { createHash, randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { one, q } from "../db/index.js";
import * as reputation from "./reputation.js";

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
  const raw = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!raw) { res.status(401).json({ error: "missing bearer token; sign in at /auth/github to get one" }); return; }
  const row = await one<{ id: number; handle: string }>(
    `SELECT u.id, u.handle FROM tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL`, [hashToken(raw)]);
  if (!row) { res.status(401).json({ error: "unknown or revoked token" }); return; }
  req.user = { id: Number(row.id), handle: row.handle };
  req.model = (req.header("x-model") ?? "unknown").toLowerCase();
  const tier = await one<{ provider: string }>(`SELECT provider FROM model_tiers WHERE model = $1`, [req.model]);
  req.provider = tier?.provider ?? providerFromModel(req.model);
  next();
}

export function providerFromModel(m: string): string {
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("o") || m.includes("codex")) return "openai";
  if (m.startsWith("gemini")) return "google";
  return "unknown";
}

export async function modelTier(model: string): Promise<number> {
  const r = await one<{ tier: number }>(`SELECT tier FROM model_tiers WHERE model = $1`, [model]);
  return r ? Number(r.tier) : 99;
}

/** GitHub OAuth: /auth/github -> GitHub -> /auth/github/callback -> token shown once. */
export async function githubStart(_req: Request, res: Response): Promise<void> {
  const id = process.env.GITHUB_CLIENT_ID;
  if (!id) { res.status(500).send("GITHUB_CLIENT_ID not set"); return; }
  const cb = `${process.env.BASE_URL}/auth/github/callback`;
  res.redirect(`https://github.com/login/oauth/authorize?client_id=${id}&redirect_uri=${encodeURIComponent(cb)}&scope=read:user`);
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
  res.type("text/plain").send(
`You are signed in as @${gh.login}.

Your token (shown once, keep it):

  ${raw}

Paste this line into Claude Code or Codex:

  Fetch ${process.env.BASE_URL}/projects/twin-primes/job with header "Authorization: Bearer ${raw}" and header "X-Model: <your model id>", then do what the brief says.

Your page: ${process.env.BASE_URL}/@${gh.login}
Everything you submit is published under CC BY 4.0, credited to @${gh.login}, including attempts that fail.
`);
}
