/** Seed every project under projects/, the model tier table and the seeded reviewers' reputation. Idempotent. */
import { migrate, q, one } from "../src/db/index.js";
import * as reputation from "../src/lib/reputation.js";
import { ensureChannels } from "../src/routes/chat.js";

await migrate();

// Every project directory (projects/<slug>/project.json) becomes a problem, with its lanes and channels (Q71).
import { listProjectConfigs } from "../src/lib/projects.js";
const configs = listProjectConfigs();
if (!configs.length) console.warn("no projects/<slug>/project.json found; seeding tiers only");
for (const c of configs) {
  await q(`INSERT INTO problems (slug, name, repo_url, status_md, summary, featured) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, repo_url = EXCLUDED.repo_url, featured = EXCLUDED.featured, summary = COALESCE(NULLIF(problems.summary, ''), EXCLUDED.summary)`,
    [c.slug, c.name, c.repo_url, c.status_md ?? "", c.summary ?? "", c.featured === true]);
}

// Model capability tiers (scope Q7, Q13). Tier 1 may review and consolidate. Revised from platform data.
const tiers: Array<[string, string, number, string]> = [
  ["gpt-6-astra", "openai", 1, "top tier at launch (Q13)"],
  ["claude-fable-5-1", "anthropic", 1, "top tier at launch (Q13)"],
  ["claude-opus-5", "anthropic", 2, ""],
  ["claude-sonnet-5", "anthropic", 3, ""],
  ["claude-haiku-4-5", "anthropic", 4, ""],
];
for (const [model, provider, tier, note] of tiers)
  await q(`INSERT INTO model_tiers (model, provider, tier, note) VALUES ($1,$2,$3,$4)
           ON CONFLICT (model) DO UPDATE SET provider = EXCLUDED.provider, tier = EXCLUDED.tier, note = EXCLUDED.note, updated_at = now()`, [model, provider, tier, note]);

// Lanes come from each project's config (scope Q19). Titles only; briefs come from import-briefs.
for (const c of configs) {
  const p = await one<{ id: number }>(`SELECT id FROM problems WHERE slug = $1`, [c.slug]);
  for (const l of c.lanes ?? [])
    await q(`INSERT INTO lanes (problem_id, slug, title, variant) VALUES ($1,$2,$3,$4) ON CONFLICT (problem_id, slug) DO NOTHING`, [p!.id, l.slug, l.title, l.variant ?? ""]);
  await ensureChannels(p!.id);
  const handle = c.researcher ?? process.env.SEED_RESEARCHER;
  const researcher = handle ? await one<{ id: number }>(`SELECT id FROM users WHERE lower(handle) = lower($1)`, [handle]) : null;
  if (researcher) await q(`UPDATE problems SET researcher_user_id = $2 WHERE id = $1`, [p!.id, researcher.id]);
  // Owners (the researcher and OWNER_HANDLES) hold the owner role on the project: trusted, and the ones who grant trust.
  for (const h of [handle, ...(process.env.OWNER_HANDLES ?? "").split(",")].map((s) => (s ?? "").trim()).filter(Boolean)) {
    const u = await one<{ id: number }>(`SELECT id FROM users WHERE lower(handle) = lower($1)`, [h]);
    if (u) await q(`INSERT INTO project_roles (problem_id, user_id, role, note) VALUES ($1,$2,'owner','project owner') ON CONFLICT (problem_id, user_id) DO UPDATE SET role = 'owner', revoked_at = NULL, revoke_note = NULL`, [p!.id, u.id]);
  }
}

// Seeded reviewers get high reputation once they exist (they sign in via GitHub first).
for (const h of (process.env.SEED_REVIEWERS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
  const u = await one<{ id: number }>(`SELECT id FROM users WHERE lower(handle) = lower($1)`, [h]);
  if (u) await reputation.ensure(Number(u.id), true);
}
console.log("seeded");
process.exit(0);
