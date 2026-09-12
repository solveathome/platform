/**
 * Token accounting (scope Q47). Counted server-side from the transcript every return must attach.
 * Claude Code JSONL: assistant entries carry message.usage {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens} and message.model.
 * Codex JSONL: events carrying usage / token_count fields (see parseCodex). Self-reported numbers are kept alongside and never override a parsed transcript.
 * GitHub Copilot CLI events.jsonl (Sep 12 2026): `model.model_call_success` lines carry data.responseUsage {prompt_tokens, completion_tokens,
 * prompt_tokens_details.cached_tokens}; the CLI does not write one for every turn, so the count is what the log has. `log` names the
 * kind of record a transcript is; a summary the agent wrote is accepted but is not a session log and counts nothing.
 */
import { canonicalModel, parseEffort } from "./model-id.js";

/** No single return spends more than this per field; anything above is a forged or broken transcript, not usage. */
export const MAX_TOKENS_PER_FIELD = 50_000_000;
export type LogKind = "claude-code" | "codex" | "copilot" | "opencode" | "custom" | "withheld" | "summary" | "unknown";
export type Tokens = { input: number; output: number; cache_read: number; cache_write: number; entries: number; source: "claude-jsonl" | "codex-jsonl" | "copilot-jsonl" | "opencode-jsonl" | "custom-jsonl" | "reported" | "none"; models?: Record<string, number>; log?: LogKind };
/** Accepted as a transcript: a harness's own log, or one the agent wrote in the solveathome format (labelled agent-written, counts what it states). */
export const SESSION_LOG_KINDS: LogKind[] = ["claude-code", "codex", "copilot", "opencode", "custom"];
/** The format an agent may write itself when its harness keeps no log (Chris, Sep 12 2026); spec in docs/transcript-format.md. */
export const CUSTOM_FORMAT_URL = "https://github.com/solveathome/platform/blob/main/docs/transcript-format.md";
export const isSessionLog = (t: { log?: LogKind } | null | undefined): boolean => !!t?.log && SESSION_LOG_KINDS.includes(t.log);
/** A transcript the author wrote instead of attaching the log (summary), or one no known harness wrote (unknown). Withheld pre-launch transcripts are neither. */
export const notSessionLog = (t: { log?: LogKind } | null | undefined): boolean => t?.log === "summary" || t?.log === "unknown";

/**
 * What kind of record a transcript is, from the line shapes: a Claude Code session file, a Codex rollout, a Copilot CLI events log, or
 * neither: a summary the agent wrote (it usually says so: "activity_summary", "not a native transcript") or something unrecognised.
 */
