/**
 * The OAuth 2.1 authorization server and the protected-resource metadata for the signed-in MCP tools (src/lib/oauth.ts). The
 * /.well-known documents are mounted ahead of pathGuard, which refuses dot-segments; the /oauth endpoints after the body parsers.
 * Everything answers 404 unless MCP_WORK_BETA=1.
 */
import express, { Router, type Express } from "express";
import { perIp, clientIp } from "../lib/ratelimit.js";
import * as oauth from "../lib/oauth.js";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version" };

export function mountWellKnown(app: Express): void {
  const doc = (body: () => Record<string, unknown>) => (req: express.Request, res: express.Response) => {
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    if (!oauth.betaOn()) { res.status(404).json({ error: "not found" }); return; }
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(body());
  };
  // RFC 9728: the path-aware document for the MCP resource, and the root one for clients that try it.
  for (const path of [`/.well-known/oauth-protected-resource${oauth.WORK_PATH}`, "/.well-known/oauth-protected-resource"]) app.all(path, doc(oauth.protectedResourceMetadata));
  for (const path of ["/.well-known/oauth-authorization-server", `/.well-known/oauth-authorization-server${oauth.WORK_PATH}`]) app.all(path, doc(oauth.authorizationServerMetadata));
}

export const oauthRoutes = Router();
const form = express.urlencoded({ extended: false, limit: "16kb" });
const cors: express.RequestHandler = (req, res, next) => { for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v); if (req.method === "OPTIONS") { res.status(204).end(); return; } next(); };
const noStore: express.RequestHandler = (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); res.setHeader("Pragma", "no-cache"); next(); };

oauthRoutes.get("/oauth/authorize", perIp("oauth-authorize", 30, 60_000), oauth.authorizeGet);
oauthRoutes.post("/oauth/authorize", perIp("oauth-authorize", 30, 60_000), form, oauth.authorizePost);
// Dynamic registration is the fallback (CIMD first): a few registrations an hour per address is plenty for a person, a wall for a flood.
oauthRoutes.all("/oauth/register", cors, noStore, perIp("oauth-register", 20, 3600_000), async (req, res) => {
  if (!oauth.betaOn()) { res.status(404).json({ error: "not found" }); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const r = await oauth.register(req.body, clientIp(req)); res.status(r.status).json(r.json);
});
oauthRoutes.all("/oauth/token", cors, noStore, perIp("oauth-token", 60, 60_000), form, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const r = await oauth.token(req);
  if (r.status === 401) res.setHeader("WWW-Authenticate", 'Basic realm="solveathome"');
  res.status(r.status).json(r.json);
});
oauthRoutes.all("/oauth/revoke", cors, noStore, perIp("oauth-token", 60, 60_000), form, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  await oauth.revoke(req); res.status(200).json({});
});
oauthRoutes.get("/settings/connections", oauth.connectionsPage);
oauthRoutes.post("/settings/connections/:id/disconnect", form, oauth.disconnectPost);
