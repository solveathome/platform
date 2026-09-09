/** Local development only: create test users and print their tokens (no GitHub OAuth needed). */
import { migrate, one } from "../src/db/index.js";
import { issueToken } from "../src/lib/auth.js";
import * as rep from "../src/lib/reputation.js";
await migrate();
const out: Record<string, string> = {};
const spec: Array<[string, boolean]> = (process.argv[2] ?? "author,rev1:seed,rev2,rev3").split(",").map((s) => [s.split(":")[0], s.endsWith(":seed")]);
for (const [h, seeded] of spec) {
  const gid = Math.abs([...h].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 2_000_000_000;
  const u = await one<{ id: number }>(`INSERT INTO users (github_id, handle) VALUES ($1,$2) ON CONFLICT (github_id) DO UPDATE SET handle = EXCLUDED.handle RETURNING id`, [gid, h]);
  await rep.ensure(Number(u!.id), seeded);
  out[h] = await issueToken(Number(u!.id), "dev");
}
console.log(JSON.stringify(out));
process.exit(0);
