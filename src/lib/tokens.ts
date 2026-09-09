/**
 * Token accounting (scope Q47). Counted server-side from the transcript every return must attach.
 * Claude Code JSONL: assistant entries carry message.usage {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens} and message.model.
 * Codex JSONL: events carrying usage / token_count fields (see parseCodex). Self-reported numbers are kept alongside and never override a parsed transcript.
 */
export type Tokens = { input: number; output: number; cache_read: number; cache_write: number; entries: number; source: "claude-jsonl" | "codex-jsonl" | "reported" | "none"; models?: Record<string, number> };

export function parseTranscript(text: string, reported?: any): Tokens {
  const t: Tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0, entries: 0, source: "none", models: {} };
  const lines = text.split("\n");
  // Claude Code writes one JSONL line per content block of an assistant message, each repeating the same message.usage: count a message id once.
  const seen = new Set<string>(); lastCodex = "";
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
      const m = d.message?.model; if (m) t.models![m] = (t.models![m] ?? 0) + Number(u.output_tokens ?? 0);
      continue;
    }
    const c = codexUsage(d);
    if (c) { t.input += c.input; t.output += c.output; t.cache_read += c.cache_read; t.cache_write += c.cache_write; t.entries++; t.source = "codex-jsonl"; const m = d?.payload?.model ?? d?.model ?? d?.values?.model ?? "codex"; t.models![m] = (t.models![m] ?? 0) + c.output; }
  }
  if (t.entries === 0 && reported && typeof reported === "object") {
    t.input = Number(reported.input ?? 0); t.output = Number(reported.output ?? 0); t.cache_read = Number(reported.cache_read ?? 0); t.cache_write = Number(reported.cache_write ?? 0);
    t.source = (t.input || t.output) ? "reported" : "none";
  }
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
