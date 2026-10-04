/**
 * chatgpt-plugin: a read-only MCP server for a ChatGPT plugin, without dependencies.
 *
 * One JSON-RPC handler (Streamable HTTP, stateless: every POST gets one JSON answer, no sessions,
 * no SSE), the tools a site offers, the widgets (UI resources) they render in, and the
 * utm_source=chatgpt tag on every link back to the site. Framework-free: express.ts is the thin
 * adapter this server mounts, and the tools themselves are in ../chatgpt.ts.
 *
 * OpenAI's plugin rules this enforces by construction: every tool is read-only (readOnlyHint,
 * no destructive or open-world hints), nothing about the user is asked for or stored, and no
 * tool or widget carries an ad, a price in a description or an upgrade link (that is the site's
 * job in what it registers; see ../chatgpt.ts).
 *
 * Signed-in tools (Oct 4 2026, chat contributions): a plugin may also declare tools that need an OAuth token (`auth`), which then
 * carry their own annotations, and opt in to the stateless 2026-07-28 revision (`modern`). A plugin without them answers exactly
 * as before. This copy is ahead of the shared package here.
 */

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
/** The stateless revision (no initialize: every request carries its version in _meta). Served only where a plugin opts in (`modern`). */
export const MODERN_VERSION = '2026-07-28';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Args = Record<string, unknown>;

/** Who is calling, when the plugin has signed-in tools and the request carried a valid OAuth access token. */
export interface AuthInfo {
  userId: number;
  handle: string;
  grantId: number;
  clientId: string;
  /** chatgpt | claude | other: the chat app the person connected. */
  host: string;
  scopes: string[];
  /** The access token itself, for the site's own API (never forwarded anywhere else). */
  token: string;
}

export interface ToolContext {
  /** An absolute link to the site, tagged utm_source=chatgpt, utm_medium=plugin, utm_campaign=<plugin>. */
  link: (pathOrUrl: string, content?: string) => string;
  /** Set for a signed-in call. */
  auth?: AuthInfo;
  /** The protocol version the request was served under. */
  protocolVersion?: string;
}

/** Signed-in tools (OAuth 2.1, the MCP authorization spec): the site verifies its own tokens. */
export interface PluginAuth {
  /** The protected-resource metadata URL (RFC 9728) named in every challenge. */
  resourceMetadataUrl: string;
  /** Scopes a signed-in tool asks for. */
  scopes: string[];
  verify: (token: string) => Promise<AuthInfo | null>;
  /** Called after every signed-in tool call (the server keeps a record of what it saw). */
  record?: (call: { tool: string; args: Args; result: ToolResult; auth: AuthInfo; protocolVersion?: string }) => Promise<void> | void;
}

export interface ToolResult {
  /** What the model reads: short, factual, with the source link in it. */
  text: string;
  /** What the widget renders (and the model may read too). */
  data?: Record<string, unknown>;
  /** Only the widget sees this (never the model): puzzle answers, long lists the model does not need. */
  meta?: Record<string, unknown>;
  /** True when the call could not be answered (bad input, nothing found is NOT an error). */
  error?: boolean;
}

