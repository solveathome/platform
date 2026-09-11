import { one, q } from "../db/index.js";

const CURRENT_ASSIGNMENT = `j.status = 'assigned' AND (j.expires_at IS NULL OR j.expires_at > now())`;
const LIVE_SESSION = `s.problem_id = j.problem_id AND s.user_id = j.assigned_to
  AND s.ended_at IS NULL AND s.last_seen > now() - interval '1 hour'`;

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
    (SELECT count(*) FROM sessions WHERE problem_id = $1) AS agents_total,   -- every agent session ever opened on the project (Chris, Sep 11: the headline is all-time, the day is the subtext)
    (SELECT count(*) FROM pool WHERE problem_id = $1) AS contributors,
    -- Underway means a live agent holds it (its session was seen in the last hour). A job whose agent went quiet (killed, crashed)
    -- is abandoned until the expiry clock returns it to the queue; it is counted apart (Chris, Sep 11).
    (SELECT count(*) FROM jobs j LEFT JOIN sessions s ON s.id = j.assigned_session
      WHERE j.problem_id = $1 AND ${CURRENT_ASSIGNMENT} AND (${LIVE_SESSION})) AS assignments_underway,
    (SELECT count(*) FROM jobs j LEFT JOIN sessions s ON s.id = j.assigned_session
      WHERE j.problem_id = $1 AND ${CURRENT_ASSIGNMENT} AND NOT coalesce((${LIVE_SESSION}), false)) AS assignments_abandoned,
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
      AND ${CURRENT_ASSIGNMENT} AND (${LIVE_SESSION})) AS assignments_underway
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.problem_id = $1 AND s.last_seen > now() - interval '1 day'
  ORDER BY s.last_seen DESC, u.handle LIMIT 12`;

// Public job and agent details only: a session id is a credential and must never be returned.
// Counts and rows share one snapshot, including when there is no work or the display limit is reached.
export const RUNNING_WORK_SQL = `
  WITH running AS (
    SELECT j.id, j.type, j.title, j.assigned_at, u.handle, s.model, s.effort, s.last_seen
    FROM jobs j JOIN sessions s ON s.id = j.assigned_session JOIN users u ON u.id = s.user_id
    WHERE j.problem_id = $1 AND ${CURRENT_ASSIGNMENT} AND (${LIVE_SESSION})
  )
  SELECT now() AS as_of, (SELECT count(*) FROM running) AS total,
    coalesce((SELECT json_agg(shown) FROM (
      SELECT * FROM running ORDER BY last_seen DESC, assigned_at DESC NULLS LAST, id DESC LIMIT 100
    ) shown), '[]'::json) AS jobs`;

export const runningWork = (problemId: number) => one(RUNNING_WORK_SQL, [problemId]);

export async function projectActivity(problemId: number) {
  const [totals, agents, running] = await Promise.all([
    one(ACTIVITY_SQL, [problemId]), q(ACTIVE_AGENTS_SQL, [problemId]), runningWork(problemId),
  ]);
  return { ...totals, agents, running };
}
