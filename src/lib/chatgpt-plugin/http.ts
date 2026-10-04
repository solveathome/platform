/**
 * The HTTP side of the plugin, free of any framework: express.ts is the thin adapter.
 *
 *   POST /mcp                               JSON-RPC in, JSON out (Streamable HTTP, stateless)
 *   GET  /mcp                               405: we open no server-to-client stream
 *   OPTIONS /mcp                            CORS preflight
 *   GET  /.well-known/openai-apps-challenge the domain-verification token OpenAI issues at submission
 */
import { bearerChallenge, MODERN_VERSION, PROTOCOL_VERSIONS, type AuthInfo, type Plugin } from './mcp.js';

export const MCP_PATH = '/mcp';
export const CHALLENGE_PATH = '/.well-known/openai-apps-challenge';
const MAX_BODY = 64 * 1024;
/** A signed-in request may carry a report: the body limit for one with a bearer token. */
export const MAX_SIGNED_BODY = 1024 * 1024;

export interface HttpAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const CORS_PUBLIC: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};
/** A plugin with signed-in tools also lets a browser client send the 2026-07-28 headers and read the sign-in challenge. */
const CORS_SIGNED: Record<string, string> = {
  ...CORS_PUBLIC,
  'Access-Control-Allow-Headers':
    'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
};

const jsonCors = (status: number, value: unknown, cors: Record<string, string> = CORS_PUBLIC): HttpAnswer => ({
  status,
  headers: {
    ...cors,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  },
  body: JSON.stringify(value),
});

/** The challenge token is the site's to set (env OPENAI_APPS_CHALLENGE); until OpenAI issues one it answers 404. */
export function challenge(token: string | undefined): HttpAnswer {
  const t = (token || '').trim();
  if (!t) {
    return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not Found' };
  }
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };
  return { status: 200, headers, body: t };
}

/** Headers answerMcp reads, lower-cased. */
export type McpHeaders = Record<string, string | undefined>;

/** A client that reads the sign-in challenge from a tool result (ChatGPT) rather than from an HTTP 401. */
function readsToolChallenge(headers: McpHeaders, message: unknown): boolean {
  if (/openai|chatgpt/i.test(headers['user-agent'] || '')) {
    return true;
  }
  const metas = (Array.isArray(message) ? message : [message]).map((m) => (m as { params?: { _meta?: object } })?.params?._meta || {});
  return metas.some((m) => Object.keys(m).some((k) => k.startsWith('openai/')));
}

function headerError(id: unknown, code: number, message: string, data?: unknown): HttpAnswer {
  return jsonCors(400, { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } }, CORS_SIGNED);
}

/** The 2026-07-28 revision's per-request checks (basic/versioning, transports/streamable-http): version supported, headers match the body. */
function modernCheck(message: unknown, headers: McpHeaders): HttpAnswer | null {
  if (Array.isArray(message) || !message || typeof message !== 'object') {
    return null;
  }
  const { id, method, params } = message as { id?: unknown; method?: string; params?: { _meta?: Record<string, unknown>; name?: unknown; uri?: unknown } };
  const version = params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  if (typeof version !== 'string') {
    return null;
  }
  if (version !== MODERN_VERSION) {
    return headerError(id, -32022, 'Unsupported protocol version', { supported: [MODERN_VERSION, ...PROTOCOL_VERSIONS], requested: version });
  }
  const decode = (v: string | undefined): string | undefined => {
    const m = /^=\?base64\?(.*)\?=$/.exec(v || '');
    return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
  };
  if (headers['mcp-protocol-version'] !== undefined && headers['mcp-protocol-version'] !== version) {
    return headerError(id, -32020, 'MCP-Protocol-Version header does not match the request body');
  }
  if (headers['mcp-method'] !== undefined && decode(headers['mcp-method']) !== method) {
    return headerError(id, -32020, 'Mcp-Method header does not match the request body');
  }
  const name = typeof params?.name === 'string' ? params.name : typeof params?.uri === 'string' ? params.uri : undefined;
  if (name !== undefined && headers['mcp-name'] !== undefined && decode(headers['mcp-name']) !== name) {
    return headerError(id, -32020, 'Mcp-Name header does not match the request body');
  }
  if (!params?._meta?.['io.modelcontextprotocol/clientCapabilities']) {
    return headerError(id, -32602, 'Missing io.modelcontextprotocol/clientCapabilities in _meta');
  }
  return null;
}