export interface PluginTool {
  name: string;
  title: string;
  /** "Use this when …", then what it does not do. No prices, no promotion (plugin guidelines). */
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** The shape of ToolResult.data: required by OpenAI for any tool that returns structuredContent. */
  outputSchema?: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  /** The widget uri this tool renders in, when it has one. */
  widget?: string;
  /** Status lines ChatGPT shows while the tool runs and after. */
  invoking?: string;
  invoked?: string;
  /** A signed-in tool: called only with a valid token carrying these scopes. Without one the client is asked to sign in. */
  auth?: { scopes: string[] };
  /** Defaults are read-only; a signed-in tool that writes says so here. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** Longest string argument kept (default 500); a submission tool takes reports. */
  maxArgString?: number;
  run: (args: Args, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

export interface PluginWidget {
  uri: string;
  title: string;
  /** The whole HTML document (see widget.ts). */
  html: string;
  description?: string;
  /** Origins the widget may load images and fonts from (our own site is always added). */
  resourceDomains?: string[];
  /** Origins the widget may fetch from (none by default: the tool result carries the data). */
  connectDomains?: string[];
}

export interface PluginConfig {
  /** Machine name, also the utm_campaign: "hardtobook". */
  name: string;
  /** Shown name: "Hard to Book". */
  title: string;
  version: string;
  /** https://hardtobook.com (no trailing slash). */
  siteUrl: string;
  /** Server instructions the model gets on connect: when to use the plugin, when not. */
  instructions?: string;
  tools: PluginTool[];
  widgets?: PluginWidget[];
  /** Present when some tools are signed-in. */
  auth?: PluginAuth;
  /** Also serve the stateless 2026-07-28 revision (server/discover, per-request _meta) beside initialize. */
  modern?: boolean;
}

export interface CallContext {
  /** A verified token, or null when none was sent. */
  auth?: AuthInfo | null;
  /** The MCP-Protocol-Version header, when the client sent one. */
  protocolVersion?: string;
}

export interface Plugin {
  config: PluginConfig;
  /** One JSON-RPC message or a batch in, the answer out (null for notifications). */
  handle: (message: unknown, call?: CallContext) => Promise<Json | null>;
  link: ToolContext['link'];
  /** Names of the signed-in tools. */
  protectedTools: Set<string>;
}

const WIDGET_MIME = 'text/html;profile=mcp-app';
const MAX_ARG_STRING = 500;

type RpcError = { code: number; message: string };

class RpcFailure extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function rpcError(id: Json, error: RpcError): Json {
  return { jsonrpc: '2.0', id, error };
}

/** A link back to the site, always tagged; links to other hosts are left alone. */
export function tagLink(siteUrl: string, campaign: string, pathOrUrl: string, content?: string): string {
  let url: URL;
  try {
    url = new URL(pathOrUrl, `${siteUrl}/`);
  } catch {
    return pathOrUrl;
  }
  const site = new URL(siteUrl);
  if (url.hostname.replace(/^www\./, '') !== site.hostname.replace(/^www\./, '')) {
    return url.toString();
  }
  url.searchParams.set('utm_source', 'chatgpt');
  url.searchParams.set('utm_medium', 'plugin');
  url.searchParams.set('utm_campaign', campaign);
  if (content) {
    url.searchParams.set('utm_content', content);
  }
  return url.toString();
}

/** Every string in the result that is a URL on our site gets the tag, so no link back goes out untagged. */
function tagAll(value: unknown, tag: (u: string) => string): unknown {
  if (typeof value === 'string') {
    return value.replace(/https?:\/\/[^\s<>"'()\]]+/g, (u) => {
      const end = u.match(/[.,;:!?]+$/)?.[0] || '';
      return tag(u.slice(0, u.length - end.length)) + end;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => tagAll(v, tag));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = tagAll(v, tag);
    }
    return out;
  }
  return value;
}

function cleanArgs(raw: unknown, max = MAX_ARG_STRING): Args {
  const args: Args = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return args;
  }
  for (const [k, v] of Object.entries(raw as Args)) {
    if (typeof v === 'string') {
      args[k] = v.slice(0, max);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      args[k] = v;
    } else if (Array.isArray(v)) {
      args[k] = v.slice(0, 20).map((x) => (typeof x === 'string' ? x.slice(0, max) : x));
    } else if (v && typeof v === 'object' && max > MAX_ARG_STRING) {
      // A structured argument (a curate decision) on a tool that takes long input; bounded by its JSON size.
      const text = JSON.stringify(v);
      if (text.length <= max) {
        args[k] = JSON.parse(text);
      }
    }
  }
  return args;
}

/** The WWW-Authenticate value a sign-in challenge carries (RFC 6750, RFC 9728). */
export function bearerChallenge(auth: PluginAuth, error?: string, description?: string): string {
  const parts = [`resource_metadata="${auth.resourceMetadataUrl}"`, `scope="${auth.scopes.join(' ')}"`];
  if (error) {
    parts.push(`error="${error}"`);
  }
  if (description) {
    parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  }
  return `Bearer ${parts.join(', ')}`;
}

function widgetMeta(plugin: PluginConfig, widget: PluginWidget): Record<string, unknown> {
  const site = new URL(plugin.siteUrl).origin;
  const resourceDomains = [...new Set([site, ...(widget.resourceDomains || [])])];
  const connectDomains = [...new Set(widget.connectDomains || [])];
  return {
    ui: { csp: { connectDomains, resourceDomains }, domain: site, prefersBorder: true },
    'openai/widgetDescription': widget.description || widget.title,
    'openai/widgetPrefersBorder': true,
    'openai/widgetDomain': site,
    'openai/widgetCSP': {
      connect_domains: connectDomains,
      resource_domains: resourceDomains,
      redirect_domains: [site],
    },
  };
}

function toolMeta(tool: PluginTool): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  if (tool.widget) {
    meta.ui = { resourceUri: tool.widget };
    meta['openai/outputTemplate'] = tool.widget;
    meta['openai/widgetAccessible'] = false;
  }
  if (tool.invoking) {
    meta['openai/toolInvocation/invoking'] = tool.invoking;
  }
  if (tool.invoked) {
    meta['openai/toolInvocation/invoked'] = tool.invoked;
  }
  return Object.keys(meta).length ? meta : undefined;
}

