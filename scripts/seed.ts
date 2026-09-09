/** Seed the first problem, the model tier table and the seeded reviewers' reputation. Idempotent. */
import { migrate, q, one } from "../src/db/index.js";
import * as reputation from "../src/lib/reputation.js";
import { ensureChannels } from "../src/routes/chat.js";

await migrate();

await q(`INSERT INTO problems (slug, name, repo_url, status_md) VALUES ($1,$2,$3,$4)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, repo_url = EXCLUDED.repo_url`,
  ["twin-primes", "Twin Prime Conjecture", "https://github.com/solveathome/twin-primes",
   "Twin-prime infinitude remains OPEN. Central object G₂(x#); proven upper bound exponent 4.26645; target exponent 2. Status is copied verbatim from the repo README at each dump."]);

// Model capability tiers (scope Q7, Q13). Tier 1 may review and consolidate. Revised from platform data.
const tiers: Array<[string, string, number, string]> = [
  ["gpt-6-astra", "openai", 1, "top tier at launch (Q13)"],
  ["claude-fable-5-1", "anthropic", 1, "top tier at launch (Q13)"],
  ["claude-opus-5", "anthropic", 2, ""],
  ["claude-sonnet-5", "anthropic", 3, ""],
  ["claude-haiku-4-5-20251001", "anthropic", 4, ""],
];
for (const [model, provider, tier, note] of tiers)
  await q(`INSERT INTO model_tiers (model, provider, tier, note) VALUES ($1,$2,$3,$4)
           ON CONFLICT (model) DO UPDATE SET provider = EXCLUDED.provider, tier = EXCLUDED.tier, note = EXCLUDED.note, updated_at = now()`, [model, provider, tier, note]);

// Launch lanes seeded from the research corpus's execution board (scope Q19). Titles only; briefs come from import-briefs.
const p = await one<{ id: number }>(`SELECT id FROM problems WHERE slug = 'twin-primes'`);
const lanes: Array<[string, string, string]> = [
  ["g2-exponent", "Lower the G₂ upper-bound exponent (4.27 toward 2)", "g2-exponent"],
  ["adversarial", "Break accepted lemmas: counterexample search against validators", "adversarial"],
  ["formalize", "Lean 4 formalization of accepted lemmas", "formalize"],
  ["measure", "Extend numbered measurement scripts to larger ranges", "measure"],
  ["infinitude", "Routes toward infinitude not in the refuted registry", "infinitude"],
  ["finiteness-structure", "What structure a finite twin count would force (disproof-shaped lane)", "finiteness"],
];
for (const [slug, title, variant] of lanes)
  await q(`INSERT INTO lanes (problem_id, slug, title, variant) VALUES ($1,$2,$3,$4) ON CONFLICT (problem_id, slug) DO NOTHING`, [p!.id, slug, title, variant]);

await ensureChannels(p!.id);
const researcher = await one<{ id: number }>(`SELECT id FROM users WHERE lower(handle) = lower($1)`, [process.env.SEED_RESEARCHER ?? "Benjaminsen"]);
if (researcher) await q(`UPDATE problems SET researcher_user_id = $2, summary = COALESCE(NULLIF(summary, ''), $3) WHERE id = $1`,
  [p!.id, researcher.id, "Are there infinitely many twin primes? A moiré/tile framework over classical sieve objects, with a proven upper bound on the two-class twin-slot gap exponent and a long registry of refuted routes."]);

// Seeded reviewers get high reputation once they exist (they sign in via GitHub first).
for (const h of (process.env.SEED_REVIEWERS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
  const u = await one<{ id: number }>(`SELECT id FROM users WHERE lower(handle) = lower($1)`, [h]);
  if (u) await reputation.ensure(Number(u.id), true);
}
console.log("seeded");
process.exit(0);
