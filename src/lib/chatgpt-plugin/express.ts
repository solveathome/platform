/**
 * Mount the plugin on this server: POST /mcp (public JSON-RPC, read-only) and the domain-verification answer OpenAI asks for at
 * submission. Mounted ahead of pathGuard (which refuses every dot-segment, /.well-known included), the site's CSP and the
 * per-address limiter: /mcp has no session, cookie or token, parses its own body and keeps its own limit.
 * A plugin with signed-in tools mounts at its own path (mountPlugin(app, plugin, { path })) and reads the bearer token itself.
 */
import express, { type Express, type Request, type Response } from "express";
import { answerMcp, challenge, CHALLENGE_PATH, type HttpAnswer, MAX_SIGNED_BODY, MCP_PATH, rateLimiter } from "./http.js";
import type { Plugin } from "./mcp.js";
import { clientIp } from "../ratelimit.js";

function send(res: Response, a: HttpAnswer): void {
  res.status(a.status);
  for (const [k, v] of Object.entries(a.headers)) res.setHeader(k, v);
  res.send(a.body);
}

const HEADERS = ["authorization", "user-agent", "mcp-protocol-version", "mcp-method", "mcp-name"];

export function mountPlugin(app: Express, plugin: Plugin, opts: { path?: string; challenge?: boolean } = {}): void {
  // Every ChatGPT user's calls arrive from OpenAI's servers, a handful of addresses, so the ceiling is per address but wide.
  const allow = rateLimiter(600);
  const body = express.text({ type: () => true, limit: plugin.config.auth ? MAX_SIGNED_BODY : "64kb" });
  app.all(opts.path ?? MCP_PATH, body, async (req: Request, res: Response) => {
    if (req.method === "POST" && !allow(clientIp(req))) {
      send(res, { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" }, body: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Too many requests" } }) });
      return;
    }
    const headers = Object.fromEntries(HEADERS.map((h) => [h, req.header(h) ?? undefined]));
    send(res, await answerMcp(plugin, req.method, typeof req.body === "string" ? req.body : undefined, plugin.config.auth ? headers : { "user-agent": headers["user-agent"] }));
  });
  // 404 until OPENAI_APPS_CHALLENGE holds the token OpenAI issues for the domain.
  if (opts.challenge !== false) app.get(CHALLENGE_PATH, (_req: Request, res: Response) => { send(res, challenge(process.env.OPENAI_APPS_CHALLENGE)); });
}