export function logKind(text: string): LogKind {
  const t = String(text ?? "");
  if (/"type":\s*"solveathome\.(?:transcript|turn)"/.test(t)) return "custom";
  if (/"type":\s*"(?:assistant\.message|assistant\.turn_start|tool\.execution_(?:start|complete)|model\.model_call_success)"/.test(t)) return "copilot";
  if (/"type":\s*"(?:token_count|token_usage_record|response_item|event_msg|session_meta|turn_context)"/.test(t) || /"(?:last_token_usage|total_token_usage|thread_token_usage)"/.test(t)) return "codex";
  if (/"type":\s*"(?:assistant|user)"\s*,/.test(t) && /"message"\s*:\s*\{/.test(t)) return "claude-code";
  if (/"role":\s*"assistant"/.test(t) && /"(?:providerID|modelID)"\s*:/.test(t)) return "opencode";
  if (/^\s*\[transcript withheld/i.test(t)) return "withheld";
  if (/"type":\s*"activity_summary"|not a (?:native )?(?:conversation )?transcript|activity summary/i.test(t)) return "summary";
  const jsonLines = t.split("\n").filter((l) => l.trim().startsWith("{")).length;
  return jsonLines < 3 ? "summary" : "unknown";
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

/** Where each harness keeps the session log, for the brief, the orientation and the intake warning. */
export const LOG_LOCATIONS = "Claude Code: `~/.claude/projects/<encoded-cwd>/<session>.jsonl` (newest: `ls -t ~/.claude/projects/$(pwd | tr / -)/*.jsonl | head -1`). Codex: `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`. GitHub Copilot CLI: `~/.copilot/session-state/<session-id>/events.jsonl` (under `$COPILOT_HOME` if you relocated it; newest: `ls -td ~/.copilot/session-state/*/ | head -1`). OpenCode: `opencode export <session-id>`, or the message files under `~/.local/share/opencode/storage/`, one JSON object per line. If your harness keeps no log at all, write one in the solveathome transcript format (" + CUSTOM_FORMAT_URL + "): one JSON line per turn with what was said, run and returned, and the usage you can read from your harness; it is accepted, counted as you state it, and labelled agent-written on the record.";

/** How much of a transcript's tool output was replaced by omission notes (issue #46): outputs counted by their JSONL types, omissions by bracketed notes saying "omitted". */
export function omissionShare(text: string): { outputs: number; omitted: number; share: number } {
  const t = String(text ?? "");
  const outputs = (t.match(/"type":\s*"(?:custom_tool_call_output|function_call_output|tool_result)"/g) ?? []).length;
  const omitted = (t.match(/\[[^\]\n]{0,200}\bomitted\b[^\]\n]{0,200}\]/gi) ?? []).length;
  return { outputs, omitted, share: outputs ? Math.min(1, omitted / outputs) : 0 };
}

export function parseTranscript(text: string, reported?: any): Tokens {
  const t: Tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0, entries: 0, source: "none", models: {} };
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
    const u = d?.message?.usage;
    if (u && typeof u === "object" && (u.input_tokens !== undefined || u.output_tokens !== undefined)) {
      const id = d.message?.id ? String(d.message.id) : null;
      if (id) { if (seen.has(id)) continue; seen.add(id); }
      t.input += Number(u.input_tokens ?? 0); t.output += Number(u.output_tokens ?? 0);
      t.cache_read += Number(u.cache_read_input_tokens ?? 0); t.cache_write += Number(u.cache_creation_input_tokens ?? 0);
      t.entries++; t.source = "claude-jsonl";
      const m = canonicalModel(d.message?.model); if (m) t.models![m] = (t.models![m] ?? 0) + Number(u.output_tokens ?? 0);
      continue;
    }
    // The solveathome format (agent-written): a header line names the model; each turn may carry usage {input, output, cache_read, cache_write}.
    if (d?.type === "solveathome.transcript") { const m = canonicalModel(d.model); if (m) t.models![m] = t.models![m] ?? 0; continue; }
    if (d?.type === "solveathome.turn") {
      const u = d.usage;
      if (u && typeof u === "object" && (u.input !== undefined || u.output !== undefined)) {
        t.input += Number(u.input ?? 0); t.output += Number(u.output ?? 0); t.cache_read += Number(u.cache_read ?? 0); t.cache_write += Number(u.cache_write ?? 0);
        t.entries++; t.source = "custom-jsonl";
        const m = canonicalModel(d.model) || Object.keys(t.models ?? {})[0] || "custom"; t.models![m] = (t.models![m] ?? 0) + Number(u.output ?? 0);
      }
      continue;
    }
    // Copilot CLI: usage sits on model.model_call_success lines; the model that answered is on assistant.message lines (kept so X-Model can be checked).
    if (d?.type === "model.model_call_success" && d?.data?.responseUsage && typeof d.data.responseUsage === "object") {
      const ru = d.data.responseUsage; const cached = Number(ru.prompt_tokens_details?.cached_tokens ?? 0);
      t.input += Math.max(0, Number(ru.prompt_tokens ?? 0) - cached); t.cache_read += cached; t.output += Number(ru.completion_tokens ?? 0);
      t.entries++; t.source = "copilot-jsonl";
      const m = canonicalModel(d.data.copilotUsage?.token_details?.find((x: any) => x?.model)?.model) || "copilot"; t.models![m] = (t.models![m] ?? 0) + Number(ru.completion_tokens ?? 0);
      continue;
    }
    if (d?.type === "assistant.message" && d?.data?.model) { const m = canonicalModel(d.data.model); if (m) t.models![m] = t.models![m] ?? 0; continue; }
    // OpenCode: each assistant message carries tokens {input, output, reasoning, cache: {read, write}} and modelID; step-finish lines repeat them and are skipped.
    if (d?.role === "assistant" && d?.tokens && typeof d.tokens === "object" && (d.modelID !== undefined || d.providerID !== undefined)) {
      const id = d.id ? String(d.id) : null; if (id) { if (seen.has(id)) continue; seen.add(id); }
      const tk = d.tokens; const out = Number(tk.output ?? 0) + Number(tk.reasoning ?? 0);
      t.input += Number(tk.input ?? 0); t.output += out; t.cache_read += Number(tk.cache?.read ?? 0); t.cache_write += Number(tk.cache?.write ?? 0);
      t.entries++; t.source = "opencode-jsonl";
      const m = canonicalModel(d.modelID) || "opencode"; t.models![m] = (t.models![m] ?? 0) + out;
      continue;
    }
    consider(d?.payload?.info?.total_token_usage); consider(d?.info?.total_token_usage); consider(d?.values?.info?.total_token_usage);
    consider(d?.values?.thread_token_usage); consider(d?.thread_token_usage);
    if (hasRecords && d?.type !== "token_usage_record" && (d?.payload?.info?.last_token_usage || d?.info?.last_token_usage || d?.values?.info?.last_token_usage)) continue;   // the same turn is in a token_usage_record line
    const c = codexUsage(d);
    if (c) { t.input += c.input; t.output += c.output; t.cache_read += c.cache_read; t.cache_write += c.cache_write; t.entries++; t.source = "codex-jsonl"; const m = canonicalModel(d?.payload?.model ?? d?.model ?? d?.values?.model) || "codex"; t.models![m] = (t.models![m] ?? 0) + c.output; }
  }
  if (cumulative && t.source === "codex-jsonl") {
    // A ceiling only: the per-turn sum of the assignment's window can never exceed the thread's running total.
    const cached = Number(cumulative.cached_input_tokens ?? 0);
    t.input = Math.min(t.input, Math.max(0, Number(cumulative.input_tokens ?? 0) - cached)); t.cache_read = Math.min(t.cache_read, cached); t.output = Math.min(t.output, Number(cumulative.output_tokens ?? 0)); t.cache_write = Math.min(t.cache_write, Number(cumulative.cache_write_input_tokens ?? 0));
    const keys = Object.keys(t.models ?? {}); if (keys.length === 1) t.models![keys[0]] = t.output;
  }
  if (t.entries === 0 && reported && typeof reported === "object") {
    t.input = Number(reported.input ?? 0); t.output = Number(reported.output ?? 0); t.cache_read = Number(reported.cache_read ?? 0); t.cache_write = Number(reported.cache_write ?? 0);
    t.source = (t.input || t.output) ? "reported" : "none";
  }
  for (const k of ["input", "output", "cache_read", "cache_write"] as const) t[k] = Math.min(Math.max(0, Number.isFinite(t[k]) ? t[k] : 0), MAX_TOKENS_PER_FIELD);
  for (const k of Object.keys(t.models ?? {})) t.models![k] = Math.min(Math.max(0, t.models![k] || 0), MAX_TOKENS_PER_FIELD);
  t.log = logKind(text);
  return t;
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
 * messages. Codex and Copilot CLI logs carry none, and the agent-written solveathome format is not evidence: null.
 */
export function effortFromTranscript(text: string): string | null {
  let last: string | null = null;
  for (const line of String(text ?? "").split("\n")) {
    const s = line.trim(); if (!s.startsWith("{") || !(s.includes('"effort"') || s.includes('"variant"'))) continue;
    let d: any; try { d = JSON.parse(s); } catch { continue; }
    const raw = d?.type === "assistant" && typeof d.effort === "string" ? d.effort : d?.role === "assistant" && typeof d.variant === "string" && (d.modelID !== undefined || d.providerID !== undefined) ? d.variant : null;
    if (!raw) continue;
    const e = parseEffort(raw); if (e) last = e;
  }
  return last;
}
