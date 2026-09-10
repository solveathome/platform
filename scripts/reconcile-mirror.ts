/**
 * After a mirror cut: record what the cut did to documents the swarm has history on (see recordMirrorCut in src/lib/revisions.ts).
 * Run on the server, after rsync: node dist/scripts/reconcile-mirror.js [slug] [note]
 */
import { migrate, one, pool } from "../src/db/index.js";
import { featuredProject } from "../src/lib/projects.js";
import { recordMirrorCut } from "../src/lib/revisions.js";

const slug = process.argv[2] ?? (await featuredProject())?.slug ?? "";
const note = process.argv[3] ?? "";
await migrate();
const p = await one<{ id: number }>(`SELECT id FROM problems WHERE slug = $1`, [slug]);
if (!p) throw new Error(`unknown project ${slug}`);
const result = await recordMirrorCut(slug, Number(p.id), note);
for (const r of result) console.log(`${r.action.padEnd(10)} ${r.path}${r.version ? ` (version ${r.version})` : ""}`);
console.log(`${result.length} document(s) with history checked: ${result.filter((r) => r.action === "recorded").length} recorded, ${result.filter((r) => r.action === "caught-up").length} caught up`);
await pool.end();
