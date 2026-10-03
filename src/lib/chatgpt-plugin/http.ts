/**
 * The HTTP side of the plugin, free of any framework: express.ts is the thin adapter.
 *
 *   POST /mcp                               JSON-RPC in, JSON out (Streamable HTTP, stateless)
 *   GET  /mcp                               405: we open no server-to-client stream
 *   OPTIONS /mcp                            CORS preflight
 *   GET  /.well-known/openai-apps-challenge the domain-verification token OpenAI issues at submission
 */
import type { Plugin } from './mcp.js';

export const MCP_PATH = '/mcp';
export const CHALLENGE_PATH = '/.well-known/openai-apps-challenge';
const MAX_BODY = 64 * 1024;

export interface HttpAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

const json = (status: number, value: unknown): HttpAnswer => ({
  status,
  headers: {
    ...CORS,
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

export async function answerMcp(plugin: Plugin, method: string, bodyText: string | undefined): Promise<HttpAnswer> {
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
  if (!bodyText || bodyText.length > MAX_BODY) {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  let message: unknown;
  try {
    message = JSON.parse(bodyText);
  } catch {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const answer = await plugin.handle(message);
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
