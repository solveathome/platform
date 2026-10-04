/**
 * solveathome.org as its own OAuth 2.1 authorization server, for the signed-in MCP tools (#sah-mcp-real-work-build, Chris, Oct 4 2026:
 * "allowing people using ChatGPT and not Codex would be amazing"). The MCP authorization spec (2025-11-25 and 2026-07-28): the MCP
 * endpoint is a resource server with protected-resource metadata (RFC 9728); this module is the authorization server (RFC 8414
 * metadata, authorization code with PKCE S256 only, RFC 8707 resource binding, RFC 9207 `iss` in the redirect), with clients identified
 * by a Client ID Metadata Document (an https client_id, preferred) or by dynamic registration (RFC 7591, kept as the fallback).
 *
 * Sign-up happens here: the authorize page sends a person who is not signed in through the site's GitHub sign-in (which creates the
 * account), then asks for one thing, "I accept the Terms", per client. Tokens are opaque, stored as hashes, scoped to `contribute`, and
 * bound to the MCP resource. The person's agent token (tokens table) is never read or changed here.
 *
 * Beta: everything is off unless MCP_WORK_BETA=1; MCP_WORK_HANDLES (comma-separated) limits who may connect while it is set.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Request, Response } from "express";
import { one, q, transaction } from "../db/index.js";
import { hashToken, cookieToken } from "./auth.js";
import { TERMS_VERSION } from "./terms.js";
import { esc, page } from "./page.js";
import type { AuthInfo } from "./chatgpt-plugin/index.js";

export const WORK_PATH = "/mcp/beta";
export const SCOPE = "contribute";
const ACCESS_TTL_S = 3600;
/** A refresh token lives 90 days from its last use: the connection lasts until the person disconnects it, or three idle months. */
const REFRESH_TTL_DAYS = 90;
const CODE_TTL_S = 600;
const REQUEST_TTL_MIN = 10;
const CIMD_TTL_H = 24;

export const betaOn = (): boolean => process.env.MCP_WORK_BETA === "1";
const base = (): string => (process.env.BASE_URL ?? "http://localhost:8600").replace(/\/$/, "");
export const issuer = (): string => base();
export const resourceUrl = (): string => `${base()}${WORK_PATH}`;
export const resourceMetadataUrl = (): string => `${base()}/.well-known/oauth-protected-resource${WORK_PATH}`;
const betaHandles = (): Set<string> => new Set((process.env.MCP_WORK_HANDLES ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));

const sha = (v: string): string => createHash("sha256").update(v).digest("hex");
const b64url = (buf: Buffer): string => buf.toString("base64url");

export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: resourceUrl(),
    authorization_servers: [issuer()],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Solve at Home",
    resource_documentation: `${base()}/terms`,
  };
}

export function authorizationServerMetadata(): Record<string, unknown> {
  const i = issuer();
  return {
    issuer: i,
    authorization_endpoint: `${i}/oauth/authorize`,
    token_endpoint: `${i}/oauth/token`,
    registration_endpoint: `${i}/oauth/register`,
    revocation_endpoint: `${i}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${i}/terms`,
  };
}

/** PKCE S256: base64url(SHA-256(verifier)) equals the challenge. */
export function pkceOk(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const got = Buffer.from(b64url(createHash("sha256").update(verifier).digest()));
  const want = Buffer.from(challenge);
  return got.length === want.length && timingSafeEqual(got, want);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** A redirect URI a client may register: https, or http on a loopback address (native clients, RFC 8252). No fragments, no credentials. */
export function redirectUriOk(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length > 2000) return false;
  try {
    const u = new URL(raw);
    if (u.hash || u.username || u.password) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && LOOPBACK.has(u.hostname);
  } catch { return false; }
}

/** Exact match, except that a loopback redirect may use any port (RFC 8252 §7.3). */
export function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let g: URL; try { g = new URL(given); } catch { return false; }
  if (g.protocol !== "http:" || !LOOPBACK.has(g.hostname)) return false;
  return registered.some((r) => { try { const u = new URL(r); return u.protocol === "http:" && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search; } catch { return false; } });
}

