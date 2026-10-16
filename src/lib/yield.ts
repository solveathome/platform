/**
 * Yield per model per million tokens (Chris, Oct 16 2026): accepted results by rung, per model family and per
 * model, against the tokens their authors spent. Every number comes from this query over the returns table; nothing here is written by an agent.
 * The denominator is the tokens of the returns that carry usage (counted from a log or reported by the agent), and the yield's numerator is the
 * accepted results among those same returns, so a return without usage moves neither side. Review and triage tokens are not counted.
 */
import { LADDER } from "./rungs.js";

/** usageStatus in src/lib/tokens.ts, as SQL over a tokens JSONB column. tests/model-yield-db.test.mjs keeps the two in step. */
export const USAGE_STATUS_SQL = (col: string) => `CASE
    WHEN ${col} IS NULL THEN 'missing'
    WHEN coalesce((${col}->>'input')::numeric, 0) + coalesce((${col}->>'output')::numeric, 0) + coalesce((${col}->>'cache_read')::numeric, 0) + coalesce((${col}->>'cache_write')::numeric, 0) > 0 OR ${col} ? 'already_counted'
      THEN CASE WHEN ${col}->>'source' = 'reported' THEN 'reported' ELSE 'counted' END
    WHEN ${col}->>'log' = 'mcp-observed' OR coalesce(${col}->>'unmeasured', '') <> '' THEN 'unmeasured'
    ELSE 'missing' END`;

const TOTAL = (col: string) => `coalesce((${col}->>'input')::numeric, 0) + coalesce((${col}->>'output')::numeric, 0) + coalesce((${col}->>'cache_read')::numeric, 0) + coalesce((${col}->>'cache_write')::numeric, 0)`;
const USED = `u.usage IN ('counted','reported')`;

/**
 * $1 = problem id. One row per (family, model), one per family (model null) and one for the project (family null), by GROUPING SETS.
 * A model with no known lineage is family 'other' (lean_model_family names the provider lineages; a chat label or "auto" names none).
 */
export const YIELD_SQL = `
  WITH u AS (
    SELECT r.status, r.final_rung, coalesce(lean_model_family(r.model), 'other') AS family, canon_model(r.model) AS model,
           ${USAGE_STATUS_SQL("r.tokens")} AS usage, ${TOTAL("r.tokens")} AS total, coalesce((r.tokens->>'cache_read')::numeric, 0) AS cache_read
      FROM returns r WHERE r.problem_id = $1)
  SELECT family, model, grouping(family) = 1 AS project_total,
         count(*)::int AS returns,
         count(*) FILTER (WHERE ${USED})::int AS with_usage,
         count(*) FILTER (WHERE u.usage = 'counted')::int AS counted,
         count(*) FILTER (WHERE u.usage = 'reported')::int AS reported,
         count(*) FILTER (WHERE u.usage = 'unmeasured')::int AS unmeasured,
         count(*) FILTER (WHERE u.usage = 'missing')::int AS missing,
         coalesce(sum(u.total) FILTER (WHERE ${USED}), 0)::float8 AS tokens,
         coalesce(sum(u.cache_read) FILTER (WHERE ${USED}), 0)::float8 AS cache_read,
         count(*) FILTER (WHERE u.status = 'accepted')::int AS accepted,
         count(*) FILTER (WHERE u.status = 'accepted' AND ${USED})::int AS accepted_with_usage,
         ${LADDER.map((g) => `count(*) FILTER (WHERE u.status = 'accepted' AND u.final_rung = '${g}')::int AS "${g}", count(*) FILTER (WHERE u.status = 'accepted' AND u.final_rung = '${g}' AND ${USED})::int AS "${g}_with_usage"`).join(",\n         ")}
    FROM u
   GROUP BY GROUPING SETS ((family, model), (family), ())
   ORDER BY grouping(family) DESC, family, grouping(model) DESC, count(*) DESC, model`;

export type YieldRow = { family: string | null; model: string | null; project_total: boolean; returns: number; with_usage: number; counted: number; reported: number; unmeasured: number; missing: number; tokens: number; cache_read: number; accepted: number; accepted_with_usage: number } & Record<string, number | string | boolean | null>;

/** Accepted results per million tokens; null when the row has no measured tokens. */
export const perMillion = (accepted: number, tokens: number): number | null => tokens > 0 ? accepted / (tokens / 1e6) : null;
/** Where the data is too thin to read a rate from (fewer than 20 returns with usage, or fewer than 5 accepted among them). */
export const THIN = { returns: 20, accepted: 5 };
export const isThin = (r: Pick<YieldRow, "with_usage" | "accepted_with_usage">): boolean => r.with_usage < THIN.returns || r.accepted_with_usage < THIN.accepted;
