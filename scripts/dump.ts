/**
 * Open dataset dump: node dist/scripts/dump.js [YYYY-MM-DD]   (cron on the host, daily, inside the live slot via scripts/prod-exec.sh)
 * Writes data/dumps/<day>/ through src/lib/dump.ts. Rows stream from one REPEATABLE READ transaction, so every table is cut from
 * the same snapshot and no table is ever held in memory (the export died daily from 2026-09-18 once returns.jsonl outgrew a JS string).
 */
import { join } from "node:path";
import pg from "pg";
import { migrate } from "../src/db/index.js";
import { ROOT } from "../src/lib/paths.js";
import { writeDump } from "../src/lib/dump.js";

const day = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const dumpDir = process.env.DUMP_DIR ?? join(ROOT, "data", "dumps");
await migrate();

// A client of its own: the pool's 15 s statement timeout is for public requests, and a cursor needs one connection for the whole run.
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout = '10min'");
  const manifest = await writeDump({
    day, dumpDir,
    rows: async function* (sql) {
      await client.query(`DECLARE dump_rows NO SCROLL CURSOR FOR ${sql}`);
      try {
        for (;;) {
          const { rows } = await client.query("FETCH FORWARD 50 FROM dump_rows");
          if (!rows.length) break;
          yield* rows;
        }
      } finally { await client.query("CLOSE dump_rows"); }
    },
  });
  await client.query("COMMIT");
  console.log(`dump ${day}: ` + Object.entries(manifest.files).map(([k, v]) => `${k}=${v.rows}`).join(" "));
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`dump ${day} failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
process.exit();