export function createPlugin(config: PluginConfig): Plugin {
  const siteUrl = config.siteUrl.replace(/\/$/, '');
  const link = (pathOrUrl: string, content?: string): string => tagLink(siteUrl, config.name, pathOrUrl, content);
  const tag = (u: string): string => tagLink(siteUrl, config.name, u);
  const tools = new Map(config.tools.map((t) => [t.name, t]));
  const widgets = new Map((config.widgets || []).map((w) => [w.uri, w]));

  const listTools = (): Record<string, unknown>[] => config.tools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
    securitySchemes: t.auth ? [{ type: 'oauth2', scopes: t.auth.scopes }] : [{ type: 'noauth' }],
    annotations: {
      title: t.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      ...(t.annotations || {}),
    },
    _meta: t.auth ? { ...(toolMeta(t) || {}), securitySchemes: [{ type: 'oauth2', scopes: t.auth.scopes }] } : toolMeta(t),
  }));
  const protectedTools = new Set(config.tools.filter((t) => t.auth).map((t) => t.name));

  async function callTool(params: Args, call: CallContext, modernVersion?: string): Promise<Json> {
    const protocolVersion = modernVersion ?? call.protocolVersion;
    const tool = tools.get(String(params.name || ''));
    if (!tool) {
      throw new RpcFailure(-32602, `Unknown tool: ${String(params.name || '')}`);
    }
    // A signed-in tool without a token: the answer asks the client to sign in. ChatGPT reads this tool-result form; a client that
    // needs an HTTP 401 gets it before this point (http.ts).
    if (tool.auth && config.auth && !(call.auth && tool.auth.scopes.every((s) => call.auth!.scopes.includes(s)))) {
      const why = call.auth ? 'insufficient_scope' : 'invalid_token';
      const text = 'Sign in to Solve at Home to do this. Your chat app will open solveathome.org to connect your account.';
      return {
        content: [{ type: 'text', text }],
        isError: true,
        _meta: { 'mcp/www_authenticate': [bearerChallenge(config.auth, why, 'Sign in to Solve at Home to contribute')] },
      } as Json;
    }
    const args = cleanArgs(params.arguments, tool.maxArgString || MAX_ARG_STRING);
    let result: ToolResult;
    try {
      result = await tool.run(args, { link, auth: call.auth || undefined, protocolVersion });
    } catch (err) {
      console.error(`chatgpt-plugin ${config.name}/${tool.name}:`, err);
      result = { text: 'The lookup failed on our side. Try again in a moment.', error: true };
    }
    if (tool.auth && call.auth && config.auth?.record) {
      try {
        await config.auth.record({ tool: tool.name, args, result, auth: call.auth, protocolVersion });
      } catch (err) {
        console.error(`chatgpt-plugin ${config.name}/${tool.name} record:`, err);
      }
    }
    const data = result.data ? (tagAll(result.data, tag) as Record<string, unknown>) : undefined;
    const out: Record<string, unknown> = { content: [{ type: 'text', text: String(tagAll(result.text, tag)) }] };
    if (data) {
      out.structuredContent = data;
    }
    if (result.meta) {
      // eslint-disable-next-line no-underscore-dangle -- the MCP field name
      out._meta = tagAll(result.meta, tag);
    }
    if (result.error) {
      out.isError = true;
    }
    return out as Json;
  }

  function readResource(params: Args): Json {
    const widget = widgets.get(String(params.uri || ''));
    if (!widget) {
      throw new RpcFailure(-32002, `Resource not found: ${String(params.uri || '')}`);
    }
    return {
      contents: [{ uri: widget.uri, mimeType: WIDGET_MIME, text: widget.html, _meta: widgetMeta(config, widget) }],
    } as Json;
  }

  const modernCache = (scope: 'public' | 'private') => ({ ttlMs: 60_000, cacheScope: scope });

  async function one(msg: unknown, call: CallContext = {}): Promise<Json | null> {
    if (!msg || typeof msg !== 'object') {
      return rpcError(null, { code: -32600, message: 'Invalid Request' });
    }
    const { id, method, params } = msg as { id?: Json; method?: string; params?: Args };
    const isNotification = id === undefined;
    if (typeof method !== 'string') {
      return isNotification ? null : rpcError(id ?? null, { code: -32600, message: 'Invalid Request' });
    }
    if (isNotification) {
      return null;
    } // notifications/initialized, notifications/cancelled: nothing to answer
    const p = params || {};
    // The 2026-07-28 revision: a request whose _meta names its protocol version is served statelessly (version checks are in http.ts).
    const metaVersion = config.modern ? (p._meta as Args | undefined)?.[META_VERSION] : undefined;
    const modern = typeof metaVersion === 'string';
    try {
      let result: Json;
      if (modern) {
        const serverInfo = { 'io.modelcontextprotocol/serverInfo': { name: config.name, title: config.title, version: config.version } };
        const withEra = (r: Record<string, unknown>, cache?: 'public' | 'private'): Json => ({ resultType: 'complete', ...r, ...(cache ? modernCache(cache) : {}), _meta: { ...((r._meta as object) || {}), ...serverInfo } }) as Json;
        switch (method) {
          case 'server/discover':
            return { jsonrpc: '2.0', id, result: withEra({ supportedVersions: [MODERN_VERSION], capabilities: { tools: {}, resources: {} }, ...(config.instructions ? { instructions: config.instructions } : {}) }, 'public') };
          case 'tools/list':
            return { jsonrpc: '2.0', id, result: withEra({ tools: listTools() }, 'public') };
          case 'tools/call':
            return { jsonrpc: '2.0', id, result: withEra((await callTool(p, call, MODERN_VERSION)) as Record<string, unknown>) };
          case 'resources/list':
            return { jsonrpc: '2.0', id, result: withEra({ resources: [...widgets.values()].map((w) => ({ uri: w.uri, name: w.title, mimeType: WIDGET_MIME, _meta: widgetMeta(config, w) })) }, 'public') };
          case 'resources/templates/list':
            return { jsonrpc: '2.0', id, result: withEra({ resourceTemplates: [] }, 'public') };
          case 'resources/read': {
            if (!widgets.has(String(p.uri || ''))) {
              return rpcError(id, { code: -32602, message: `Resource not found: ${String(p.uri || '')}` });
            }
            return { jsonrpc: '2.0', id, result: withEra(readResource(p) as Record<string, unknown>, 'public') };
          }
          case 'prompts/list':
            return { jsonrpc: '2.0', id, result: withEra({ prompts: [] }, 'public') };
          default:
            return rpcError(id, { code: -32601, message: `Method not found: ${method}` });
        }
      }
      switch (method) {
        case 'initialize': {
          const asked = String(p.protocolVersion || '');
          result = {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
            serverInfo: { name: config.name, title: config.title, version: config.version },
            ...(config.instructions ? { instructions: config.instructions } : {}),
          } as Json;
          break;
        }
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: listTools() } as unknown as Json;
          break;
        case 'tools/call':
          result = await callTool(p, call);
          break;
        case 'resources/list':
          result = {
            resources: [...widgets.values()].map((w) => ({
              uri: w.uri,
              name: w.title,
              mimeType: WIDGET_MIME,
              _meta: widgetMeta(config, w),
            })),
          } as unknown as Json;
          break;
        case 'resources/templates/list':
          result = { resourceTemplates: [] };
          break;
        case 'resources/read':
          result = readResource(p);
          break;
        case 'prompts/list':
          result = { prompts: [] };
          break;
        default:
          return rpcError(id, { code: -32601, message: `Method not found: ${method}` });
      }
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      if (err instanceof RpcFailure) {
        return rpcError(id, { code: err.code, message: err.message });
      }
      console.error(`chatgpt-plugin ${config.name}:`, err);
      return rpcError(id, { code: -32603, message: 'Internal error' });
    }
  }

  async function handle(message: unknown, call: CallContext = {}): Promise<Json | null> {
    if (Array.isArray(message)) {
      const answers = (await Promise.all(message.map((m) => one(m, call)))).filter((a): a is Json => a !== null);
      return answers.length ? answers : null;
    }
    return one(message, call);
  }

  return { config, handle, link, protectedTools };
}
