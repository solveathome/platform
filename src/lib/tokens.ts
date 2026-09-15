/**
 * Token accounting (scope Q47). Counted server-side from the transcript every return must attach.
 * Claude Code JSONL: assistant entries carry message.usage {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens} and message.model.
 * Codex JSONL: events carrying usage / token_count fields (see parseCodex). Self-reported numbers are kept alongside and never override a parsed transcript.
 * GitHub Copilot CLI events.jsonl (Sep 12 2026): `model.model_call_success` lines carry data.responseUsage {prompt_tokens, completion_tokens,
 * prompt_tokens_details.cached_tokens}; the CLI does not write one for every turn, so the count is what the log has. `log` names the
 * kind of record a transcript is; a summary the agent wrote is accepted but is not a session log and counts nothing.
 * Google Antigravity transcript.jsonl (Sep 13 2026, harness report #1, return #193): one step per line {step_index, source USER_EXPLICIT|MODEL|SYSTEM,
 * type USER_INPUT|PLANNER_RESPONSE|GENERIC|SYSTEM_MESSAGE, status, created_at, content | thinking + tool_calls}. It carries no usage at all, so nothing is
 * counted from it and the agent's stated `tokens` stand in (source "reported"); the model and the thinking level come from the harness's own
 * `<USER_SETTINGS_CHANGE>` block ("`Model Selection` from None to Gemini 3.8 Flash (High)") in the user step.
 */
import { createHash } from "node:crypto";
import { canonicalModel, parseEffort } from "./model-id.js";
import { HARNESSES, detectHarness, modelOnLine } from "./harnesses.js";

/** The key of a usage entry (Chris, Sep 12 2026: a usage entry counts once per person): the harness's message id when the line carries one, else the line itself. */
const lineKey = (s: string): string => "l:" + createHash("sha1").update(s).digest("hex").slice(0, 16);

/** No single return spends more than this per field; anything above is a forged or broken transcript, not usage. */
export const MAX_TOKENS_PER_FIELD = 50_000_000;
export type LogKind = "claude-code" | "codex" | "copilot" | "opencode" | "antigravity" | "custom" | "withheld" | "summary" | "unknown";
/** A transcript that is not the assignment's own (issue #55): what it names or when it ends, in words for the agent and the page. */
export type Mismatch = { reason: string; job: number; jobs_named?: number[]; ends_at?: string };
/** Usage entries of this transcript that were already counted on the person's earlier returns or reviews, and where. */
export type AlreadyCounted = { entries: number; of: number; on: string[] };
export type Tokens = { input: number; output: number; cache_read: number; cache_write: number; entries: number; source: "claude-jsonl" | "codex-jsonl" | "copilot-jsonl" | "opencode-jsonl" | "custom-jsonl" | "reported" | "none"; models?: Record<string, number>; observed_models?: string[]; log?: LogKind; mismatch?: Mismatch; already_counted?: AlreadyCounted };

/**
 * The assignments a transcript names: the brief's title line ("# solveathome job #N", the GET /start result) and the job_id the agent
 * sends in its chat posts and its return (a tool call's input). Both appear escaped inside tool results and plain in tool inputs.
 */
