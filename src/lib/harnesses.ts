/**
 * One harness, one entry. Every harness the platform reads used to be spread across three places in tokens.ts: a line in the
 * detection chain, a branch of a nested ternary that found the model id, and a block in the counting loop. Adding a harness
 * meant finding all three and getting each right, and a reader could not see what the platform knew about any one of them
 * (platform issue #74, Freebuff Desktop).
 *
 * A harness is now a record: how to recognise its log, where the model id sits on a line, and how to read usage off a line.
 * The arithmetic each one does is unchanged, and it stays here beside the shape it reads, so a new harness is one entry and
 * a test, and nothing else moves.
 *
 * What a new harness needs to supply: a real log. Two of these were written from an agent's own uploaded transcript after a
 * harness report, and the counts were checked against what the harness itself stated. A format written from documentation
 * has never survived contact with a real one.
 */
import { canonicalModel } from "./model-id.js";

export type HarnessId = "claude-code" | "codex" | "copilot" | "opencode" | "antigravity" | "custom";
export type UsageSource = "claude-jsonl" | "codex-jsonl" | "copilot-jsonl" | "opencode-jsonl" | "custom-jsonl";

/** What one line of a log contributes: the four counters, the model that produced it, and the id that makes it count once. */
export type Entry = { input?: number; output?: number; cache_read?: number; cache_write?: number; model?: unknown; id?: string | null; fallbackModel?: string };

export type Harness = {
  id: HarnessId;
  name: string;
  source: UsageSource;
  /** The line shapes that identify this log. Every pattern must match somewhere in the text. */
  detect: RegExp[];
  /** Where this harness states the model on a line that carries metadata but no usage. Identity is evidence on its own. */
  model?(line: any): unknown;
  /** What this line contributes, or null when it carries no usage. */
  usage?(line: any): Entry | null;
};

/**
 * Order matters and is the order the detection chain had: the most specific shapes first, so a log that satisfies two
 * patterns is named by the one that identifies it rather than by the one it merely resembles.
 */
export const HARNESSES: Harness[] = [
  {
    id: "custom",
    name: "the solveathome format, written by the agent",
    source: "custom-jsonl",
    detect: [/"type":\s*"solveathome\.(?:transcript|turn)"/],
    model: (d) => (d?.type === "solveathome.transcript" || (d?.type === "solveathome.turn" && d.role === "assistant") ? d.model : null),
    usage: (d) => {
      if (d?.type !== "solveathome.turn") return null;
      const u = d.usage;
      if (!u || typeof u !== "object" || (u.input === undefined && u.output === undefined)) return null;
      return { input: Number(u.input ?? 0), output: Number(u.output ?? 0), cache_read: Number(u.cache_read ?? 0), cache_write: Number(u.cache_write ?? 0), model: d.model, fallbackModel: "custom" };
    },
  },
  {
    id: "antigravity",
    name: "Google Antigravity",
    source: "custom-jsonl",   // never reached: the log carries no usage at all, and the agent's stated tokens stand in
    detect: [/"type":\s*"(?:PLANNER_RESPONSE|USER_INPUT|SYSTEM_MESSAGE)"/, /"step_index"\s*:\s*\d/],
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    source: "copilot-jsonl",
    detect: [/"type":\s*"(?:assistant\.message|assistant\.turn_start|tool\.execution_(?:start|complete)|model\.model_call_success)"/],
    model: (d) => d?.type === "assistant.message" ? d.data?.model
      : d?.type === "model.model_call_success" ? d.data?.copilotUsage?.token_details?.find((x: any) => x?.model)?.model : null,
    usage: (d) => {
      if (d?.type !== "model.model_call_success" || !d?.data?.responseUsage || typeof d.data.responseUsage !== "object") return null;
      const ru = d.data.responseUsage, cached = Number(ru.prompt_tokens_details?.cached_tokens ?? 0);
      return { input: Math.max(0, Number(ru.prompt_tokens ?? 0) - cached), cache_read: cached, output: Number(ru.completion_tokens ?? 0),
        model: d.data.copilotUsage?.token_details?.find((x: any) => x?.model)?.model, fallbackModel: "copilot" };
    },
  },
  {
    id: "codex",
    name: "OpenAI Codex",
    source: "codex-jsonl",
    detect: [/"type":\s*"(?:token_count|token_usage_record|response_item|event_msg|session_meta|turn_context)"|"(?:last_token_usage|total_token_usage|thread_token_usage)"/],
    model: (d) => ["session_meta", "turn_context", "token_usage_record"].includes(d?.type) ? (d.payload?.model ?? d.model ?? d.values?.model) : null,
    // Codex's counting is stateful (a cumulative thread total that is a ceiling, and the same turn logged in two shapes), so
    // it stays in tokens.ts where that state lives; `codexUsage` there reads the per-turn shapes.
  },
  {
    id: "claude-code",
    name: "Claude Code",
    source: "claude-jsonl",
    detect: [/"type":\s*"(?:assistant|user)"\s*,/, /"message"\s*:\s*\{/],
    model: (d) => d?.type === "assistant" ? d.message?.model : null,
    usage: (d) => {
      const u = d?.message?.usage;
      if (!u || typeof u !== "object" || (u.input_tokens === undefined && u.output_tokens === undefined)) return null;
      // Claude Code writes one line per content block of a message, each repeating the same usage: the message id counts it once.
      return { input: Number(u.input_tokens ?? 0), output: Number(u.output_tokens ?? 0), cache_read: Number(u.cache_read_input_tokens ?? 0),
        cache_write: Number(u.cache_creation_input_tokens ?? 0), model: d.message?.model, id: d.message?.id ? "cc:" + String(d.message.id) : null };
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    source: "opencode-jsonl",
    detect: [/"role":\s*"assistant"/, /"(?:providerID|modelID)"\s*:/],
    model: (d) => d?.role === "assistant" && (d.modelID !== undefined || d.providerID !== undefined) ? d.modelID : null,
    usage: (d) => {
      if (d?.role !== "assistant" || !d?.tokens || typeof d.tokens !== "object" || (d.modelID === undefined && d.providerID === undefined)) return null;
      const tk = d.tokens, out = Number(tk.output ?? 0) + Number(tk.reasoning ?? 0);   // reasoning is output the person paid for
      return { input: Number(tk.input ?? 0), output: out, cache_read: Number(tk.cache?.read ?? 0), cache_write: Number(tk.cache?.write ?? 0),
        model: d.modelID, id: d.id ? "oc:" + String(d.id) : null, fallbackModel: "opencode" };
    },
  },
];

export const harnessById = (id: string): Harness | undefined => HARNESSES.find((h) => h.id === id);

/** The harness whose shapes this text carries, or null. */
export function detectHarness(text: string): Harness | null {
  return HARNESSES.find((h) => h.detect.every((re) => re.test(text))) ?? null;
}

/** The model a line states, whichever harness wrote it. Metadata fields only, never a model name in a payload. */
export function modelOnLine(line: any): unknown {
  for (const h of HARNESSES) { const m = h.model?.(line); if (m) return m; }
  return null;
}

/** The names, for a message that has to tell a person what the platform reads. */
export const harnessNames = (): string => HARNESSES.filter((h) => h.id !== "custom").map((h) => h.name).join(", ");

export { canonicalModel };
