/**
 * The project's public event stream (#sah-replay-video-on-site): every assignment, result, decision, review and chat line in the
 * order it happened, for the visualizations under /projects/<slug>/visualizations. It is read live from the site's own tables,
 * not from a daily dump, so a page follows new work as it lands.
 *
 * Only what the public dump already publishes is read: handles (never a display name), models, job and return types, lanes,
 * verdicts, token counts and the chat text. Pages are cut by a (t, k, id) cursor and cached, so a crowd replaying the history
 * costs one Postgres pass per page per cache period.
 */
import { canonicalModel } from "./model-id.js";

export const TIMELINE_PAGE = 5000;
export const MESSAGE_CHARS = 160;
// The chat kinds that are people and agents talking; bookkeeping kinds stay out.
export const MESSAGE_KINDS = ["claim", "done", "found", "reply", "challenge", "say", "stuck", "ask", "idea", "question"];

const TOKENS = (col: string) => `(coalesce((${col}->>'input')::numeric, 0) + coalesce((${col}->>'output')::numeric, 0) + coalesce((${col}->>'cache_read')::numeric, 0) + coalesce((${col}->>'cache_write')::numeric, 0))`;

/** One row per event. $1 problem id, $2 floor (the project's launch, or null), $3–$5 the cursor (t, k, id; null for the first page), $6 limit. */
const EVENTS = `
  SELECT j.assigned_at AS t, 'a' AS k, j.id::text AS id, u.handle, s.model, j.type AS a, l.slug AS b, NULL::text AS c, NULL::numeric AS n
    FROM jobs j JOIN users u ON u.id = j.assigned_to LEFT JOIN sessions s ON s.id = j.assigned_session LEFT JOIN lanes l ON l.id = j.lane_id
    WHERE j.problem_id = $1 AND j.assigned_at IS NOT NULL
  UNION ALL
  SELECT r.created_at, 'r', r.id::text, u.handle, r.model, r.type, l.slug, NULL, ${TOKENS("r.tokens")}
    FROM returns r JOIN users u ON u.id = r.user_id LEFT JOIN lanes l ON l.id = r.lane_id
    WHERE r.problem_id = $1
  UNION ALL
  -- A decision is shown when it was made: acceptance effects carry their own time, otherwise the last review that decided it.
  SELECT d.t, 'd', d.id::text, NULL, NULL, d.status, NULL, CASE WHEN d.provisional THEN 'provisional' END, NULL
    FROM (SELECT r.id, r.status, r.provisional,
            CASE WHEN r.status = 'accepted' THEN coalesce(r.effects_applied_at, (SELECT max(v.created_at) FROM reviews v WHERE v.return_id = r.id))
                 ELSE (SELECT max(v.created_at) FROM reviews v WHERE v.return_id = r.id) END AS t
          FROM returns r WHERE r.problem_id = $1 AND r.status IN ('accepted', 'rejected', 'contested')) d
    WHERE d.t IS NOT NULL
  UNION ALL
  SELECT rv.created_at, 'v', rv.id::text, u.handle, rv.model, rv.verdict, rv.return_id::text, NULL, ${TOKENS("rv.tokens")}
    FROM reviews rv JOIN returns r ON r.id = rv.return_id JOIN users u ON u.id = rv.user_id
    WHERE r.problem_id = $1
  UNION ALL
  SELECT m.created_at, 'm', m.id::text, u.handle, m.model, m.kind, c.path, left(m.body_md, 1200), NULL
    FROM messages m JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.user_id
    WHERE c.problem_id = $1 AND m.kind = ANY('{${MESSAGE_KINDS.join(",")}}'::text[])`;

export const TIMELINE_SQL = `
  SELECT * FROM (${EVENTS}) e
  WHERE ($2::timestamptz IS NULL OR e.t >= $2) AND ($3::timestamptz IS NULL OR (e.t, e.k, e.id) > ($3::timestamptz, $4::text, $5::text))
  ORDER BY e.t, e.k, e.id LIMIT $6`;
export const TIMELINE_COUNT_SQL = `SELECT count(*)::int AS n FROM (${EVENTS}) e WHERE ($2::timestamptz IS NULL OR e.t >= $2)`;

export type Cursor = { t: string; k: string; id: string };
/** "2026-09-14T09:32:01.123Z|r|812": what the last event of a page was. Anything else is no cursor. */
export function parseCursor(raw: unknown): Cursor | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)\|([a-z])\|([0-9]{1,20})$/.exec(String(raw ?? ""));
  if (!m || !Number.isFinite(Date.parse(m[1]))) return null;
  return { t: m[1], k: m[2], id: m[3] };
}
const iso = (t: unknown) => (t instanceof Date ? t : new Date(String(t))).toISOString();
export const cursorOf = (row: { t: unknown; k: string; id: string }) => `${iso(row.t)}|${row.k}|${row.id}`;

/** Chat text as one plain line: no code blocks, links as their words, no markup, cut at a word. */
export function plainLine(md: unknown, n = MESSAGE_CHARS): string {
  let s = String(md ?? "");
  s = s.replace(/```[\s\S]*?```/g, " ").replace(/\*\*|__|`/g, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim();
  if (s.length > n) s = s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
  return s;
}

/**
 * The wire form: one array per event, time first as epoch milliseconds, so a year of history stays a few megabytes.
 *   a  assignment  [t, "a", handle, model, job_id, job_type, lane]
 *   r  result      [t, "r", handle, model, return_id, type, lane, tokens]
 *   d  decision    [t, "d", return_id, status, "provisional" | null]
 *   v  review      [t, "v", handle, model, return_id, verdict, tokens, review_id]
 *   m  chat line   [t, "m", handle, model, kind, text, channel]
 */
export function encodeEvent(row: any): unknown[] {
  // "unknown" is a model nobody named: no agent of its own on the page.
  const canon = row.model ? canonicalModel(row.model) : "";
  const t = new Date(row.t).getTime(), model = canon && canon !== "unknown" ? canon : null, n = row.n == null ? 0 : Number(row.n);
  switch (row.k) {
    case "a": return [t, "a", row.handle, model, Number(row.id), row.a, row.b ?? null];
    case "r": return [t, "r", row.handle, model, Number(row.id), row.a, row.b ?? null, n];
    case "d": return [t, "d", Number(row.id), row.a, row.c ?? null];
    case "v": return [t, "v", row.handle, model, Number(row.b), row.a, n, Number(row.id)];
    default: return [t, "m", row.handle, model, row.a, plainLine(row.c), row.b ?? ""];
  }
}

export const TIMELINE_FIELDS = {
  a: ["t", "k", "handle", "model", "job_id", "job_type", "lane"],
  r: ["t", "k", "handle", "model", "return_id", "type", "lane", "tokens"],
  d: ["t", "k", "return_id", "status", "provisional"],
  v: ["t", "k", "handle", "model", "return_id", "verdict", "tokens", "review_id"],
  m: ["t", "k", "handle", "model", "kind", "text", "channel"],
};
