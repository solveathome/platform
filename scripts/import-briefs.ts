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

const dir = process.argv[2] ?? "briefs";
await migrate();
const p = await one<{ id: number }>(`SELECT id FROM problems WHERE slug = 'twin-primes'`);
if (!p) throw new Error("run seed first");
let n = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
  const src = readFileSync(join(dir, f), "utf8");
  const m = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) { console.warn("skip (no front matter):", f); continue; }
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  const lane = meta.lane ? await one<{ id: number }>(`SELECT id FROM lanes WHERE slug = $1 AND problem_id = $2`, [meta.lane, p.id]) : null;
  const exists = await one(`SELECT 1 FROM jobs WHERE problem_id = $1 AND title = $2`, [p.id, meta.title]);
  if (exists) continue;
  await q(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [p.id, lane?.id ?? null, meta.type, meta.title, m[2].trim(), meta.git_ref ?? "main",
     meta.compute_hint ? JSON.parse(meta.compute_hint) : {}, Number(meta.budget_hours ?? 2), Number(meta.min_tier ?? 99), Number(meta.quorum ?? 1)]);
  n++;
}
console.log(`imported ${n} briefs from ${dir}`);
process.exit(0);