/** Whether a message calls a signed-in tool. */
function callsProtected(plugin: Plugin, message: unknown): boolean {
  return (Array.isArray(message) ? message : [message]).some((m) => {
    const x = m as { method?: string; params?: { name?: unknown } };
    return x?.method === 'tools/call' && plugin.protectedTools.has(String(x.params?.name ?? ''));
  });
}

export async function answerMcp(plugin: Plugin, method: string, bodyText: string | undefined, headers: McpHeaders = {}): Promise<HttpAnswer> {
  const CORS = plugin.config.auth ? CORS_SIGNED : CORS_PUBLIC;
  const json = (status: number, value: unknown): HttpAnswer => jsonCors(status, value, CORS);
  if (method === 'OPTIONS') {
    return { status: 204, headers: CORS, body: '' };
  }
  if (method === 'GET' || method === 'DELETE') {
    const headers = { ...CORS, Allow: 'POST, OPTIONS', 'Content-Type': 'text/plain' };
    return { status: 405, headers, body: 'Method Not Allowed' };
  }
  if (method !== 'POST') {
    return { status: 405, headers: { ...CORS, Allow: 'POST, OPTIONS' }, body: '' };
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.authorization || '')?.[1];
  const limit = plugin.config.auth && bearer ? MAX_SIGNED_BODY : MAX_BODY;
  if (!bodyText || bodyText.length > limit) {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  let message: unknown;
  try {
    message = JSON.parse(bodyText);
  } catch {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (plugin.config.modern) {
    const bad = modernCheck(message, headers);
    if (bad) {
      return bad;
    }
  }
  // Signed-in tools (MCP authorization spec): an invalid or expired token is always a 401 the client refreshes on; a missing one is a
  // 401 for a client that signs in on it (Claude), a tool-result challenge for one that reads that (ChatGPT, mcp.ts).
  let auth: AuthInfo | null = null;
  const pa = plugin.config.auth;
  if (pa) {
    const challenge401 = (value: string): HttpAnswer => {
      const a = json(401, { jsonrpc: '2.0', id: (message as { id?: unknown })?.id ?? null, error: { code: -32001, message: 'Sign in required' } });
      a.headers['WWW-Authenticate'] = value;
      return a;
    };
    if (bearer) {
      auth = await pa.verify(bearer);
      if (!auth) {
        return challenge401(bearerChallenge(pa, 'invalid_token', 'The access token is invalid or expired'));
      }
    } else if (callsProtected(plugin, message) && !readsToolChallenge(headers, message)) {
      return challenge401(bearerChallenge(pa));
    }
  }
  const answer = await plugin.handle(message, { auth, protocolVersion: headers['mcp-protocol-version'] });
  if (answer === null) {
    return { status: 202, headers: CORS, body: '' };
  }
  return json(200, answer);
}

/** A per-address limit, kept in memory: generous for people, a wall for a loop. */
export function rateLimiter(perMinute = 120) {
  const seen = new Map<string, { n: number; at: number }>();
  return (address: string): boolean => {
    const now = Date.now();
    const row = seen.get(address);
    if (!row || now - row.at > 60_000) {
      seen.set(address, { n: 1, at: now });
      if (seen.size > 10_000) {
        for (const [k, v] of seen) {
          if (now - v.at > 60_000) {
            seen.delete(k);
          }
        }
      }
      return true;
    }
    row.n += 1;
    return row.n <= perMinute;
  };
}
