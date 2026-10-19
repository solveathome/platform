/**
 * Retract or restore a paper from the host, the same write as POST /projects/:slug/papers/:paper/retract|restore
 * (src/lib/paper-retraction.ts), for the maintainer acting without an agent token. --as names the person recorded on the event,
 * who must be an owner or a reviewer trusted by grant on the project.
 * Run: node dist/scripts/retract-paper.js <project> <paper> --as <handle> [--restore] "<public reason>"
 */
import { migrate, one, pool } from "../src/db/index.js";
import { isGrantedTrusted } from "../src/lib/roles.js";
import { retractPaper, restorePaper } from "../src/lib/paper-retraction.js";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const restore = args.includes("--restore"); if (restore) args.splice(args.indexOf("--restore"), 1);
const as = flag("--as");
const [project, paper, reason] = args;
if (!project || !paper || !reason || !as) { console.error('usage: retract-paper <project> <paper> --as <handle> [--restore] "<public reason>"'); process.exit(2); }
await migrate();
const p = await one<{ id: number }>(`SELECT id FROM problems WHERE slug = $1`, [project]);
if (!p) throw new Error(`unknown project ${project}`);
const u = await one<{ id: number; handle: string }>(`SELECT id, handle FROM users WHERE lower(handle) = lower($1)`, [as]);
if (!u || !(await isGrantedTrusted(Number(p.id), Number(u.id), u.handle))) throw new Error(`@${as} is not an owner or a reviewer trusted by grant on ${project}`);
console.log(JSON.stringify(await (restore ? restorePaper : retractPaper)(Number(p.id), paper, Number(u.id), reason)));
await pool.end();
