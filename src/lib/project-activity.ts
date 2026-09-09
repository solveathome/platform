import { one, q } from "../db/index.js";

// Aggregate each source independently so assignments cannot multiply usage totals.
export const ACTIVITY_SQL = `
  WITH usage AS (
    SELECT tokens, cpu_hours FROM returns WHERE problem_id = $1
    UNION ALL
    SELECT note::jsonb, 0 FROM credits
      WHERE problem_id = $1 AND kind = 'tokens' AND source_type = 'review'
  )
  SELECT now() AS as_of,
    (SELECT count(*) FROM pool WHERE problem_id = $1 AND last_seen > now() - interval '1 day') AS agents_24h,
    (SELECT count(*) FROM pool WHERE problem_id = $1) AS contributors,
    (SELECT count(*) FROM jobs WHERE problem_id = $1 AND status = 'assigned'
      AND (expires_at IS NULL OR expires_at > now())) AS assignments_underway,
    (SELECT count(*) FROM jobs WHERE problem_id = $1 AND status = 'queued') AS assignments_queued,
    (SELECT count(*) FROM returns WHERE problem_id = $1) AS results_submitted,
    (SELECT count(*) FROM reviews rv JOIN returns r ON r.id = rv.return_id WHERE r.problem_id = $1) AS reviews_completed,
    (SELECT count(*) FROM messages m JOIN channels c ON c.id = m.channel_id
      WHERE c.problem_id = $1 AND m.created_at > now() - interval '1 day') AS messages_24h,
    (SELECT coalesce(sum(coalesce((tokens->>'input')::numeric, 0)
      + coalesce((tokens->>'output')::numeric, 0)
      + coalesce((tokens->>'cache_read')::numeric, 0)
      + coalesce((tokens->>'cache_write')::numeric, 0)), 0) FROM usage) AS tokens_contributed,
    (SELECT coalesce(sum(cpu_hours), 0) FROM usage) AS cpu_hours`;

export const ACTIVE_AGENTS_SQL = `
  SELECT u.handle, p.model, p.last_seen,
    (SELECT count(*) FROM jobs j WHERE j.problem_id = p.problem_id AND j.assigned_to = p.user_id
      AND j.status = 'assigned' AND (j.expires_at IS NULL OR j.expires_at > now())) AS assignments_underway
  FROM pool p JOIN users u ON u.id = p.user_id
  WHERE p.problem_id = $1 AND p.last_seen > now() - interval '1 day'
  ORDER BY p.last_seen DESC, u.handle LIMIT 12`;

export async function projectActivity(problemId: number) {
  const [totals, agents] = await Promise.all([
    one(ACTIVITY_SQL, [problemId]), q(ACTIVE_AGENTS_SQL, [problemId]),
  ]);
  return { ...totals, agents };
}
