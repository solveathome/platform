import {recordPublication} from "../src/lib/document-record.js";
/**
 * After a mirror cut: record what the cut did to documents the swarm has history on (see recordMirrorCut in src/lib/revisions.ts).
 * Run on the server, after rsync: node dist/scripts/reconcile-mirror.js [slug] [note] [--promote <path>]...
 * A cut equal to an older version of a document is stale and leaves the served version in place; --promote <path> is the owner saying
 * the repository's text of that document is meant, and records it as the next version (shown as unreviewed).
 */
import { migrate, one, pool } from "../src/db/index.js";
import { featuredProject } from "../src/lib/projects.js";
import { recordMirrorCut } from "../src/lib/revisions.js";

const args = process.argv.slice(2), promote: string[] = [], positional: string[] = [];
for (let i = 0; i < args.length; i++) { if (args[i] === "--promote") promote.push(args[++i] ?? ""); else positional.push(args[i]); }
const slug = positional[0] ?? (await featuredProject())?.slug ?? "";
const note = positional[1] ?? "";
await migrate();
const p = await one<{ id: number }>(`SELECT id FROM problems WHERE slug = $1`, [slug]);
if (!p) throw new Error(`unknown project ${slug}`);
const result = note === "--record-only" ? (await recordPublication(slug, Number(p.id)), []) : await recordMirrorCut(slug, Number(p.id), note, { promote: promote.filter(Boolean) });
for (const r of result) console.log(`${r.action.padEnd(10)} ${r.path}${r.version ? ` (version ${r.version})` : ""}${r.action === "stale" ? `: the cut is version ${r.matches}'s text; version ${r.version} stays served (--promote ${r.path} to record the cut)` : ""}`);
console.log(`${result.length} document(s) with history checked: ${result.filter((r) => r.action === "recorded").length} recorded, ${result.filter((r) => r.action === "caught-up").length} caught up, ${result.filter((r) => r.action === "stale").length} stale`);
await pool.end();
