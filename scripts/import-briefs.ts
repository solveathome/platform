/**
 * Import job briefs from a directory of markdown files with a small front matter block:
 *
 * ---
 * type: break | formalize | measure | source | explore
 * title: ...
 * lane: g2-exponent
 * git_ref: main
 * budget_hours: 2
 * min_tier: 99
 * quorum: 1
 * compute_hint: {"cpu_hours": 0.5, "ram_gb": 4, "mathlib_cache": false}
 * ---
 * <brief body>
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate, q, one } from "../src/db/index.js";
import { matchingMetadata } from "../src/lib/agent-profile.js";

import { projectDir, featuredProject } from "../src/lib/projects.js";
await migrate();
// Usage: import-briefs [slug] [dir]; the default dir is projects/<slug>/briefs, the default slug the featured project.
const slug = process.argv[2] ?? (await featuredProject())?.slug;
if (!slug) throw new Error("no project: run seed first, or give a slug");
const dir = process.argv[3] ?? join(projectDir(slug) ?? "", "briefs");
const p = await one<{ id: number }>(`SELECT id FROM problems WHERE slug = $1`, [slug]);
if (!p) throw new Error(`unknown project ${slug}: run seed first`);
let n = 0, updated = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
  const src = readFileSync(join(dir, f), "utf8");
  const m = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) { console.warn("skip (no front matter):", f); continue; }
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  const match = matchingMetadata(meta);
  const matchingValues = [match.purpose, match.priority, match.preferred_skills, match.required_tools, match.required_sources];
  const lane = meta.lane ? await one<{ id: number }>(`SELECT id FROM lanes WHERE slug = $1 AND problem_id = $2`, [meta.lane, p.id]) : null;
  const exists = await one<{ id: number; status: string }>(`SELECT id, status FROM jobs WHERE problem_id = $1 AND title = $2`, [p.id, meta.title]);
  if (exists) {
    // Refresh the text of a brief nobody has taken yet; assigned or finished jobs keep the brief their agent read.
    if (exists.status === "queued") { await q(`UPDATE jobs SET brief_md = $2, budget_hours = $3, compute_hint = $4,
      purpose = $5, priority = $6, preferred_skills = $7, required_tools = $8, required_sources = $9 WHERE id = $1`,
      [exists.id, m[2].trim(), Number(meta.budget_hours ?? 2), meta.compute_hint ? JSON.parse(meta.compute_hint) : {}, ...matchingValues]); updated++; }
    continue;
  }
  await q(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, purpose, priority, preferred_skills, required_tools, required_sources)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [p.id, lane?.id ?? null, meta.type, meta.title, m[2].trim(), meta.git_ref ?? "main",
     meta.compute_hint ? JSON.parse(meta.compute_hint) : {}, Number(meta.budget_hours ?? 2), Number(meta.min_tier ?? 99), Number(meta.quorum ?? 1), ...matchingValues]);
  n++;
}
console.log(`imported ${n} new briefs, refreshed ${updated} queued briefs from ${dir}`);
process.exit(0);
