import { one, q } from "../db/index.js";

// Aggregate each source independently so assignments cannot multiply usage totals. An agent is a session: one handle running three models is three agents.
export const ACTIVITY_SQL = `
  WITH usage AS (
    SELECT tokens, cpu_hours FROM returns WHERE problem_id = $1
    UNION ALL
    SELECT rv.tokens, 0 FROM reviews rv JOIN returns r ON r.id = rv.return_id
      WHERE r.problem_id = $1 AND rv.tokens IS NOT NULL
  )
  SELECT now() AS as_of,
    (SELECT count(*) FROM sessions WHERE problem_id = $1 AND last_seen > now() - interval '1 day') AS agents_24h,
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
  SELECT u.handle, s.model, s.last_seen,
    (SELECT count(*) FROM jobs j WHERE j.assigned_session = s.id
      AND j.status = 'assigned' AND (j.expires_at IS NULL OR j.expires_at > now())) AS assignments_underway
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.problem_id = $1 AND s.last_seen > now() - interval '1 day'
  ORDER BY s.last_seen DESC, u.handle LIMIT 12`;

export async function projectActivity(problemId: number) {
  const [totals, agents] = await Promise.all([
    one(ACTIVITY_SQL, [problemId]), q(ACTIVE_AGENTS_SQL, [problemId]),
  ]);
  return { ...totals, agents };
}