export function jobsNamed(text: string): number[] {
  const t = String(text ?? ""); const ids = new Set<number>();
  for (const m of t.matchAll(/solveathome job #(\d+)/g)) ids.add(Number(m[1]));
  for (const m of t.matchAll(/\\?"job_id\\?"\s*:\s*\\?"?(\d+)/g)) ids.add(Number(m[1]));
  return [...ids].sort((a, b) => a - b);
}
/** When the log ends: the latest ISO "timestamp" (Claude Code, Codex, Copilot) or "created_at" (Antigravity), or millisecond "created" (OpenCode) it carries; null when it carries none. */
export function logEndsAt(text: string): Date | null {
  let max = 0;
  for (const m of String(text ?? "").matchAll(/"(?:timestamp|created_at)"\s*:\s*"(\d{4}-\d{2}-\d{2}T[^"]{5,40})"/g)) { const v = Date.parse(m[1]); if (Number.isFinite(v) && v > max) max = v; }
  for (const m of String(text ?? "").matchAll(/"created"\s*:\s*(1[5-9]\d{11})\b/g)) { const v = Number(m[1]); if (v > max) max = v; }
  return max ? new Date(max) : null;
}
/** Clock skew a log may show before it counts as ending too early; a log from another assignment is hours off, a wrong clock rarely a whole hour. */
export const MISMATCH_SLACK_MS = 60 * 60_000;
/**
 * Whether a transcript belongs to the assignment it is sent for (issue #55: return #160 carried job #282's session). Two cheap checks:
 * it names other assignments and never this one, or every line of it predates the assignment. A log naming nothing and carrying no time passes.
 */
export function assignmentMismatch(text: string, jobId: number, assignedAt: Date | null): Mismatch | null {
  const jobs = jobsNamed(text);
  if (jobs.length && !jobs.includes(Number(jobId))) return { reason: `it names assignment${jobs.length > 1 ? "s" : ""} ${jobs.map((j) => `#${j}`).join(", ")} and never #${jobId}`, job: Number(jobId), jobs_named: jobs };
  const ends = logEndsAt(text);
  if (ends && assignedAt && Number.isFinite(assignedAt.getTime()) && ends.getTime() < assignedAt.getTime() - MISMATCH_SLACK_MS) return { reason: `its last line is from ${ends.toISOString().slice(0, 16).replace("T", " ")} UTC, before assignment #${jobId} was handed out at ${assignedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`, job: Number(jobId), ends_at: ends.toISOString() };
  return null;
}
/** Accepted as a transcript: a harness's own log, or one the agent wrote in the solveathome format (labelled agent-written, counts what it states). */
export const SESSION_LOG_KINDS: LogKind[] = ["claude-code", "codex", "copilot", "opencode", "antigravity", "custom"];
/** The format an agent may write itself when its harness keeps no log (Chris, Sep 12 2026); spec in docs/transcript-format.md. */
export const CUSTOM_FORMAT_URL = "https://github.com/solveathome/platform/blob/main/docs/transcript-format.md";
export const isSessionLog = (t: { log?: LogKind } | null | undefined): boolean => !!t?.log && SESSION_LOG_KINDS.includes(t.log);
/** A transcript the author wrote instead of attaching the log (summary), or one no known harness wrote (unknown). Withheld pre-launch transcripts are neither. */
export const notSessionLog = (t: { log?: LogKind } | null | undefined): boolean => t?.log === "summary" || t?.log === "unknown";

/**
 * What kind of record a transcript is, from the line shapes: a Claude Code session file, a Codex rollout, a Copilot CLI events log, an OpenCode
 * export, an Antigravity transcript.jsonl, or neither: a summary the agent wrote (it usually says so: "activity_summary", "not a native transcript")
 * or something unrecognised.
 */
export function logKind(text: string): LogKind {
  const t = String(text ?? "");
  const harness = detectHarness(t);
  if (harness) return harness.id;
  if (/^\s*\[transcript withheld/i.test(t)) return "withheld";
  if (/"type":\s*"activity_summary"|not a (?:native )?(?:conversation )?transcript|activity summary/i.test(t)) return "summary";
  const jsonLines = t.split("\n").filter((l) => l.trim().startsWith("{")).length;
  return jsonLines < 3 ? "summary" : "unknown";
}

/**
 * Antigravity's own record of what the person selected, in the user step: "The user changed setting `Model Selection` from None to
 * Gemini 3.8 Flash (High)." The name canonicalises to the model id (gemini-3.8-flash); the word in parentheses is the thinking level.
 */
export function antigravitySetting(content: unknown): { model: string; level: string | null } | null {
  // The sentence ends with a full stop followed by space or end of text; "3.8" inside the name is not the end.
  const m = /`Model Selection` from [^\n]*? to ([A-Za-z0-9][A-Za-z0-9 .\-]*?)(?:\s*\(([A-Za-z][A-Za-z \-]*)\))?\s*\.(?=\s|$)/.exec(String(content ?? ""));
  if (!m) return null;
  const model = canonicalModel(m[1]); if (!model || model === "none") return null;
  return { model, level: m[2] ? m[2].trim().toLowerCase() : null };
}

/** The shape of an unrecognised log: the sorted top-level keys of its first JSON lines, so one harness is one report however many returns it sends. */
export function logSignature(text: string): string {
  const shapes: string[] = [];
  for (const line of String(text ?? "").split("\n")) {
    const s = line.trim(); if (!s.startsWith("{")) continue;
    try { const d = JSON.parse(s); shapes.push(Object.keys(d).sort().join(",")); } catch { shapes.push("<unparsed>"); }
    if (shapes.length >= 5) break;
  }
  return [...new Set(shapes)].join(" | ").slice(0, 1000);
}
/** The first lines of a log, truncated, for a person to look at. */
export function logHead(text: string, lines = 3, width = 400): string {
  return String(text ?? "").split("\n").filter((l) => l.trim()).slice(0, lines).map((l) => l.length > width ? l.slice(0, width) + "…" : l).join("\n");
}

/** Runtime discovery guidance shared by orientation and intake warnings; app examples stay in the reference. */
export const LOG_LOCATIONS = "Identify this application session explicitly from its metadata; never choose a log by newest modification time. Research the installed application's supported APIs, exports, documentation or read-only records. Build or reuse a scoped reader with available native tools, verify its schema and bind records to this assignment. No JSONL file does not mean no usage; inspect database/export records when applicable. Keep private stores and unrelated sessions local. If no supported export exists, implement one in the solveathome transcript format (" + CUSTOM_FORMAT_URL + "): preserve what was said, run and returned, with only observed attributable usage. Validate the exporter before research, keep incomplete usage pending and reconcile it later. Optional application examples in that reference are starting points to verify locally, not requirements for a particular runtime.";

/** How much of a transcript's tool output was replaced by omission notes (issue #46): outputs counted by their JSONL types, omissions by bracketed notes saying "omitted". */
/**
 * A note that stands in for content: the whole segment is the note, not a sentence that mentions one. A real note is long,
 * because it says what was inspected instead ("[Third-party search/source payload omitted. Exact upper statement inspected:
 * Klaus Dohmen, arXiv:1004.3416v2, section 1 Proposition 1.1 …]"), so length is not the test; being the whole segment is.
 */
function isOmissionNote(segment: string): boolean {
  const s = segment.trim();
  if (s.length < 12 || s.length > 4000) return false;
  if (!s.startsWith("[") || !s.endsWith("]")) return false;
  if (/^\[\s*[{"[]/.test(s) || s.includes("{")) return false;   // a JSON array of records is not a note
  return /\bomitted\b/i.test(s);
}
const OUTPUT_TYPES = new Set(["custom_tool_call_output", "function_call_output", "tool_result"]);

/** Every string a tool output carries, as separate segments: array elements and lines are each their own segment. */
function outputSegments(value: unknown, into: string[] = [], depth = 0): string[] {
  if (depth > 6 || into.length > 500) return into;
  if (typeof value === "string") { for (const line of value.split("\n")) into.push(line.trim()); return into; }
  if (Array.isArray(value)) { for (const v of value) outputSegments(v, into, depth + 1); return into; }
  if (value && typeof value === "object") for (const k of ["output", "content", "text", "result"]) if (k in (value as any)) outputSegments((value as any)[k], into, depth + 1);
  return into;
}

/** Walks a parsed JSONL line for tool-output records, whatever the harness nests them in. */
function collectOutputs(node: unknown, into: unknown[], depth = 0): void {
  if (depth > 8 || into.length > 2000 || !node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const v of node) collectOutputs(v, into, depth + 1); return; }
  const o = node as Record<string, unknown>;
  if (typeof o.type === "string" && OUTPUT_TYPES.has(o.type)) into.push(o);
  for (const v of Object.values(o)) if (v && typeof v === "object") collectOutputs(v, into, depth + 1);
}

/**
 * How much of a transcript is omission notes standing in for tool output (issue #46). Counted from the decoded records, not
 * from the raw text: an output is omitted when one of its own segments *is* a note, and it counts once however many notes it
 * carries. Matching the marker anywhere in the file counted a scrubber's own template quoted in a displayed helper, a note
 * about an omission written in the report, and the same native record echoed twice, and it mixed units, so a transcript could
 * be told it had replaced 7 of 3 outputs or 8 of 13 that were all present (platform issues #62 and #70).
 */
export function omissionShare(text: string): { outputs: number; omitted: number; share: number } {
  const t = String(text ?? "");
  let outputs = 0, omitted = 0;
  for (const line of t.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{") && !s.startsWith("[")) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(s); } catch { continue; }
    const found: unknown[] = [];
    collectOutputs(parsed, found);
    for (const rec of found) {
      outputs++;
      if (outputSegments(rec).some(isOmissionNote)) omitted++;
    }
  }
  return { outputs, omitted, share: outputs ? Math.min(1, omitted / outputs) : 0 };
}

export function parseTranscript(text: string, reported?: any): Tokens { return parseTranscriptWithKeys(text, reported).tokens; }
/**
 * The count plus the key of every counted usage entry, so the caller can record them per person and pass the ones already on record
 * as `exclude`: those entries are skipped (listed in `skipped`), and the self-reported fallback never fills in for skipped entries.
 */
export function parseTranscriptWithKeys(text: string, reported?: any, exclude?: Set<string>): { tokens: Tokens; keys: string[]; skipped: string[] } {
  const t: Tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0, entries: 0, source: "none", models: {}, observed_models: [] };
  // Explicit metadata is separate from the synthetic codex/copilot/opencode usage buckets.
  const rememberModel = (raw: unknown): string => {
    const m = canonicalModel(raw);
    if (m && !t.observed_models!.includes(m)) t.observed_models!.push(m);
    return m;
  };
  const keys: string[] = [], skipped: string[] = [];
  const take = (key: string): boolean => { if (exclude?.has(key)) { skipped.push(key); return false; } keys.push(key); return true; };
  const lines = text.split("\n");
  // Claude Code writes one JSONL line per content block of an assistant message, each repeating the same message.usage: count a message id once.
  const seen = new Set<string>(); lastCodex = "";
  // Codex logs carry a cumulative counter (total_token_usage / thread_token_usage) that runs since the thread started, not since the
  // assignment: crediting it charged a second return in the same thread with the whole thread again (issue #49). It is now only a ceiling.
  // The same turn is logged in two shapes (token_count.last_token_usage and token_usage_record.usage): count one shape, the finer one when present.
  let cumulative: any = null;
  const hasRecords = /"type":\s*"token_usage_record"/.test(text);
  const consider = (u: any) => { if (u && typeof u === "object" && u.total_tokens !== undefined && Number(u.total_tokens) > Number(cumulative?.total_tokens ?? -1)) cumulative = u; };
  for (const line of lines) {
    const s = line.trim(); if (!s.startsWith("{")) continue;
    let d: any; try { d = JSON.parse(s); } catch { continue; }
    // Identity is evidence even without usage or when the usage was already credited.
    // Read only known metadata fields, never model names in conversation/tool payloads.
    rememberModel(modelOnLine(d));
    // Antigravity steps carry no usage; the user step names the model the person selected (kept so X-Model can be checked).
    if (typeof d?.step_index === "number" && typeof d?.source === "string") { const st = typeof d.content === "string" && d.content.includes("Model Selection") ? antigravitySetting(d.content) : null; if (st) { rememberModel(st.model); t.models![st.model] = t.models![st.model] ?? 0; } continue; }
    // A harness that reads usage off one line reads it here; the arithmetic lives beside the shape it reads (harnesses.ts).
    // The solveathome header line names the model for the turns that follow and carries no usage of its own.
    if (d?.type === "solveathome.transcript") { const m = rememberModel(d.model); if (m) t.models![m] = t.models![m] ?? 0; continue; }
    let handled = false;
    for (const h of HARNESSES) {
      const e = h.usage?.(d);
      if (!e) continue;
      handled = true;
      if (e.id) { if (seen.has(e.id)) break; seen.add(e.id); }
      if (!take(e.id ?? lineKey(s))) break;
      t.input += e.input ?? 0; t.output += e.output ?? 0; t.cache_read += e.cache_read ?? 0; t.cache_write += e.cache_write ?? 0;
      t.entries++; t.source = h.source;
      const m = rememberModel(e.model) || (e.fallbackModel ? (Object.keys(t.models ?? {})[0] || e.fallbackModel) : "");
      if (m) t.models![m] = (t.models![m] ?? 0) + (e.output ?? 0);
      break;
    }
    if (handled || d?.type === "solveathome.turn") continue;
    // A Copilot assistant.message names the model that answered but carries no usage; keep it so X-Model can be checked.
    if (d?.type === "assistant.message" && d?.data?.model) { const m = rememberModel(d.data.model); if (m) t.models![m] = t.models![m] ?? 0; continue; }
    consider(d?.payload?.info?.total_token_usage); consider(d?.info?.total_token_usage); consider(d?.values?.info?.total_token_usage);
    consider(d?.values?.thread_token_usage); consider(d?.thread_token_usage);
    if (hasRecords && d?.type !== "token_usage_record" && (d?.payload?.info?.last_token_usage || d?.info?.last_token_usage || d?.values?.info?.last_token_usage)) continue;   // the same turn is in a token_usage_record line
    const c = codexUsage(d);
    if (c && !take(lineKey(s))) continue;
    if (c) { t.input += c.input; t.output += c.output; t.cache_read += c.cache_read; t.cache_write += c.cache_write; t.entries++; t.source = "codex-jsonl"; const m = rememberModel(d?.payload?.model ?? d?.model ?? d?.values?.model) || "codex"; t.models![m] = (t.models![m] ?? 0) + c.output; }
  }
  if (cumulative && t.source === "codex-jsonl") {
    // A ceiling only: the per-turn sum of the assignment's window can never exceed the thread's running total.
    const cached = Number(cumulative.cached_input_tokens ?? 0);
    t.input = Math.min(t.input, Math.max(0, Number(cumulative.input_tokens ?? 0) - cached)); t.cache_read = Math.min(t.cache_read, cached); t.output = Math.min(t.output, Number(cumulative.output_tokens ?? 0)); t.cache_write = Math.min(t.cache_write, Number(cumulative.cache_write_input_tokens ?? 0));
    const keys = Object.keys(t.models ?? {}); if (keys.length === 1) t.models![keys[0]] = t.output;
  }
  if (t.entries === 0 && skipped.length === 0 && reported && typeof reported === "object") {
    t.input = Number(reported.input ?? 0); t.output = Number(reported.output ?? 0); t.cache_read = Number(reported.cache_read ?? 0); t.cache_write = Number(reported.cache_write ?? 0);
    t.source = (t.input || t.output) ? "reported" : "none";
  }
  for (const k of ["input", "output", "cache_read", "cache_write"] as const) t[k] = Math.min(Math.max(0, Number.isFinite(t[k]) ? t[k] : 0), MAX_TOKENS_PER_FIELD);
  for (const k of Object.keys(t.models ?? {})) t.models![k] = Math.min(Math.max(0, t.models![k] || 0), MAX_TOKENS_PER_FIELD);
  t.log = logKind(text);
  return { tokens: t, keys, skipped };
}

/**
 * Codex and Codex-shaped logs. The CLI's own session JSONL carries `token_count` events with `info.last_token_usage`
 * (per turn) and `info.total_token_usage` (cumulative); agents that rewrite their log tend to keep the same field names
 * under `usage`, `turn_token_usage` or `values.usage`. Per line, read one per-turn record in that preference order, never a
 * cumulative one, and skip a record identical to the previous line's (the CLI logs the same turn twice).
 */
let lastCodex = "";
function codexUsage(d: any): { input: number; output: number; cache_read: number; cache_write: number } | null {
  const pick = (u: any) => u && typeof u === "object" && (u.input_tokens !== undefined || u.output_tokens !== undefined) && u.cached_input_tokens !== undefined ? u : null;
  const candidates = [
    d?.payload?.info?.last_token_usage, d?.info?.last_token_usage, d?.values?.info?.last_token_usage,
    d?.payload?.usage, d?.values?.turn_token_usage, d?.turn_token_usage, d?.values?.usage, d?.usage,
  ];
  let u: any = null;
  for (const c of candidates) { u = pick(c); if (u) break; }
  if (!u && d?.type === "token_usage_record") u = d?.payload?.usage ?? null;
  if (!u) return null;
  const key = `${u.input_tokens}|${u.cached_input_tokens}|${u.output_tokens}|${u.reasoning_output_tokens ?? ""}`;
  if (key === lastCodex) return null;
  lastCodex = key;
  const cached = Number(u.cached_input_tokens ?? 0);
  return { input: Math.max(0, Number(u.input_tokens ?? 0) - cached), output: Number(u.output_tokens ?? 0), cache_read: cached, cache_write: Number(u.cache_write_input_tokens ?? 0) };
}
export function total(t: Tokens): number { return t.input + t.output + t.cache_read + t.cache_write; }

/**
 * The thinking level a Claude Code session ran at, from its own record (Sep 12 2026): every assistant line of the session JSONL carries a
 * top-level `effort`. The last assistant line wins (a person can change it mid-session). The model itself does not know its level and
 * guesses when asked, so this is the evidence the server trusts over the declared X-Effort. OpenCode records it as `variant` on its assistant
 * messages. Antigravity writes the level in parentheses after the model the person selected, in the user step's `<USER_SETTINGS_CHANGE>` block.
 * Codex and Copilot CLI logs carry none, and the agent-written solveathome format is not evidence: null.
 */
export function effortFromTranscript(text: string): string | null {
  let last: string | null = null;
  for (const line of String(text ?? "").split("\n")) {
    const s = line.trim(); if (!s.startsWith("{") || !(s.includes('"effort"') || s.includes('"variant"') || s.includes("Model Selection"))) continue;
    let d: any; try { d = JSON.parse(s); } catch { continue; }
    const ag = typeof d?.step_index === "number" && typeof d?.content === "string" ? antigravitySetting(d.content) : null;
    const raw = ag ? ag.level : d?.type === "assistant" && typeof d.effort === "string" ? d.effort : d?.role === "assistant" && typeof d.variant === "string" && (d.modelID !== undefined || d.providerID !== undefined) ? d.variant : null;
    if (!raw) continue;
    const e = parseEffort(raw); if (e) last = e;
  }
  return last;
}
