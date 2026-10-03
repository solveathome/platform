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
 */

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Args = Record<string, unknown>;

export interface ToolContext {
  /** An absolute link to the site, tagged utm_source=chatgpt, utm_medium=plugin, utm_campaign=<plugin>. */
  link: (pathOrUrl: string, content?: string) => string;
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
}

export interface Plugin {
  config: PluginConfig;
  /** One JSON-RPC message or a batch in, the answer out (null for notifications). */
  handle: (message: unknown) => Promise<Json | null>;
  link: ToolContext['link'];
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

function cleanArgs(raw: unknown): Args {
  const args: Args = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return args;
  }
  for (const [k, v] of Object.entries(raw as Args)) {
    if (typeof v === 'string') {
      args[k] = v.slice(0, MAX_ARG_STRING);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      args[k] = v;
    } else if (Array.isArray(v)) {
      args[k] = v.slice(0, 20).map((x) => (typeof x === 'string' ? x.slice(0, MAX_ARG_STRING) : x));
    }
  }
  return args;
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
    securitySchemes: [{ type: 'noauth' }],
    annotations: {
      title: t.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: toolMeta(t),
  }));

  async function callTool(params: Args): Promise<Json> {
    const tool = tools.get(String(params.name || ''));
    if (!tool) {
      throw new RpcFailure(-32602, `Unknown tool: ${String(params.name || '')}`);
    }
    let result: ToolResult;
    try {
      result = await tool.run(cleanArgs(params.arguments), { link });
    } catch (err) {
      console.error(`chatgpt-plugin ${config.name}/${tool.name}:`, err);
      result = { text: 'The lookup failed on our side. Try again in a moment.', error: true };
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

  async function one(msg: unknown): Promise<Json | null> {
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
    try {
      let result: Json;
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
          result = await callTool(p);
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

  async function handle(message: unknown): Promise<Json | null> {
    if (Array.isArray(message)) {
      const answers = (await Promise.all(message.map(one))).filter((a): a is Json => a !== null);
      return answers.length ? answers : null;
    }
    return one(message);
  }

  return { config, handle, link };
}
