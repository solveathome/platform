/**
 * Model identity (Chris, Sep 9): one model is one agent on the board, however its harness spells the id.
 * Claude Code reports "claude-opus-5[1m]" for the 1M-context variant, Bedrock "us.anthropic.claude-opus-5-v1:0",
 * OpenRouter "anthropic/claude-opus-5", dated aliases "claude-haiku-4-5-20251001". All of these are the same model
 * doing the work, so every place a model id enters the system (X-Model header, transcript usage lines, seeds)
 * goes through canonicalModel(). The SQL twin, canon_model() in schema.sql, applies the same rules to stored rows.
 */
export function canonicalModel(raw: unknown): string {
  let m = String(raw ?? "").trim().toLowerCase();
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
  [/haiku|mini|nano|flash|lite|small|tiny/, 4, "small family"],
  [/fable|mythos/, 1, "frontier anthropic family"],
  [/^gpt-6|astra/, 1, "frontier openai family"],
  [/opus/, 2, "opus family"],
  [/^gpt-5|sonnet|^o\d|gemini.*(pro|ultra)|deepseek-r|grok/, 3, "mid family"],
];
export function defaultTier(m: string): { tier: number; rule: string } {
  for (const [re, tier, rule] of FAMILY_TIERS) if (re.test(m)) return { tier, rule };
  return { tier: 3, rule: "unknown family" };
}
