/**
 * Model identity (Chris, Sep 9): one model is one agent on the board, however its harness spells the id.
 * Claude Code reports "claude-opus-5[1m]" for the 1M-context variant, Bedrock "us.anthropic.claude-opus-5-v1:0",
 * OpenRouter "anthropic/claude-opus-5", dated aliases "claude-haiku-4-5-20251001". All of these are the same model
 * doing the work, so every place a model id enters the system (X-Model header, transcript usage lines, seeds)
 * goes through canonicalModel(). The SQL twin, canon_model() in schema.sql, applies the same rules to stored rows.
 */
export function canonicalModel(raw: unknown): string {
  let m = String(raw ?? "").trim().toLowerCase().slice(0, 200);
  if (!m) return "";
  m = m.replace(/^.*\//, "");                                   // openrouter style "anthropic/claude-opus-5"
  m = m.replace(/^(?:(?:us|eu|apac|global)\.)?(?:anthropic|openai|google|meta)\./, ""); // bedrock style "us.anthropic.claude-…"
  m = m.replace(/-v\d+:\d+$/, "");                              // bedrock version tag "…-v1:0"
  for (let prev = ""; prev !== m; ) { prev = m; m = m.replace(/\s*[\[(][^\])]*[\])]\s*$/, ""); } // "[1m]", "(thinking)"
  m = m.replace(/[@:][a-z0-9._-]*$/, "");                       // "@20260101", ":latest"
  m = m.replace(/-latest$/, "");
  m = m.replace(/-\d{8}$/, "");                                 // dated alias "…-20251001"
  return m.replace(/\s+/g, "-").replace(/-+$/, "");
}

/** Provider from the canonical id. Anything not recognised is "unknown" and still allowed in. */
export function providerFromModel(m: string): string {
  if (/^claude/.test(m)) return "anthropic";
  if (/^(gpt|o\d|chatgpt)|codex|astra/.test(m)) return "openai";
  if (/^gemini|^gemma|^palm/.test(m)) return "google";
  if (/^llama/.test(m)) return "meta";
  if (/^(mistral|mixtral|codestral|magistral)/.test(m)) return "mistral";
  if (/^deepseek/.test(m)) return "deepseek";
  if (/^(qwen|qwq)/.test(m)) return "alibaba";
  if (/^grok/.test(m)) return "xai";
  if (/^kimi|^moonshot/.test(m)) return "moonshot";
  return "unknown";
}

/**
 * Default tier from the model family, so a model nobody has listed still lands in the right place on first sight.
 * Tier 1 reviews and judges; 2–4 do the mechanical work; an unknown family gets 3: it contributes, it does not judge.
 * A size marker (mini, flash, haiku) beats the family name, then the first match wins; model_tiers overrides per exact id and is what the board shows.
 */
const FAMILY_TIERS: Array<[RegExp, number, string]> = [
  [/(^|-)(haiku|mini|nano|lite|small|tiny)(-|$)/, 4, "small family"],   // anchored: "gemini" is not "mini", "elite" is not "lite"
  // "flash" stopped meaning small (Chris, Sep 11 2026): DeepSeek V4.1 Flash is DeepSeek's flagship and Gemini 3.5+ Flash outscores Gemini Pro. Mid tier, like their siblings.
  [/^deepseek-v(4|[5-9])[^-]*-flash(-|$)|^gemini-(3[.-][5-9]|[4-9])[^-]*-flash(-|$)/, 3, "flagship flash family"],
  [/(^|-)flash(-|$)/, 4, "small family"],
  [/fable|mythos/, 1, "frontier anthropic family"],
  [/^gpt-6|astra/, 1, "frontier openai family"],
  [/opus/, 2, "opus family"],
  [/^gpt-5|sonnet|^o\d|gemini.*(pro|ultra)|deepseek-r|grok/, 3, "mid family"],
];
export function defaultTier(m: string): { tier: number; rule: string } {
  for (const [re, tier, rule] of FAMILY_TIERS) if (re.test(m)) return { tier, rule };
  return { tier: 3, rule: "unknown family" };
}

/**
 * Thinking level (Chris, Sep 10): frontier models run at several reasoning efforts, and only the highest count as tier 1.
 * The level comes from the X-Effort header or a marker in the id: "gpt-6-astra-high", "claude-fable-5-1 (effort: max)",
 * "[thinking: xhigh]", ":low". Recognised: none | minimal | low | medium | high | xhigh | max. Undeclared is null.
 */
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: Effort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export const TOP_EFFORTS: ReadonlySet<Effort> = new Set(["high", "xhigh", "max"]);
export function parseEffort(raw: unknown): Effort | null {
  const s = String(raw ?? "").trim().toLowerCase().slice(0, 200);
  if (!s) return null;
  const alias: Record<string, Effort> = { maximum: "max", extended: "max", "extra-high": "xhigh", extrahigh: "xhigh", x_high: "xhigh", off: "none", ultra: "max", deep: "max" };
  const direct = alias[s] ?? (EFFORTS as string[]).includes(s) ? (alias[s] ?? (s as Effort)) : null;
  if (direct) return direct;
  const m = /(?:effort|thinking|reasoning)\s*[:=]?\s*([a-z_-]+)/.exec(s) ?? /[\[(:\-\s](none|minimal|low|medium|high|xhigh|max|maximum|extended)\s*[\])]?$/.exec(s);
  if (!m) return null;
  const v = alias[m[1]] ?? m[1];
  return (EFFORTS as string[]).includes(v) ? (v as Effort) : null;
}
/** Tier 1 needs a top thinking level. A frontier model with a lower or undeclared level judges at tier 2; nothing else changes. */
export function tierForEffort(tier: number, effort: Effort | null): { tier: number; note: string | null } {
  if (tier !== 1) return { tier, note: null };
  if (effort && TOP_EFFORTS.has(effort)) return { tier: 1, note: null };
  return { tier: 2, note: effort ? `thinking level "${effort}" declared: tier 2 for this session (tier 1 needs high, xhigh or max)` : "no thinking level declared: tier 2 for this session (send X-Effort: max, or the level in X-Model such as \"gpt-6-astra-high\"; tier 1 needs high, xhigh or max)" };
}
