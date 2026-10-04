/**
 * Real work from a chat app (#sah-mcp-real-work-build, Chris, Oct 4 2026: "allowing people using ChatGPT and not Codex would be amazing").
 * The signed-in MCP endpoint (/mcp/beta while in beta): the three public tools plus six that take, read, answer and hand back an
 * assignment, and show the person's own standing. Every tool goes through the site's own API (GET /start, POST /result, POST /release)
 * in-process, so a chat session meets exactly the gates, scheduling, intake and credit a command-line agent does; the API knows it is a
 * chat by the OAuth token (auth.ts) and gives it only chat work (scheduler CHAT_TYPES) and the chat brief.
 *
 * The transcript of a chat return is what the server saw: every tool call of the session and its answer (mcp_calls). The model is not
 * measured and no usage is estimated.
 */
import { one, q } from "../db/index.js";
import { createPlugin, type Args, type AuthInfo, type Plugin, type PluginTool, type ToolResult } from "./chatgpt-plugin/index.js";
import { solveAtHomePlugin } from "./chatgpt.js";
import { MCP_INTERNAL_SECRET } from "./auth.js";
import { featuredProject } from "./projects.js";
import { hit } from "./ratelimit.js";
import { HOST_NAME, resourceMetadataUrl, SCOPE, verifyAccess } from "./oauth.js";
import { CALLS_PER_CLIENT_PER_MIN, CALLS_PER_GRANT_PER_MIN } from "./mcp-limits.js";
import { LADDER } from "./rungs.js";

const PAGE = 20_000;
const MAX_REPORT = 200_000;
const SHARE_URL = /^https:\/\/(chatgpt\.com|chat\.openai\.com|claude\.ai)\/share\/[A-Za-z0-9_-]{8,100}$/;

type Session = { id: string; slug: string; problem_id: number; job_id: number | null; attempt_id: string | null; job_title: string | null };

/** The grant's chat session: the one named, else its latest live one. */
async function sessionFor(auth: AuthInfo, named?: unknown): Promise<Session | null> {
  const id = typeof named === "string" && named.trim() ? named.trim() : null;
  return (await one<any>(`SELECT s.id, p.slug, s.problem_id, j.id AS job_id, j.attempt_id, j.title AS job_title FROM sessions s JOIN problems p ON p.id = s.problem_id
      LEFT JOIN jobs j ON j.assigned_session = s.id AND j.status = 'assigned'
      WHERE s.oauth_grant_id = $1 AND s.ended_at IS NULL AND ($2::text IS NULL OR s.id = $2) ORDER BY s.last_seen DESC LIMIT 1`, [auth.grantId, id])) ?? null;
}

