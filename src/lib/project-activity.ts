import { one, q } from "../db/index.js";
import { JOB_LABEL_SQL } from "./research-format.js";
import { JOB_CONTEXT_COLUMNS, JOB_CONTEXT_JOINS, jobPresentation } from "./job-presentation.js";

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
  SELECT u.handle, s.department_id,s.run_id,s.model, s.last_seen,
    (SELECT count(*) FROM jobs j WHERE j.assigned_session = s.id
      AND ${CURRENT_ASSIGNMENT} AND (${LIVE_SESSION})) AS assignments_underway
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.problem_id = $1 AND s.last_seen > now() - interval '1 day'
  ORDER BY s.last_seen DESC, u.handle LIMIT 12`;

// Keep every live assignment, then fill a quiet log with the most recently started distinct jobs.
// Attempts retain the actual last agent even after release clears the job's current ownership.
// Private attempt/session IDs never enter the selected public fields.
export const RUNNING_WORK_SQL = `
  WITH running AS (
    SELECT j.id, j.assigned_at, u.handle, s.department_id, s.run_id, s.model, s.effort, s.last_seen,
      true AS live, 'active'::text AS activity_status, NULL::timestamptz AS ended_at
    FROM jobs j JOIN sessions s ON s.id = j.assigned_session JOIN users u ON u.id = s.user_id
    WHERE j.problem_id = $1 AND ${CURRENT_ASSIGNMENT} AND (${LIVE_SESSION})
  ), latest_attempt AS (
    SELECT DISTINCT ON (a.job_id) a.job_id, a.problem_id, a.session_id, a.user_id, a.model,
      a.department_id, a.run_id, a.started_at, a.ended_at, a.status
    FROM assignment_attempts a WHERE a.problem_id = $1 AND (SELECT count(*) FROM running) < 5
    ORDER BY a.job_id, a.started_at DESC, a.id DESC
  ), past AS (
    SELECT j.id, a.started_at AS assigned_at, u.handle, a.department_id, a.run_id, a.model, s.effort, s.last_seen,
      false AS live, CASE WHEN a.status = 'assigned' THEN 'inactive' ELSE a.status END AS activity_status, a.ended_at
    FROM latest_attempt a JOIN jobs j ON j.id = a.job_id AND j.problem_id = a.problem_id JOIN users u ON u.id = a.user_id
    LEFT JOIN sessions s ON s.id = a.session_id AND s.problem_id = a.problem_id AND s.user_id = a.user_id
    WHERE NOT EXISTS (SELECT 1 FROM running r WHERE r.id = j.id)
    UNION ALL
    SELECT j.id, j.assigned_at, u.handle, s.department_id, s.run_id, s.model, s.effort, s.last_seen,
      false AS live, CASE WHEN j.status = 'returned' THEN 'completed' ELSE 'inactive' END AS activity_status, NULL::timestamptz AS ended_at
    FROM jobs j JOIN users u ON u.id = j.assigned_to
    LEFT JOIN sessions s ON s.id = j.assigned_session AND s.problem_id = j.problem_id AND s.user_id = j.assigned_to
    WHERE j.problem_id = $1 AND j.assigned_at IS NOT NULL AND (SELECT count(*) FROM running) < 5
      AND NOT EXISTS (SELECT 1 FROM latest_attempt a WHERE a.job_id = j.id)
      AND NOT EXISTS (SELECT 1 FROM running r WHERE r.id = j.id)
  ), recent AS (
    SELECT * FROM past ORDER BY assigned_at DESC, id DESC LIMIT greatest(0, 5 - (SELECT count(*) FROM running))
  ), selected AS (
    SELECT * FROM running UNION ALL SELECT * FROM recent
  ), shown AS (
    SELECT selected.*, j.type, ${JOB_LABEL_SQL} AS label, j.title, j.research_stage, j.follow_up_of, j.step_check_of, j.requires_trust,
      ${JOB_CONTEXT_COLUMNS}
    FROM selected JOIN jobs j ON j.id = selected.id AND j.problem_id = $1 ${JOB_CONTEXT_JOINS}
  )
  SELECT now() AS as_of, (SELECT count(*) FROM running) AS total,
    (SELECT count(*) FROM recent) AS recent_total,
    coalesce((SELECT json_agg(shown ORDER BY live DESC, CASE WHEN live THEN last_seen END DESC, assigned_at DESC NULLS LAST, id DESC) FROM shown), '[]'::json) AS jobs`;

export async function runningWork(problemId: number) {
  const work = await one(RUNNING_WORK_SQL, [problemId]);
  if (!work) return work;
  return { ...work, jobs: work.jobs.map((row: any) => {
    const { source_title, source_report_md, summary_brief_md, subject_return_id, research_stage, follow_up_of, step_check_of, requires_trust, ...pub } = row;
    return { ...pub, presentation: jobPresentation(row) };
  }) };
}

export async function projectActivity(problemId: number) {
  const [totals, agents, running] = await Promise.all([
    one(ACTIVITY_SQL, [problemId]), q(ACTIVE_AGENTS_SQL, [problemId]), runningWork(problemId),
  ]);
  return { ...totals, agents, running };
}