/** Which chat app a client is: it names the session's model label (the model itself is never measured). */
export function hostOf(clientId: string, redirectUris: string[]): string {
  const hosts = [clientId, ...redirectUris].map((u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } });
  if (hosts.some((h) => /(^|\.)(chatgpt\.com|openai\.com)$/.test(h))) return "chatgpt";
  if (hosts.some((h) => /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/.test(h))) return "claude";
  return "other";
}
export const MODEL_LABEL: Record<string, string> = { chatgpt: "chatgpt-unmeasured", claude: "claude-chat-unmeasured", other: "mcp-unmeasured" };
export const HOST_NAME: Record<string, string> = { chatgpt: "ChatGPT", claude: "Claude", other: "a chat app" };

/** A private, loopback or link-local address: never fetched for a client metadata document (SSRF). */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v); return m ? privateAddress(m[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

type Client = { client_id: string; kind: string; client_name: string; redirect_uris: string[]; secret_hash: string | null; auth_method: string; host: string };

/** Validate a fetched Client ID Metadata Document against the URL it came from. */
export function cimdDocument(url: string, doc: any): { ok: true; client: Omit<Client, "secret_hash" | "kind"> } | { ok: false; error: string } {
  if (!doc || typeof doc !== "object") return { ok: false, error: "the client metadata document is not a JSON object" };
  if (doc.client_id !== url) return { ok: false, error: "the client metadata document's client_id is not its own URL" };
  const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter(redirectUriOk).slice(0, 20) : [];
  if (!uris.length) return { ok: false, error: "the client metadata document lists no usable redirect_uris" };
  // A public client with PKCE. ChatGPT's document prefers private_key_jwt and lists none among the methods it supports (Oct 4 2026): this
  // server advertises none, so the client authenticates with none and PKCE carries the proof.
  const method = String(doc.token_endpoint_auth_method ?? "none");
  const supported = Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported.map(String) : [];
  if (method !== "none" && !supported.includes("none")) return { ok: false, error: `token_endpoint_auth_method ${method} is not supported for a client metadata document; use none (PKCE)` };
  return { ok: true, client: { client_id: url, client_name: String(doc.client_name ?? new URL(url).hostname).slice(0, 120), redirect_uris: uris, auth_method: "none", host: hostOf(url, uris) } };
}

async function fetchCimd(url: string): Promise<any> {
  const u = new URL(url);
  if (u.protocol !== "https:" || (u.port && u.port !== "443") || u.username || u.password || u.hash || u.pathname === "/") throw new Error("client_id must be an https URL with a path");
  const addrs = await lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw new Error("client_id host resolves to a private address");
  const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`client metadata document answered ${r.status}`);
  const text = await r.text();
  if (text.length > 64 * 1024) throw new Error("client metadata document is larger than 64 KB");
  return JSON.parse(text);
}

/** The client behind a client_id: a cached or freshly fetched metadata document for an https id, a registered row otherwise. */
export async function getClient(clientId: string): Promise<Client | { error: string }> {
  if (!clientId || clientId.length > 500) return { error: "client_id is missing" };
  const row = await one<any>(`SELECT * FROM oauth_clients WHERE client_id = $1`, [clientId]);
  if (/^https:\/\//.test(clientId)) {
    if (row && row.fetched_at && Date.now() - new Date(row.fetched_at).getTime() < CIMD_TTL_H * 3600_000) return row;
    let doc: any;
    try { doc = await fetchCimd(clientId); } catch (e: any) { return row ?? { error: `could not read the client metadata document: ${e?.message ?? e}` }; }
    const v = cimdDocument(clientId, doc);
    if (!v.ok) return { error: v.error };
    const saved = await one<any>(`INSERT INTO oauth_clients (client_id, kind, client_name, redirect_uris, auth_method, host, metadata, fetched_at) VALUES ($1,'cimd',$2,$3,'none',$4,$5,now())
      ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, redirect_uris = EXCLUDED.redirect_uris, host = EXCLUDED.host, metadata = EXCLUDED.metadata, fetched_at = now() RETURNING *`,
      [clientId, v.client.client_name, JSON.stringify(v.client.redirect_uris), v.client.host, JSON.stringify(doc).slice(0, 16000)]);
    return saved;
  }
  return row && row.kind === "dcr" ? row : { error: "unknown client_id" };
}

/** POST /oauth/register (RFC 7591), the fallback for clients without a metadata document. */
export async function register(body: any, ip: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
  if (!uris.length || uris.length > 20 || !uris.every(redirectUriOk)) return { status: 400, json: { error: "invalid_redirect_uri", error_description: "redirect_uris must be https URLs, or http on localhost" } };
  const method = String(body?.token_endpoint_auth_method ?? "client_secret_basic");
  if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) return { status: 400, json: { error: "invalid_client_metadata", error_description: "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic" } };
  const grants = Array.isArray(body?.grant_types) ? body.grant_types : ["authorization_code"];
  if (grants.some((g: unknown) => !["authorization_code", "refresh_token"].includes(String(g)))) return { status: 400, json: { error: "invalid_client_metadata", error_description: "grant_types: authorization_code and refresh_token only" } };
  const clientId = `sahc_${b64url(randomBytes(16))}`;
  const secret = method === "none" ? null : `sahcs_${b64url(randomBytes(24))}`;
  const name = String(body?.client_name ?? "").slice(0, 120) || new URL(uris[0]).hostname;
  await q(`INSERT INTO oauth_clients (client_id, kind, client_name, redirect_uris, secret_hash, auth_method, host, metadata, registered_ip) VALUES ($1,'dcr',$2,$3,$4,$5,$6,$7,$8)`,
    [clientId, name, JSON.stringify(uris), secret ? sha(secret) : null, method, hostOf("", uris), JSON.stringify(body ?? {}).slice(0, 16000), ip]);
  return { status: 201, json: { client_id: clientId, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: method, scope: SCOPE } };
}