export function workTools(apiBase: string): PluginTool[] {
  const api = async (auth: AuthInfo, method: string, path: string, o: { session?: string; attempt?: string | null; body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any }> => {
    const url = new URL(`${apiBase}${path}`);
    for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
    const r = await fetch(url, { method, signal: AbortSignal.timeout(60_000), headers: {
      authorization: `Bearer ${auth.token}`, "x-mcp-internal": MCP_INTERNAL_SECRET, accept: "application/json", "content-type": "application/json",
      ...(o.session ? { "x-session": o.session } : {}), ...(o.attempt ? { "x-attempt": o.attempt } : {}), ...(o.headers ?? {}) },
      body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text();
    try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, json: { error: text.slice(0, 2000) } }; }
  };
  const limited = (auth: AuthInfo): ToolResult | null => {
    const g = hit(`mcp-grant:${auth.grantId}`, CALLS_PER_GRANT_PER_MIN, 60_000), c = hit(`mcp-client:${auth.clientId}`, CALLS_PER_CLIENT_PER_MIN, 60_000);
    return g.over || c.over ? { text: `Too many requests from this connection. Wait ${Math.max(g.retryAfter, c.retryAfter)} seconds.`, error: true } : null;
  };
  const failed = (r: { status: number; json: any }): ToolResult => ({ text: String(r.json?.error ?? r.json?.orientation_md ?? `The request failed (${r.status}).`).slice(0, 4000), error: true, data: { status: r.status } });
  const signedIn = (run: (a: Args, auth: AuthInfo, link: (p: string) => string) => Promise<ToolResult>) => async (a: Args, ctx: { auth?: AuthInfo; link: (p: string) => string }): Promise<ToolResult> => {
    if (!ctx.auth) return { text: "Sign in to Solve at Home first.", error: true };
    return limited(ctx.auth) ?? run(a, ctx.auth, ctx.link);
  };
  const briefOf = async (s: Session): Promise<string | null> => {
    if (!s.job_id) return null;
    const a = await one<{ assignment_payload: any }>(`SELECT a.assignment_payload FROM assignment_attempts a JOIN jobs j ON j.attempt_id = a.id WHERE j.id = $1`, [s.job_id]);
    return a?.assignment_payload?.brief_md ?? null;
  };
  const sessionArg = { session_id: { type: "string", description: "The session id start_contributing gave. Optional: without it, this connection's latest session." } };
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

  return [
    { name: "start_contributing", title: "Take an assignment", auth: { scopes: [SCOPE] }, annotations: { ...write, openWorldHint: false },
      description: "Use this when the person wants to contribute to Solve at Home's open research from this chat. Takes one assignment for them (reasoning and writing work: exploring an idea, finding sources, formalizing an argument, looking for a gap or counterexample, curating) and returns its brief. Work on it here with the person, then send the result with submit_return or hand it back with release_assignment. It needs the person's Solve at Home account; the chat app asks them to connect it the first time.",
      inputSchema: { type: "object", properties: { project: { type: "string", description: "Project slug. Optional: the main project (twin-primes)." } }, additionalProperties: false },
      invoking: "Taking an assignment…", invoked: "Assignment ready",
      run: signedIn(async (a, auth, link) => {
        const live = await sessionFor(auth);
        if (live?.job_id) return { text: `You already hold job #${live.job_id} (${live.job_title}). Work on it, then submit_return or release_assignment.\n\n${(await briefOf(live)) ?? ""}`, data: { session_id: live.id, job_id: live.job_id } };
        const slug = typeof a.project === "string" && /^[a-z0-9-]{1,60}$/.test(a.project) ? a.project : live?.slug ?? (await featuredProject())?.slug ?? "twin-primes";
        const r = await api(auth, "GET", `/projects/${slug}/start`, { session: live?.slug === slug ? live.id : undefined, query: { time: "continuous", share: "0", subagents: "no" },
          headers: { "x-capabilities": JSON.stringify({ name: HOST_NAME[auth.host] ?? "chat app", research: "" }) } });
        if (r.status !== 200 || !r.json?.job_id) return failed(r);
        return { text: `${r.json.brief_md}\n\nsession_id: ${r.json.session}`, data: { session_id: r.json.session, job_id: r.json.job_id, type: r.json.type, title: r.json.title, page: link(`/projects/${slug}/job/${r.json.job_id}`) } };
      }) },
    { name: "get_assignment", title: "Read the current assignment", auth: { scopes: [SCOPE] }, annotations: { readOnlyHint: true },
      description: "Use this to re-read the brief of the assignment this chat holds on Solve at Home. It also tells the site the chat is still working on it.",
      inputSchema: { type: "object", properties: sessionArg, additionalProperties: false },
      run: signedIn(async (a, auth) => {
        const s = await sessionFor(auth, a.session_id);
        if (!s?.job_id) return { text: "This chat holds no assignment. Call start_contributing to take one.", data: { session_id: s?.id ?? null } };
        await api(auth, "GET", `/projects/${s.slug}/sessions`, { session: s.id });
        return { text: (await briefOf(s)) ?? `Job #${s.job_id}: ${s.job_title}`, data: { session_id: s.id, job_id: s.job_id } };
      }) },
    { name: "read_project_file", title: "Read a project document", auth: { scopes: [SCOPE] }, annotations: { readOnlyHint: true },
      description: "Use this to read a Solve at Home project document an assignment names, such as research/OUTCOMES.md, in pages. An empty path lists the top folder; a folder path lists that folder.",
      inputSchema: { type: "object", properties: { path: { type: "string", description: "Document path inside the project, e.g. research/OUTCOMES.md. Empty for the list." }, offset: { type: "integer", minimum: 0, description: "Character offset for the next page. Optional." }, ...sessionArg }, additionalProperties: false },
      run: signedIn(async (a, auth) => {
        const path = String(a.path ?? "").replace(/^\/+/, "");
        if (path.split("/").some((part) => part === ".." || part === ".")) return { text: "The path must stay inside the project.", error: true };
        const s = await sessionFor(auth, a.session_id);
        const slug = s?.slug ?? (await featuredProject())?.slug ?? "twin-primes";
        if (s) await api(auth, "GET", `/projects/${slug}/sessions`, { session: s.id });
        const r = await fetch(`${apiBase}/projects/${slug}/docs/${path.split("/").map(encodeURIComponent).join("/")}`, { headers: { accept: "text/plain" }, signal: AbortSignal.timeout(30_000) });
        if (!r.ok) return { text: `No document at ${path || "/"} (${r.status}). An empty path lists the top folder.`, error: true };
        const text = await r.text(), from = Math.max(0, Number(a.offset ?? 0) || 0), chunk = text.slice(from, from + PAGE);
        const more = from + PAGE < text.length ? `\n\n[${text.length - from - PAGE} more characters: call again with offset ${from + PAGE}]` : "";
        return { text: chunk + more, data: { path, offset: from, length: text.length } };
      }) },
    { name: "submit_return", title: "Send the result", auth: { scopes: [SCOPE] }, annotations: write, maxArgString: MAX_REPORT,
      description: "Use this when the person agrees the work on their Solve at Home assignment is ready to send. Publishes the result under their name: another agent reads it first, then a trusted reviewer decides. Ask the person before calling it.",
      inputSchema: { type: "object", properties: {
        report_md: { type: "string", description: "The result in Markdown: the caveat and open gap first, then what you found, with the rung of each claim and the sources with locators." },
        author_rung: { type: "string", enum: [...LADDER].reverse(), description: "The highest rung the work supports. When unsure, the lower one." },
        recipe_md: { type: "string", description: "For formalize and break: how a reviewer checks it step by step by hand." },
        decision: { type: "object", description: "For curate: the decision object the task asks for." },
        patch: { type: "string", description: "Optional: a unified diff against a project document." },
        share_url: { type: "string", description: "Optional: a share link to this conversation (chatgpt.com/share/… or claude.ai/share/…), if the person wants it public with the result." },
        ...sessionArg }, required: ["report_md", "author_rung"], additionalProperties: false },
      invoking: "Sending the result…", invoked: "Result sent",
      run: signedIn(async (a, auth, link) => {
        const s = await sessionFor(auth, a.session_id);
        if (!s?.job_id) return { text: "This chat holds no assignment to answer. Call start_contributing first.", error: true };
        const share = typeof a.share_url === "string" && SHARE_URL.test(a.share_url.trim()) ? a.share_url.trim() : null;
        const transcript = await transcriptFor(s, auth, share, a);
        const r = await api(auth, "POST", `/projects/${s.slug}/result`, { session: s.id, attempt: s.attempt_id, body: {
          job_id: s.job_id, report_md: a.report_md, author_rung: a.author_rung, ...(a.recipe_md ? { recipe_md: a.recipe_md } : {}), ...(a.decision ? { decision: a.decision } : {}), ...(a.patch ? { patch: a.patch } : {}),
          transcript, transcript_approved: true } });
        if (r.status !== 200 || !r.json?.return_id) return failed(r);
        const warn = (r.json.warnings ?? []).slice(0, 5).map((w: string) => `- ${String(w).slice(0, 600)}`).join("\n");
        const shareNote = a.share_url && !share ? "\n\nThe share link was left out: only chatgpt.com/share/… and claude.ai/share/… links are kept." : "";
        return { text: `Return #${r.json.return_id} is in: ${link(`/projects/${s.slug}/return/${r.json.return_id}`)}. Another agent reads it first, then a trusted reviewer decides. Points come only if it is accepted.${warn ? `\n\nNotes from the site:\n${warn}` : ""}${shareNote}\n\nTo take another assignment, call start_contributing.`,
          data: { session_id: s.id, return_id: r.json.return_id, status: r.json.status, page: link(`/projects/${s.slug}/return/${r.json.return_id}`) } };
      }) },
    { name: "release_assignment", title: "Hand the assignment back", auth: { scopes: [SCOPE] }, annotations: write,
      description: "Use this when the person wants to stop, or the assignment needs something a chat cannot do (running code, a download). Hands the Solve at Home assignment back so someone else can take it. Nothing is published.",
      inputSchema: { type: "object", properties: { note: { type: "string", description: "Why, in one line. Optional." }, ...sessionArg }, additionalProperties: false },
      run: signedIn(async (a, auth) => {
        const s = await sessionFor(auth, a.session_id);
        if (!s?.job_id) return { text: "This chat holds no assignment.", data: { session_id: s?.id ?? null } };
        const r = await api(auth, "POST", `/projects/${s.slug}/release`, { session: s.id, attempt: s.attempt_id, body: { job_id: s.job_id, note: String(a.note ?? "handed back from a chat").slice(0, 500) } });
        if (r.status !== 200) return failed(r);
        return { text: `Job #${s.job_id} is handed back. Nothing was published.`, data: { session_id: s.id, job_id: s.job_id, released: true } };
      }) },
    { name: "my_standing", title: "See my contributions", auth: { scopes: [SCOPE] }, annotations: { readOnlyHint: true },
      description: "Use this when the person asks how their Solve at Home contributions are doing: their latest results with their review status, and their points.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: signedIn(async (_a, auth, link) => {
        const rows = await q<any>(`SELECT r.id, r.type, r.status, r.final_rung, r.created_at, p.slug FROM returns r JOIN problems p ON p.id = r.problem_id WHERE r.user_id = $1 ORDER BY r.id DESC LIMIT 10`, [auth.userId]);
        const pts = await one<{ total: string; accepted: string }>(`SELECT coalesce(sum(points),0) AS total, count(*) FILTER (WHERE kind <> 'tokens') AS accepted FROM credits WHERE user_id = $1`, [auth.userId]);
        const held = await sessionFor(auth);
        const lines = rows.map((r) => `- #${r.id} ${r.type}: ${r.status}${r.final_rung && r.final_rung !== r.status ? ` (${r.final_rung})` : ""}, ${String(r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at).slice(0, 10)}: ${link(`/projects/${r.slug}/return/${r.id}`)}`);
        return { text: `@${auth.handle}: ${Number(pts?.total ?? 0).toFixed(1)} points.${held?.job_id ? ` This chat holds job #${held.job_id}.` : ""}\n\n${lines.length ? `Latest results:\n${lines.join("\n")}` : "No results yet."}\n\nProfile: ${link(`/@${auth.handle}`)}`,
          data: { handle: auth.handle, points: Number(pts?.total ?? 0), returns: rows.map((r) => ({ id: Number(r.id), type: r.type, status: r.status, rung: r.final_rung })) } };
      }) },
  ];
}

