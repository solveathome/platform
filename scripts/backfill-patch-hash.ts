/** One-off (Sep 11 2026): hash the patches of returns stored before duplicate detection existed, so an old accepted change is recognised.
 *  bash scripts/prod-exec.sh node dist/scripts/backfill-patch-hash.js */
import { q, pool } from "../src/db/index.js";
import { patchHash } from "../src/lib/duplicates.js";
const rows = await q<{ id: string; patch: string }>(`SELECT id, patch FROM returns WHERE patch IS NOT NULL AND patch_hash IS NULL`);
let n = 0;
for (const r of rows) { const h = patchHash(r.patch); if (h) { await q(`UPDATE returns SET patch_hash = $2 WHERE id = $1`, [r.id, h]); n++; } }
const twins = await q<{ a: string; b: string }>(`SELECT a.id AS a, b.id AS b FROM returns a JOIN returns b ON b.problem_id = a.problem_id AND b.patch_hash = a.patch_hash AND b.id > a.id WHERE a.patch_hash IS NOT NULL ORDER BY a.id`);
console.log(`backfill-patch-hash: ${n} hashed; identical pairs on the record: ${twins.map((t) => `#${t.a}=#${t.b}`).join(", ") || "none"}`);
await pool.end();