/** Who the browser is: the site's cookie session. */
async function browserUser(req: Request): Promise<{ id: number; handle: string; terms_version: string | null } | null> {
  const raw = cookieToken(req);
  if (!raw || raw.length > 200) return null;
  return (await one<any>(`SELECT u.id, u.handle, u.terms_version FROM browser_sessions b JOIN users u ON u.id = b.user_id WHERE b.token_hash = $1`, [hashToken(raw)])) ?? null;
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

function errorPage(res: Response, status: number, heading: string, text: string): void {
  res.status(status).setHeader("Cache-Control", "no-store");
  res.type("text/html").send(page({ title: "Connect", crumbs: `<a href="/">solveathome</a>`, heading, body: `<p>${esc(text)}</p>`, robots: "noindex" }));
}

/** The scope asked for, cut to what exists: only `contribute`. */
export function cleanScope(raw: unknown): string | null {
  const asked = String(raw ?? "").split(/\s+/).filter(Boolean);
  if (!asked.length) return SCOPE;
  return asked.includes(SCOPE) ? SCOPE : null;
}
const resourceOk = (r: unknown): boolean => r === undefined || r === "" || String(r).replace(/\/$/, "") === resourceUrl();

/** GET /oauth/authorize */
export async function authorizeGet(req: Request, res: Response): Promise<void> {
  if (!betaOn()) { errorPage(res, 404, "Not available", "Connecting a chat app is not open on this site."); return; }
  const p = req.query as Record<string, string | undefined>;
  const client = await getClient(String(p.client_id ?? ""));
  if ("error" in client) { errorPage(res, 400, "This app cannot connect", client.error); return; }
  const registered = client.redirect_uris;
  const redirectUri = p.redirect_uri ? String(p.redirect_uri) : registered.length === 1 ? registered[0] : "";
  if (!redirectUri || !redirectMatches(registered, redirectUri)) { errorPage(res, 400, "This app cannot connect", "The redirect address is not one the app registered."); return; }
  // From here an error goes back to the app, which shows it.
  const back = (error: string, description: string): void => { res.redirect(302, withParams(redirectUri, { error, error_description: description, state: p.state, iss: issuer() })); };
  if (p.response_type !== "code") { back("unsupported_response_type", "only response_type=code"); return; }
  if (!p.code_challenge || p.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(String(p.code_challenge))) { back("invalid_request", "PKCE with code_challenge_method=S256 is required"); return; }
  const scope = cleanScope(p.scope);
  if (!scope) { back("invalid_scope", `the only scope is ${SCOPE}`); return; }
  if (!resourceOk(p.resource)) { back("invalid_target", `the resource is ${resourceUrl()}`); return; }
  const user = await browserUser(req);
  if (!user) {
    // Sign-up is sign-in: GitHub creates the account on the first visit and comes back here (auth.ts skips the site's own steps for /oauth).
    res.redirect(302, `/auth/github?next=${encodeURIComponent(req.originalUrl)}`); return;
  }
  const allowed = betaHandles();
  if (allowed.size && !allowed.has(user.handle.toLowerCase())) { back("access_denied", "Chat contributions are in a private beta"); return; }
  const id = b64url(randomBytes(18)), csrf = b64url(randomBytes(18));
  await q(`DELETE FROM oauth_requests WHERE created_at < now() - ($1::int * interval '1 minute')`, [REQUEST_TTL_MIN]);
  await q(`INSERT INTO oauth_requests (id, client_id, redirect_uri, state, scope, resource, code_challenge, csrf) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, client.client_id, redirectUri, p.state ? String(p.state).slice(0, 1000) : null, scope, resourceUrl(), String(p.code_challenge), csrf]);
  // Reconnecting an app the person already allowed, on the current terms: no second question.
  const prior = user.terms_version === TERMS_VERSION ? await one(`SELECT 1 FROM oauth_grants WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL AND terms_version = $3`, [user.id, client.client_id, TERMS_VERSION]) : null;
  if (prior) { res.redirect(302, await approve(id, user.id)); return; }
  consentPage(res, { id, csrf, client, user, redirectUri });
}

function consentPage(res: Response, o: { id: string; csrf: string; client: Client; user: { handle: string }; redirectUri: string; error?: string }): void {
  const app = o.client.host === "other" ? o.client.client_name : HOST_NAME[o.client.host];
  const origin = new URL(o.redirectUri).origin;
  // The answer redirects to the app: a form's redirect is checked against form-action, so the app's origin is allowed here only.
  res.setHeader("Content-Security-Policy", `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' ${origin}`);
  res.setHeader("Cache-Control", "no-store");
  const body = `<form method="post" action="/oauth/authorize" class="consent">
<p>${esc(app)} wants to work on open problems for you, as <b>@${esc(o.user.handle)}</b>. It can take an assignment, read its files and send your result. Everything it sends is public, under your name.</p>
<p class="muted">App: ${esc(o.client.client_name)} · returns to ${esc(origin)}</p>
${o.error ? `<p role="alert"><b>${esc(o.error)}</b></p>` : ""}
<input type="hidden" name="request_id" value="${esc(o.id)}"><input type="hidden" name="csrf" value="${esc(o.csrf)}">
<p><label><input type="checkbox" name="accept_terms" value="yes" required> I accept the <a href="/terms" target="_blank" rel="noopener">Terms</a></label></p>
<p><button class="button" type="submit" name="action" value="allow">Allow</button> <button class="link-button" type="submit" name="action" value="deny" formnovalidate>Cancel</button></p>
</form>`;
  res.type("text/html").send(page({ title: "Connect", crumbs: `<a href="/">solveathome</a>`, heading: `Connect ${app} to Solve at Home`, body, robots: "noindex", dataPage: "connect" }));
}

/** Consent given: record the terms, the grant and a one-time code; the redirect back to the app. */
async function approve(requestId: string, userId: number): Promise<string> {
  return transaction(async () => {
    const r = await one<any>(`DELETE FROM oauth_requests WHERE id = $1 RETURNING *`, [requestId]);
    if (!r) throw new Error("the request is gone");
    const u = await one<{ terms_version: string | null }>(`SELECT terms_version FROM users WHERE id = $1`, [userId]);
    if (u?.terms_version !== TERMS_VERSION) {
      await q(`UPDATE users SET terms_version = $2, terms_accepted_at = now() WHERE id = $1`, [userId, TERMS_VERSION]);
      await q(`INSERT INTO terms_acceptances (user_id, version, via, client_id) VALUES ($1,$2,'oauth',$3)`, [userId, TERMS_VERSION, r.client_id]);
    }
    const g = await one<{ id: number }>(`INSERT INTO oauth_grants (user_id, client_id, scope, resource, terms_version) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [userId, r.client_id, r.scope, r.resource, TERMS_VERSION]);
    const code = `sahac_${b64url(randomBytes(24))}`;
    await q(`INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at) VALUES ($1,$2,$3,$4, now() + ($5::int * interval '1 second'))`, [sha(code), g!.id, r.redirect_uri, r.code_challenge, CODE_TTL_S]);
    await q(`UPDATE oauth_clients SET last_used_at = now() WHERE client_id = $1`, [r.client_id]);
    return withParams(r.redirect_uri, { code, state: r.state ?? undefined, iss: issuer() });
  });
}

/** POST /oauth/authorize: the consent form. */
export async function authorizePost(req: Request, res: Response): Promise<void> {
  if (!betaOn()) { errorPage(res, 404, "Not available", "Connecting a chat app is not open on this site."); return; }
  const b = (req.body ?? {}) as Record<string, string>;
  const user = await browserUser(req);
  const r = await one<any>(`SELECT * FROM oauth_requests WHERE id = $1 AND created_at > now() - ($2::int * interval '1 minute')`, [String(b.request_id ?? ""), REQUEST_TTL_MIN]);
  if (!user || !r || !b.csrf || String(b.csrf) !== r.csrf) { errorPage(res, 400, "This request expired", "Go back to your chat app and connect again."); return; }
  const client = await getClient(r.client_id);
  if ("error" in client) { errorPage(res, 400, "This app cannot connect", client.error); return; }
  if (b.action !== "allow") {
    await q(`DELETE FROM oauth_requests WHERE id = $1`, [r.id]);
    res.redirect(302, withParams(r.redirect_uri, { error: "access_denied", error_description: "The person did not allow the connection", state: r.state ?? undefined, iss: issuer() })); return;
  }
  if (b.accept_terms !== "yes") { consentPage(res, { id: r.id, csrf: r.csrf, client, user, redirectUri: r.redirect_uri, error: "Tick “I accept the Terms” to connect." }); return; }
  res.redirect(302, await approve(r.id, user.id));
}

type TokenAnswer = { status: number; json: Record<string, unknown>; headers?: Record<string, string> };
const tokenError = (error: string, description: string, status = 400): TokenAnswer => ({ status, json: { error, error_description: description } });

/** The client a token request authenticates as: client_secret_basic, client_secret_post, or none (a public client with PKCE). */
async function tokenClient(req: Request, body: Record<string, string>): Promise<Client | TokenAnswer> {
  let id = body.client_id, secret = body.client_secret;
  // A client that sends private_key_jwt names itself in the assertion (its sub). The assertion is not what proves it here: the code is bound
  // to this client and to the PKCE verifier, the proof this server asks for (it advertises none).
  if (!id && typeof body.client_assertion === "string") { try { id = JSON.parse(Buffer.from(body.client_assertion.split(".")[1] ?? "", "base64url").toString("utf8")).sub; } catch { /* no id */ } }
  const basic = /^Basic\s+(.+)$/i.exec(req.header("authorization") ?? "")?.[1];
  if (basic) { const [a, ...rest] = Buffer.from(basic, "base64").toString("utf8").split(":"); id = decodeURIComponent(a); secret = decodeURIComponent(rest.join(":")); }
  const c = await getClient(String(id ?? ""));
  if ("error" in c) return tokenError("invalid_client", c.error, 401);
  if (c.secret_hash && (!secret || sha(String(secret)) !== c.secret_hash)) return tokenError("invalid_client", "client authentication failed", 401);
  return c;
}

async function issueTokens(grantId: number): Promise<TokenAnswer> {
  const access = `sahoa_${b64url(randomBytes(24))}`, refresh = `sahor_${b64url(randomBytes(24))}`;
  await q(`INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES ($1,$3,'access', now() + ($4::int * interval '1 second')), ($2,$3,'refresh', now() + ($5::int * interval '1 day'))`, [sha(access), sha(refresh), grantId, ACCESS_TTL_S, REFRESH_TTL_DAYS]);
  await q(`DELETE FROM oauth_tokens WHERE grant_id = $1 AND expires_at < now() - interval '1 day'`, [grantId]);
  return { status: 200, json: { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE } };
}

async function revokeGrant(grantId: number, note: string): Promise<void> {
  await q(`UPDATE oauth_grants SET revoked_at = coalesce(revoked_at, now()), revoke_note = coalesce(revoke_note, $2) WHERE id = $1`, [grantId, note]);
  await q(`UPDATE oauth_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE grant_id = $1`, [grantId]);
}

/** POST /oauth/token */
export async function token(req: Request): Promise<TokenAnswer> {
  if (!betaOn()) return tokenError("unsupported_grant_type", "not available", 404);
  const b = (req.body ?? {}) as Record<string, string>;
  const client = await tokenClient(req, b);
  if (!("client_id" in client)) return client;
  if (b.resource !== undefined && !resourceOk(b.resource)) return tokenError("invalid_target", `the resource is ${resourceUrl()}`);
  if (b.grant_type === "authorization_code") {
    const c = await one<any>(`SELECT c.*, g.client_id, g.revoked_at FROM oauth_codes c JOIN oauth_grants g ON g.id = c.grant_id WHERE c.code_hash = $1`, [sha(String(b.code ?? ""))]);
    if (!c || c.client_id !== client.client_id) return tokenError("invalid_grant", "unknown code");
    // A code used twice is a stolen code: the whole grant goes (OAuth 2.1 §4.1.3).
    if (c.used_at) { await revokeGrant(Number(c.grant_id), "authorization code reused"); return tokenError("invalid_grant", "code already used"); }
    if (c.revoked_at || new Date(c.expires_at).getTime() < Date.now()) return tokenError("invalid_grant", "code expired");
    if (b.redirect_uri !== undefined && b.redirect_uri !== c.redirect_uri) return tokenError("invalid_grant", "redirect_uri does not match the authorization request");
    if (!pkceOk(String(b.code_verifier ?? ""), c.code_challenge)) return tokenError("invalid_grant", "code_verifier does not match the code_challenge");
    await q(`UPDATE oauth_codes SET used_at = now() WHERE code_hash = $1`, [c.code_hash]);
    return issueTokens(Number(c.grant_id));
  }
  if (b.grant_type === "refresh_token") {
    const t = await one<any>(`SELECT t.*, g.client_id, g.revoked_at AS grant_revoked FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = $1 AND t.kind = 'refresh'`, [sha(String(b.refresh_token ?? ""))]);
    if (!t || t.client_id !== client.client_id) return tokenError("invalid_grant", "unknown refresh token");
    if (t.grant_revoked || t.revoked_at) return tokenError("invalid_grant", "the connection was disconnected");
    // Rotation: a refresh token works once; a replay means it leaked, and the connection is closed.
    if (t.used_at) { await revokeGrant(Number(t.grant_id), "refresh token replayed"); return tokenError("invalid_grant", "refresh token already used"); }
    if (new Date(t.expires_at).getTime() < Date.now()) return tokenError("invalid_grant", "refresh token expired");
    if (b.scope !== undefined && !cleanScope(b.scope)) return tokenError("invalid_scope", `the only scope is ${SCOPE}`);
    await q(`UPDATE oauth_tokens SET used_at = now() WHERE token_hash = $1`, [t.token_hash]);
    await q(`UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id = $1 AND kind = 'access' AND revoked_at IS NULL`, [t.grant_id]);
    return issueTokens(Number(t.grant_id));
  }
  return tokenError("unsupported_grant_type", "authorization_code or refresh_token");
}

/** POST /oauth/revoke (RFC 7009): always 200. Revoking a refresh token ends the connection. */
export async function revoke(req: Request): Promise<void> {
  const b = (req.body ?? {}) as Record<string, string>;
  const t = await one<any>(`SELECT * FROM oauth_tokens WHERE token_hash = $1`, [sha(String(b.token ?? ""))]);
  if (!t) return;
  if (t.kind === "refresh") await revokeGrant(Number(t.grant_id), "revoked by the app");
  else await q(`UPDATE oauth_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE token_hash = $1`, [t.token_hash]);
}

/** An access token for the MCP resource: who it is, or null (missing, expired, revoked, or the grant disconnected). */
export async function verifyAccess(raw: string): Promise<AuthInfo | null> {
  if (!betaOn() || !raw.startsWith("sahoa_") || raw.length > 200) return null;
  const r = await one<any>(`SELECT t.grant_id, g.user_id, g.client_id, g.scope, g.resource, g.last_used_at, u.handle, c.host
    FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id JOIN oauth_clients c ON c.client_id = g.client_id
    WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now() AND g.revoked_at IS NULL`, [sha(raw)]);
  if (!r || r.resource !== resourceUrl()) return null;
  const allowed = betaHandles();
  if (allowed.size && !allowed.has(String(r.handle).toLowerCase())) return null;
  if (!r.last_used_at || Date.now() - new Date(r.last_used_at).getTime() > 60_000) await q(`UPDATE oauth_grants SET last_used_at = now() WHERE id = $1`, [r.grant_id]);
  return { userId: Number(r.user_id), handle: r.handle, grantId: Number(r.grant_id), clientId: r.client_id, host: r.host, scopes: String(r.scope).split(" "), token: raw };
}

/** The person's connected apps, for the Connected apps page. */
export async function connections(userId: number): Promise<any[]> {
  return q(`SELECT g.id, g.client_id, c.client_name, c.host, g.created_at, g.last_used_at, g.terms_version FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id WHERE g.user_id = $1 AND g.revoked_at IS NULL ORDER BY g.id DESC`, [userId]);
}

/** Disconnect: the person's explicit act, the only way a connection ends besides a leaked-token replay. */
export async function disconnect(userId: number, grantId: number): Promise<boolean> {
  const g = await one(`SELECT id FROM oauth_grants WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [grantId, userId]);
  if (!g) return false;
  await revokeGrant(grantId, "disconnected by the person");
  return true;
}

export async function connectionsPage(req: Request, res: Response): Promise<void> {
  const user = await browserUser(req);
  res.setHeader("Cache-Control", "no-store");
  if (!user) { res.redirect(302, `/auth/github?next=${encodeURIComponent("/settings/connections")}`); return; }
  const rows = await connections(user.id);
  const body = rows.length
    ? `<p>Chat apps that can work on open problems as @${esc(user.handle)}. Disconnect one and it stops at once.</p><ul>${rows.map((r) => `<li><b>${esc(r.host === "other" ? r.client_name : HOST_NAME[r.host])}</b> <span class="muted">(${esc(r.client_name)}), connected ${esc(String(r.created_at).slice(0, 10))}${r.last_used_at ? `, last used ${esc(new Date(r.last_used_at).toISOString().slice(0, 16).replace("T", " "))} UTC` : ""}</span>
<form method="post" action="/settings/connections/${Number(r.id)}/disconnect" style="display:inline"><button class="link-button" type="submit">Disconnect</button></form></li>`).join("")}</ul>`
    : `<p>No chat app is connected to @${esc(user.handle)}.</p>`;
  res.type("text/html").send(page({ title: "Connected apps", crumbs: `<a href="/">solveathome</a> / <a href="/settings">Settings</a>`, heading: "Connected apps", body, robots: "noindex", dataPage: "settings" }));
}

export async function disconnectPost(req: Request, res: Response): Promise<void> {
  const user = await browserUser(req);
  const site = req.header("sec-fetch-site");
  if (!user || (site && site !== "same-origin")) { res.status(403).type("text/plain").send("Disconnect from the Connected apps page, signed in."); return; }
  await disconnect(user.id, Number(req.params.id));
  res.redirect(303, "/settings/connections");
}