/** The transcript of a chat return: the server's record of the session's tool calls, then this submission. One JSON object per line. */
async function transcriptFor(s: Session, auth: AuthInfo, share: string | null, args: Args): Promise<string> {
  const calls = await q<any>(`SELECT tool, args, result_text, is_error, protocol_version, created_at FROM mcp_calls WHERE session_id = $1 ORDER BY id`, [s.id]);
  const head = { kind: "mcp-observed", format: 1, note: "The server's record of this chat session's tool calls. Not the model's reasoning; the model and its token usage are not measured.", host: auth.host, session: s.id, job_id: s.job_id, ...(share ? { share_url: share } : {}) };
  const lines = [JSON.stringify(head), ...calls.map((c) => JSON.stringify({ at: c.created_at, tool: c.tool, args: c.args, result: String(c.result_text).slice(0, 20_000), ...(c.is_error ? { error: true } : {}), ...(c.protocol_version ? { protocol: c.protocol_version } : {}) })),
    JSON.stringify({ at: new Date().toISOString(), tool: "submit_return", args: { ...args, share_url: share ?? undefined } })];
  return lines.join("\n");
}

/** The signed-in plugin: the public tools as they are, plus the work tools, over OAuth, also speaking the 2026-07-28 revision. */
export function workPlugin(apiBase: string, siteUrl = process.env.BASE_URL || "https://solveathome.org"): Plugin {
  const pub = solveAtHomePlugin(undefined, siteUrl).config;
  return createPlugin({
    ...pub,
    instructions: `${pub.instructions} With the person's Solve at Home account connected, it can also take an assignment for them (start_contributing), read the project's documents (read_project_file), send the result under their name (submit_return, after asking them), hand it back (release_assignment) and show their standing (my_standing).`.replace(" The plugin only reads: it cannot submit, review, grade or credit anything, and an open item", " An open item"),
    tools: [...pub.tools, ...workTools(apiBase)],
    modern: true,
    auth: {
      resourceMetadataUrl: resourceMetadataUrl(),
      scopes: [SCOPE],
      verify: verifyAccess,
      record: async ({ tool, args, result, auth, protocolVersion }) => {
        const sessionId = String((result.data as any)?.session_id ?? args.session_id ?? (await sessionFor(auth))?.id ?? "") || null;
        await q(`INSERT INTO mcp_calls (grant_id, user_id, session_id, tool, args, result_text, is_error, protocol_version, client) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [auth.grantId, auth.userId, sessionId, tool, JSON.stringify(args).slice(0, 300_000), String(result.text).slice(0, 50_000), !!result.error, protocolVersion ?? null, auth.host]);
      },
    },
  });
}
