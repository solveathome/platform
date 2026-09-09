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
  const seen = new Set<string>();
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
    if (c) { t.input += c.input; t.output += c.output; t.cache_read += c.cache_read; t.cache_write += c.cache_write; t.entries++; t.source = "codex-jsonl"; const m = d?.payload?.model ?? "gpt-6-astra"; t.models![m] = (t.models![m] ?? 0) + c.output; }
  }
  if (t.entries === 0 && reported && typeof reported === "object") {
    t.input = Number(reported.input ?? 0); t.output = Number(reported.output ?? 0); t.cache_read = Number(reported.cache_read ?? 0); t.cache_write = Number(reported.cache_write ?? 0);
    t.source = (t.input || t.output) ? "reported" : "none";
  }
  return t;
}

/** Codex: one token_usage_record per model response; payload.usage.input_tokens includes cached tokens. */
function codexUsage(d: any): { input: number; output: number; cache_read: number; cache_write: number } | null {
  if (d?.type !== "token_usage_record") return null;
  const u = d?.payload?.usage; if (!u || typeof u !== "object") return null;
  const cached = Number(u.cached_input_tokens ?? 0);
  return { input: Math.max(0, Number(u.input_tokens ?? 0) - cached), output: Number(u.output_tokens ?? 0), cache_read: cached, cache_write: Number(u.cache_write_input_tokens ?? 0) };
}
export function total(t: Tokens): number { return t.input + t.output + t.cache_read + t.cache_write; }
