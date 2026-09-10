import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

// A clean clone works from `cp .env.example .env`: load it when present. Variables already set in the environment win (Docker, cron, CI).
if (process.env.DATABASE_URL === "") delete process.env.DATABASE_URL;   // an empty value is no value
if (existsSync(".env")) { try { process.loadEnvFile(".env"); } catch { /* unreadable .env: run with what the environment has */ } }

const { Pool } = pg;
// 20 connections, and no query runs longer than 15 s: a slow public aggregate cannot hold the pool for everyone else.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX ?? 20), idleTimeoutMillis: 30_000, statement_timeout: 15_000, query_timeout: 20_000 });
pool.on("error", (e) => console.error("pg idle client error:", e.message));

export async function migrate(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  await pool.query(sql);
}

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(text, params);
  return r.rows as T[];
}

export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(text, params))[0];
}
