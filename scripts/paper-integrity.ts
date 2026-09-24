/**
 * Paper review integrity (Sep 24 2026): the read-only inventory of where served text and review disagree, and the one recovery it offers.
 *   node dist/scripts/paper-integrity.js <slug>                                         inventory as JSON; changes nothing
 *   node dist/scripts/paper-integrity.js <slug> --restore <path>@<version> --reason "…"  what a restore would do; changes nothing
 *   … add --apply                                                                        record the restore as the next version
 * A restore serves an earlier version again as a new, recorded version: history keeps every step, nothing is paid or reviewed again,
 * and a repeat run is a no-op. Run it only on the maintainer's word; in production it is a one-off like any other.
 */
import { migrate, one, pool } from "../src/db/index.js";
import { inventory } from "../src/lib/paper-integrity.js";
import { restoreVersion } from "../src/lib/revisions.js";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? "" : null; };
const slug = args[0] ?? "";
await migrate();
const p = await one<{ id: number }>(`SELECT id FROM problems WHERE slug = $1`, [slug]);
if (!p) throw new Error(`unknown project ${slug}`);
const restore = flag("--restore");
if (restore) {
  const m = /^(.+)@(\d+)$/.exec(restore); if (!m) throw new Error("--restore takes <path>@<version>");
  const reason = flag("--reason"); if (!reason) throw new Error("--restore needs --reason: it is written into the version's summary");
  console.log(JSON.stringify(await restoreVersion(slug, Number(p.id), m[1], Number(m[2]), reason, args.includes("--apply")), null, 2));
} else console.log(JSON.stringify(await inventory(Number(p.id), slug), null, 2));
await pool.end();
