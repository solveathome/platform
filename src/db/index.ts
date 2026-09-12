import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

// A clean clone works from `cp .env.example .env`: load it when present. Variables already set in the environment win (Docker, cron, CI).
if (process.env.DATABASE_URL === "") delete process.env.DATABASE_URL;   // an empty value is no value
if (existsSync(".env")) { try { process.loadEnvFile(".env"); } catch { /* unreadable .env: run with what the environment has */ } }

const { Pool } = pg;
// 20 connections, and no query runs longer than 15 s: a slow public aggregate cannot hold the pool for everyone else.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX ?? 20), idleTimeoutMillis: 30_000, statement_timeout: 15_000, query_timeout: 20_000 });
pool.on("error", (e) => console.error("pg idle client error:", e.message));

const transactions = new AsyncLocalStorage<pg.PoolClient>();
export function inTransaction(): boolean { return !!transactions.getStore(); }
/** All q/one calls, including credit and follow-up helpers, share the caller's transaction. */
export async function transaction<T>(work: () => Promise<T>): Promise<T> {
  if (inTransaction()) return work();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await transactions.run(client, work);
    await client.query("COMMIT");
    // Publication must follow the DB commit. A crash leaves a durable action to replay.
    try { await flushFileEffects(client); } catch (error) { console.error("pending publication will retry:", error); }
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export function projectTransaction<T>(problemId: number | string, work: () => Promise<T>): Promise<T> {
  return transaction(async () => {
    await q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`assignments:${problemId}`]);
    return work();
  });
}

export async function queueFileEffect(path: string, content: string | null): Promise<void> {
  await q(`INSERT INTO pending_file_effects (path, content) VALUES ($1,$2)`, [path, content]);
  if (!inTransaction()) await flushFileEffects();
}
export async function pendingFileText(path: string): Promise<{ content: string | null } | undefined> {
  return one(`SELECT content FROM pending_file_effects WHERE path = $1 ORDER BY id DESC LIMIT 1`, [path]);
}
/** Inert file writes/deletions only; no submitted code is executed. Replay is idempotent and ordered. */
export async function flushFileEffects(existingClient?: pg.PoolClient): Promise<void> {
  const client = existingClient ?? await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('publication-files', 0))`);
    const { rows } = await client.query(`SELECT id, path, content FROM pending_file_effects ORDER BY id FOR UPDATE`);
    for (const row of rows) {
      if (row.content === null) { if (existsSync(row.path)) unlinkSync(row.path); }
      else {
        mkdirSync(dirname(row.path), { recursive: true });
        const tmp = `${row.path}.pending-${randomBytes(6).toString("hex")}`;
        writeFileSync(tmp, row.content); renameSync(tmp, row.path);
      }
      await client.query(`DELETE FROM pending_file_effects WHERE id = $1`, [row.id]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { if (!existingClient) client.release(); }
}

export async function migrate(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  await pool.query(sql);
}

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await (transactions.getStore() ?? pool).query(text, params);
  return r.rows as T[];
}

export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(text, params))[0];
}
