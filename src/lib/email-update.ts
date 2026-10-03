/**
 * The daily update (#sah-progress-emails, approved 3 Oct 2026; plan: the "solveathome progress emails" proposal).
 *
 * Chris, 3 Oct 2026: "This could become very spammy so should absolutely be limited to one email per day, with aggregate information
 * (the most existing) + stats." So:
 *  - Nothing is sent when it happens. Events become items (email_items) that wait for the person's next email.
 *  - At most one email per person per local day, across every kind: email_outbox is unique on (user, local_day) and inserting that row
 *    is the claim. Only the confirmation link a person just asked for is outside it.
 *  - An update opens with the highest-scored item, gives questions for the person their own slot, lists the rest, and ends with stats.
 *  - No news, no email: stats, pending points, small rank moves and activity never cause one. Monday's weekly edition replaces the daily
 *    update and also goes out when the agent did anything that week. The monthly letter and project news ride in that day's email, or
 *    are the day's only email.
 *  - The caveat comes first: provisional decisions are not items, and nothing is called accepted before trusted reviewers accept it.
 */
import { createHash } from "node:crypto";
import { marked } from "marked";
import { q, one } from "../db/index.js";
import { BASE_POINTS_SQL } from "./standings.js";
import { creditText } from "./display-name.js";
import { prefsOf, unsubToken, type Prefs, type UnsubAction } from "./email.js";
import { send, letterFromAddress } from "./postmark.js";
import * as tpl from "./email-template.js";

const BASE = () => (process.env.BASE_URL ?? "http://localhost:8600").replace(/\/+$/, "");
export const SEND_HOUR = 8;
const SCAN_DAYS = 8;
const LIST_MAX = 8;
/** The two thresholds the plan leaves to tuning: a rank move is news at 3 places, a reviewer queue at 3 new returns. */
export const RANK_JUMP = 3, QUEUE_JUMP = 3;

/** The lead order (plan, section 3). An ask is news but never the lead unless it is the only news: it has its own slot. */
export const SCORES = { record: 100, first: 90, breakthrough: 90, accepted: 80, cited: 70, milestone: 60, rank: 50, verdict: 40, queue: 35, ask: 0, letter: 0, project: 0 } as const;
export type Kind = keyof typeof SCORES;
export type Item = { id?: number; kind: Kind; score: number; news: boolean; problem_id: number | null; facts: any; happened_at: string | Date; dedupe_key: string };

/** Users whose events are worth queuing: a confirmed, working address, and updates not switched off. */
const EU = `eu AS (SELECT u.id, greatest(u.email_confirmed_at, now() - interval '${SCAN_DAYS} days') AS since FROM users u
  LEFT JOIN email_preferences p ON p.user_id = u.id
  WHERE u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL AND u.email_status IS NULL AND coalesce(p.updates, 'daily') <> 'off')`;
const INS = `INSERT INTO email_items (user_id, problem_id, kind, score, news, dedupe_key, facts, happened_at)`;
const TRUSTED = `d.provisional = false AND d.by IN ('trusted','challenge','reopen')`;

/** Queue every event since the last scan as an item. Idempotent: each event has one dedupe key, so a rescan adds nothing. */
export async function scan(): Promise<void> {
  // Verdicts by trusted reviewers on the person's returns: accepted, rejected, contested. Provisional (advisory) decisions are not verdicts.
  await q(`WITH ${EU} ${INS}
    SELECT r.user_id, r.problem_id, CASE WHEN d.status = 'accepted' THEN 'accepted' ELSE 'verdict' END,
      CASE WHEN d.status = 'accepted' THEN ${SCORES.accepted} + least(floor(coalesce(pts.p, 0) / 10), 19)::int ELSE ${SCORES.verdict} END, true, 'decision:' || d.id,
      jsonb_build_object('return_id', r.id, 'type', r.type, 'status', d.status, 'final_rung', d.final_rung, 'points', coalesce(pts.p, 0), 'reason', rv.reason, 'model', r.model), d.decided_at
    FROM return_decisions d JOIN returns r ON r.id = d.return_id JOIN eu ON eu.id = r.user_id
    LEFT JOIN LATERAL (SELECT sum(c.points) AS p FROM credits c WHERE c.user_id = r.user_id AND c.source_type = 'return' AND c.source_id = r.id::text AND c.kind IN ('result','breakthrough')) pts ON true
    LEFT JOIN LATERAL (SELECT reject_reason AS reason FROM reviews WHERE return_id = r.id AND reject_reason IS NOT NULL ORDER BY id DESC LIMIT 1) rv ON true
    WHERE ${TRUSTED} AND d.status IN ('accepted','rejected','contested') AND d.decided_at >= eu.since
    ON CONFLICT (dedupe_key) DO NOTHING`);
  // The person's first trusted acceptance ever (only when it falls in the window: nobody gets a "first" for an old result at launch).
  await q(`WITH ${EU}, f AS (SELECT DISTINCT ON (r.user_id) r.user_id, r.problem_id, r.id, r.type, d.decided_at FROM return_decisions d JOIN returns r ON r.id = d.return_id
      WHERE ${TRUSTED} AND d.status = 'accepted' ORDER BY r.user_id, d.decided_at)
    ${INS} SELECT f.user_id, f.problem_id, 'first', ${SCORES.first}, true, 'first_accept:' || f.user_id, jsonb_build_object('return_id', f.id, 'type', f.type), f.decided_at
    FROM f JOIN eu ON eu.id = f.user_id WHERE f.decided_at >= eu.since ON CONFLICT (dedupe_key) DO NOTHING`);
  // Breakthroughs: a refutation or objection that held, a lemma proved.
  await q(`WITH ${EU} ${INS} SELECT c.user_id, c.problem_id, 'breakthrough', ${SCORES.breakthrough}, true, 'credit:' || c.id,
      jsonb_build_object('return_id', c.source_id::bigint, 'points', c.points), c.created_at
    FROM credits c JOIN eu ON eu.id = c.user_id WHERE c.kind = 'breakthrough' AND c.source_type = 'return' AND c.source_id ~ '^[0-9]+$' AND c.created_at >= eu.since
    ON CONFLICT (dedupe_key) DO NOTHING`);
  // Someone built on the person's work: insight credit for a cited return, paid when the citing return was accepted.
  await q(`WITH ${EU} ${INS} SELECT c.user_id, c.problem_id, 'cited', ${SCORES.cited}, true, 'credit:' || c.id,
      jsonb_build_object('return_id', c.source_id::bigint, 'by_return_id', substring(c.note from '#([0-9]+)')::bigint, 'points', c.points), c.created_at
    FROM credits c JOIN eu ON eu.id = c.user_id WHERE c.kind = 'insight' AND c.source_type = 'return' AND c.source_id ~ '^[0-9]+$' AND c.note LIKE 'built on by return #%' AND c.created_at >= eu.since
    ON CONFLICT (dedupe_key) DO NOTHING`);
  // Work that entered the record: a revision that became the served text.
  await q(`WITH ${EU} ${INS} SELECT v.author_user_id, v.problem_id, 'record', ${SCORES.record}, true, 'docver:' || v.id,
      jsonb_build_object('what', 'revision', 'path', v.path, 'version', v.version, 'return_id', v.return_id), v.created_at
    FROM document_versions v JOIN eu ON eu.id = v.author_user_id WHERE v.return_id IS NOT NULL AND v.created_at >= eu.since
    ON CONFLICT (dedupe_key) DO NOTHING`);
  // A route the person opened or worked on reached a result.
  await q(`WITH ${EU}, w AS (SELECT DISTINCT rr.id AS route_id, rr.problem_id, rr.title, rr.origin_return_id, rr.updated_at, r.user_id FROM research_routes rr
      JOIN returns r ON (r.id = rr.origin_return_id OR r.research_route_id = rr.id) WHERE rr.state = 'result')
    ${INS} SELECT w.user_id, w.problem_id, 'record', ${SCORES.record}, true, 'route:' || w.route_id || ':' || w.user_id,
      jsonb_build_object('what', 'route', 'route_id', w.route_id, 'title', w.title, 'return_id', w.origin_return_id), w.updated_at
    FROM w JOIN eu ON eu.id = w.user_id WHERE w.updated_at >= eu.since ON CONFLICT (dedupe_key) DO NOTHING`);
  // An announcement about the person's return went out.
  await q(`WITH ${EU} ${INS} SELECT a.finder_user_id, a.problem_id, 'record', ${SCORES.record}, true, 'announce:' || a.id,
      jsonb_build_object('what', 'announcement', 'announce_kind', a.kind, 'return_id', a.return_id), a.sent_at
    FROM announcements a JOIN eu ON eu.id = a.finder_user_id WHERE a.status = 'sent' AND a.sent_at >= eu.since ON CONFLICT (dedupe_key) DO NOTHING`);
  // Points milestones, once each, only when crossed in the window.
  await q(`WITH ${EU}, tot AS (SELECT c.user_id, c.problem_id, sum(c.points) AS total, sum(c.points) FILTER (WHERE c.created_at >= eu.since) AS recent
      FROM credits c JOIN eu ON eu.id = c.user_id WHERE c.problem_id IS NOT NULL GROUP BY c.user_id, c.problem_id)
    ${INS} SELECT t.user_id, t.problem_id, 'milestone', ${SCORES.milestone}, true, 'points:' || t.problem_id || ':' || m.v || ':' || t.user_id,
      jsonb_build_object('what', 'points', 'points', m.v), now()
    FROM tot t CROSS JOIN (VALUES (100), (500), (1000), (5000)) AS m(v) WHERE t.total >= m.v AND t.total - coalesce(t.recent, 0) < m.v
    ON CONFLICT (dedupe_key) DO NOTHING`);
  // Questions for the person (not for their agent: the agent reads those in its inbox).
  await q(`WITH ${EU} ${INS} SELECT a.to_user_id, a.problem_id, 'ask', ${SCORES.ask}, true, 'ask:' || a.id, jsonb_build_object('ask_id', a.id), a.created_at
    FROM asks a JOIN eu ON eu.id = a.to_user_id WHERE a.to_human AND a.status = 'open' AND a.created_at >= eu.since ON CONFLICT (dedupe_key) DO NOTHING`);
  // The monthly letter and new projects, for the people who ticked them (updates may be off). Approved in the last two weeks only.
  await q(`${INS} SELECT u.id, NULL, l.kind, 0, false, l.kind || ':' || l.id || ':' || u.id, jsonb_build_object('letter_id', l.id), l.approved_at
    FROM email_letters l JOIN email_preferences p ON (l.kind = 'letter' AND p.newsletter) OR (l.kind = 'project' AND p.projects) JOIN users u ON u.id = p.user_id
    WHERE l.approved_at > now() - interval '14 days' AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL AND u.email_status IS NULL
    ON CONFLICT (dedupe_key) DO NOTHING`);
}

export type Stats = {
  project: { id: number; slug: string; name: string } | null;
  points: number; points_since: number; points_7d: number;
  pending: number; pending_points: number;
  rank30: { rank: number | null; above: { handle: string; points: number } | null; below: { handle: string; points: number } | null; me: number };
  rank7: number | null;
  returns7: { made: number; accepted: number; rejected: number; pending: number };
  routes: { result: number; active: number };
  agent: { returns: number; reviews: number; tokens: number; cpu_hours: number; last_seen: string | null };
  streak: number; queue: number | null; activity7: number;
};

async function rankIn(problemId: number, userId: number, days: number) {
  const rows = await q<{ user_id: number; handle: string; p: number; rn: number }>(`WITH s AS (SELECT c.user_id, sum(c.points) AS p FROM credits c WHERE c.problem_id = $1 AND c.created_at >= now() - ($2::int * interval '1 day') GROUP BY c.user_id),
      r AS (SELECT s.user_id, u.handle, s.p, row_number() OVER (ORDER BY s.p DESC, s.user_id) AS rn FROM s JOIN users u ON u.id = s.user_id),
      me AS (SELECT rn FROM r WHERE user_id = $3)
    SELECT r.user_id, r.handle, r.p::float AS p, r.rn::int AS rn FROM r, me WHERE r.rn BETWEEN me.rn - 1 AND me.rn + 1 ORDER BY r.rn`, [problemId, days, userId]);
  const me = rows.find((r) => Number(r.user_id) === userId);
  if (!me) return { rank: null, above: null, below: null, me: 0 };
  const nb = (r?: typeof me) => r ? { handle: r.handle, points: Math.round(Number(r.p)) } : null;
  return { rank: me.rn, above: nb(rows.find((r) => r.rn === me.rn - 1)), below: nb(rows.find((r) => r.rn === me.rn + 1)), me: Math.round(Number(me.p)) };
}

/** Weeks in a row, up to this one or the last, with at least one trusted acceptance. */
export function streakOf(weekStarts: Array<string | Date>, now = new Date()): number {
  const wk = (d: Date) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.getTime(); };
  const have = new Set(weekStarts.map((w) => wk(new Date(w))));
  let cur = wk(now); if (!have.has(cur)) cur -= 7 * 86400_000;
  let n = 0; while (have.has(cur)) { n++; cur -= 7 * 86400_000; }
  return n;
}

export async function stats(userId: number, since: Date | null): Promise<Stats> {
  const pr = await one<any>(`SELECT p.id, p.slug, p.name FROM problems p WHERE p.id = coalesce(
      (SELECT problem_id FROM credits WHERE user_id = $1 AND problem_id IS NOT NULL GROUP BY problem_id ORDER BY max(created_at) DESC LIMIT 1),
      (SELECT problem_id FROM returns WHERE user_id = $1 ORDER BY id DESC LIMIT 1))`, [userId]);
  const pid = pr ? Number(pr.id) : null;
  const P = [userId, pid];
  const pts = await one<any>(`SELECT coalesce(sum(points), 0)::float AS total, coalesce(sum(points) FILTER (WHERE created_at > $3), 0)::float AS since,
      coalesce(sum(points) FILTER (WHERE created_at >= now() - interval '7 days'), 0)::float AS d7 FROM credits WHERE user_id = $1 AND problem_id = $2`, [...P, since ?? new Date(Date.now() - 86400_000)]);
  const pend = await one<any>(`SELECT count(*)::int AS n, coalesce(sum(${BASE_POINTS_SQL}), 0)::int AS p FROM returns WHERE user_id = $1 AND problem_id = $2 AND status = 'pending'`, P);
  const r7 = await one<any>(`SELECT count(*)::int AS made, count(*) FILTER (WHERE status = 'accepted')::int AS accepted, count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
      count(*) FILTER (WHERE status = 'pending')::int AS pending, coalesce(sum(cpu_hours), 0)::float AS cpu,
      coalesce(sum(coalesce((tokens->>'input')::numeric, 0) + coalesce((tokens->>'output')::numeric, 0) + coalesce((tokens->>'cache_read')::numeric, 0) + coalesce((tokens->>'cache_write')::numeric, 0)), 0)::float AS tokens
    FROM returns WHERE user_id = $1 AND problem_id = $2 AND created_at >= now() - interval '7 days'`, P);
  const rv7 = await one<any>(`SELECT count(*)::int AS n, coalesce(sum(coalesce((rv.tokens->>'input')::numeric, 0) + coalesce((rv.tokens->>'output')::numeric, 0) + coalesce((rv.tokens->>'cache_read')::numeric, 0) + coalesce((rv.tokens->>'cache_write')::numeric, 0)), 0)::float AS tokens
    FROM reviews rv JOIN returns r ON r.id = rv.return_id WHERE rv.user_id = $1 AND r.problem_id = $2 AND rv.created_at >= now() - interval '7 days'`, P);
  const routes = await one<any>(`SELECT count(DISTINCT rr.id) FILTER (WHERE rr.state = 'result')::int AS result, count(DISTINCT rr.id) FILTER (WHERE rr.state IN ('proposed','active'))::int AS active
    FROM research_routes rr JOIN returns r ON (r.id = rr.origin_return_id OR r.research_route_id = rr.id) WHERE r.user_id = $1 AND rr.problem_id = $2`, P);
  const seen = await one<any>(`SELECT max(last_seen) AS t FROM pool WHERE user_id = $1`, [userId]);
  const weeks = await q<{ w: string }>(`SELECT DISTINCT date_trunc('week', d.decided_at) AS w FROM return_decisions d JOIN returns r ON r.id = d.return_id
    WHERE r.user_id = $1 AND d.status = 'accepted' AND ${TRUSTED} AND d.decided_at >= now() - interval '26 weeks'`, [userId]);
  const roles = await one<any>(`SELECT count(*)::int AS n FROM project_roles WHERE user_id = $1 AND problem_id = $2 AND revoked_at IS NULL`, P);
  const queue = roles?.n ? Number((await one<any>(`SELECT count(*)::int AS n FROM returns WHERE problem_id = $2 AND status = 'pending' AND user_id <> $1`, P))?.n ?? 0) : null;
  const rank30 = pid ? await rankIn(pid, userId, 30) : { rank: null, above: null, below: null, me: 0 };
  const rank7 = pid ? (await rankIn(pid, userId, 7)).rank : null;
  return {
    project: pr ? { id: Number(pr.id), slug: pr.slug, name: pr.name } : null,
    points: Math.round(pts?.total ?? 0), points_since: Math.round(pts?.since ?? 0), points_7d: Math.round(pts?.d7 ?? 0),
    pending: pend?.n ?? 0, pending_points: pend?.p ?? 0, rank30, rank7,
    returns7: { made: r7?.made ?? 0, accepted: r7?.accepted ?? 0, rejected: r7?.rejected ?? 0, pending: r7?.pending ?? 0 },
    routes: { result: routes?.result ?? 0, active: routes?.active ?? 0 },
    agent: { returns: r7?.made ?? 0, reviews: rv7?.n ?? 0, tokens: (r7?.tokens ?? 0) + (rv7?.tokens ?? 0), cpu_hours: r7?.cpu ?? 0, last_seen: seen?.t ? new Date(seen.t).toISOString() : null },
    streak: streakOf(weeks.map((w) => w.w)), queue, activity7: (r7?.made ?? 0) + (rv7?.n ?? 0),
  };
}

/** Items worked out when the email is written, from this stats snapshot against the last email's: rank jumps, top 10, #1, the reviewer queue. */
export function composeTimeItems(userId: number, s: Stats, prev: Stats | null, day: string): Item[] {
  const out: Item[] = [], pid = s.project?.id ?? null, now = new Date();
  const r = s.rank30.rank, pr = prev?.rank30?.rank ?? null;
  // Reaching #1 or the top 10 says the move itself; a plain jump of RANK_JUMP or more places is its own line.
  if (r === 1 && pr !== 1 && pr != null) out.push({ kind: "milestone", score: SCORES.milestone + 5, news: true, problem_id: pid, facts: { what: "first_place", from: pr, to: r }, happened_at: now, dedupe_key: `top1:${pid}:${userId}:${day}` });
  else if (r && r <= 10 && pr != null && pr > 10) out.push({ kind: "milestone", score: SCORES.milestone, news: true, problem_id: pid, facts: { what: "top10", from: pr, to: r }, happened_at: now, dedupe_key: `top10:${pid}:${userId}:${day}` });
  else if (r && pr && pr - r >= RANK_JUMP) out.push({ kind: "rank", score: SCORES.rank, news: true, problem_id: pid, facts: { from: pr, to: r }, happened_at: now, dedupe_key: `rank:${userId}:${day}` });
  if (s.queue != null && prev?.queue != null && s.queue - prev.queue >= QUEUE_JUMP) out.push({ kind: "queue", score: SCORES.queue, news: true, problem_id: pid, facts: { waiting: s.queue }, happened_at: now, dedupe_key: `queue:${userId}:${day}` });
  return out;
}

/** One line per return: a first acceptance, a breakthrough, an announcement and an acceptance of the same return become one item, the highest. */
export function mergeByReturn(items: Item[]): Item[] {
  const byReturn = new Map<string, Item[]>(), rest: Item[] = [];
  for (const it of items) {
    const rid = it.facts?.return_id;
    if (rid != null && ["first", "breakthrough", "accepted"].includes(it.kind) || (rid != null && it.kind === "record" && it.facts?.what === "announcement")) {
      const k = String(rid); byReturn.set(k, [...(byReturn.get(k) ?? []), it]);
    } else rest.push(it);
  }
  for (const group of byReturn.values()) {
    const top = [...group].sort((a, b) => b.score - a.score)[0];
    const points = Math.max(0, ...group.map((g) => Number(g.facts?.points ?? 0)));
    rest.push({ ...top, facts: { ...top.facts, points, type: top.facts?.type ?? group.find((g) => g.facts?.type)?.facts?.type }, merged: group.map((g) => g.id).filter(Boolean) } as any);
  }
  // A later verdict on the same return replaces an earlier one (a reversal is reported once, as it stands).
  const verdicts = new Map<string, Item>();
  const out: Item[] = [];
  for (const it of rest) {
    if (it.kind === "verdict") { const k = String(it.facts?.return_id); const prev = verdicts.get(k); if (!prev || new Date(it.happened_at) > new Date(prev.happened_at)) verdicts.set(k, it); }
    else out.push(it);
  }
  for (const v of verdicts.values()) if (!out.some((o) => String(o.facts?.return_id) === String(v.facts?.return_id))) out.push(v);
  return out;
}

/** The lead: highest score, then more points, then newest. An ask leads only when it is the only news. */
export function pickLead(items: Item[]): Item | null {
  const news = items.filter((i) => i.news);
  const ranked = news.filter((i) => i.kind !== "ask").sort((a, b) => b.score - a.score || Number(b.facts?.points ?? 0) - Number(a.facts?.points ?? 0) || +new Date(b.happened_at) - +new Date(a.happened_at));
  return ranked[0] ?? news.find((i) => i.kind === "ask") ?? null;
}

export type Edition = "daily" | "weekly" | "letter";
export type Composed = {
  edition: Edition; subject: string; lead: Item | null; asks: Item[]; rest: Item[]; more: number; stats: Stats | null; letters: any[];
  items: Item[]; quietSince: string | null; offerLetter: boolean; prefs: Prefs;
};

/**
 * Decide what today's email is, or that there is none. `weekday` is the person's local ISO weekday (1 = Monday).
 * Daily needs news. The weekly edition (Mondays, and the only edition for "weekly" people) needs news or any activity in the week.
 * Letters and project news go in whichever email goes out, or alone.
 */
export function decide(prefs: Prefs, waiting: Item[], computed: Item[], s: Stats | null, weekday: number): { edition: Edition; items: Item[]; letters: Item[] } | null {
  const letters = waiting.filter((i) => i.kind === "letter" || i.kind === "project");
  const work = mergeByReturn([...waiting.filter((i) => i.kind !== "letter" && i.kind !== "project"), ...computed]);
  const hasNews = work.some((i) => i.news);
  const monday = weekday === 1;
  if (prefs.updates === "daily" && !monday && hasNews) return { edition: "daily", items: work, letters };
  if (prefs.updates !== "off" && monday && (hasNews || (s?.activity7 ?? 0) > 0)) return { edition: "weekly", items: work, letters };
  if (letters.length) return { edition: "letter", items: [], letters };
  return null;
}

const n = (x: number) => x.toLocaleString("en-US");
const tok = (x: number) => x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}k` : String(Math.round(x));
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const cap = (s: unknown, len: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > len ? t.slice(0, len - 1) + "…" : t; };
const day = (d: string | Date) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const typeName = (t: string) => ({ formalize: "formalization", paper: "paper", break: "break", direction: "direction", challenge: "challenge", audit: "audit", explore: "explore", measure: "measurement", source: "source", curate: "curation" } as Record<string, string>)[t] ?? (t || "return");
const REASONS: Record<string, string> = { refuted: "refuted", overclaimed: "it claimed more than its evidence showed", unsourced: "its sources were missing", unverifiable: "it could not be checked in budget" };

/** What the renderer needs that items only point at: handles, ask texts, letters, project slugs. Joined at send time, never stored. */
type Ctx = { slug: (pid: number | null) => string; projectName: (pid: number | null) => string; handleOfReturn: Map<number, string>; asks: Map<number, any>; letters: Map<number, any>; link: (path: string) => string };

async function context(c: Composed, outboxId: number): Promise<Ctx> {
  const all = [...(c.lead ? [c.lead] : []), ...c.asks, ...c.rest];
  const pids = [...new Set([...all.map((i) => i.problem_id).filter((x): x is number => x != null), ...(c.stats?.project ? [c.stats.project.id] : [])])];
  const projects = new Map((pids.length ? await q<any>(`SELECT id, slug, name FROM problems WHERE id = ANY($1)`, [pids]) : []).map((p) => [Number(p.id), p]));
  const citers = all.map((i) => Number(i.facts?.by_return_id)).filter(Boolean);
  const handleOfReturn = new Map((citers.length ? await q<any>(`SELECT r.id, u.handle, u.display_name FROM returns r JOIN users u ON u.id = r.user_id WHERE r.id = ANY($1)`, [citers]) : []).map((r) => [Number(r.id), creditText(r)]));
  const askIds = c.asks.map((a) => Number(a.facts?.ask_id)).filter(Boolean);
  const asks = new Map((askIds.length ? await q<any>(`SELECT a.id, a.body_md, a.return_id, a.expires_at, a.status, u.handle, u.display_name FROM asks a JOIN users u ON u.id = a.from_user_id WHERE a.id = ANY($1)`, [askIds]) : []).map((a) => [Number(a.id), a]));
  const lids = c.letters.map((l) => Number(l.facts?.letter_id)).filter(Boolean);
  const letters = new Map((lids.length ? await q<any>(`SELECT id, kind, subject, body_md FROM email_letters WHERE id = ANY($1)`, [lids]) : []).map((l) => [Number(l.id), l]));
  const fallback = c.stats?.project ? projects.get(c.stats.project.id) : [...projects.values()][0];
  return {
    slug: (pid) => (pid != null && projects.get(pid)?.slug) || fallback?.slug || "",
    projectName: (pid) => (pid != null && projects.get(pid)?.name) || fallback?.name || "the project",
    handleOfReturn, asks, letters,
    link: (path) => { const [p, hash] = path.split("#"); return `${BASE()}${p}${p.includes("?") ? "&" : "?"}e=${outboxId}${hash ? `#${hash}` : ""}`; },
  };
}

/** One item as a headline, a sentence of why it matters, and its link. Platform facts lead; agent text is quoted capped and escaped by the caller. */
export function describe(it: Item, x: Pick<Ctx, "slug" | "projectName" | "handleOfReturn" | "asks">): { head: string; why: string; path: string } {
  const f = it.facts ?? {}, slug = x.slug(it.problem_id), pts = Number(f.points ?? 0), plus = pts > 0 ? ` (+${n(Math.round(pts))})` : "";
  const ret = (id: unknown) => `/projects/${slug}/return/${id}`;
  switch (it.kind) {
    case "record":
      if (f.what === "revision") return { head: `Your revision is now the text everyone reads: ${f.path}`, why: `Version ${f.version} of ${f.path} is your agent's. Everyone who opens the document, and every agent briefed on it, reads your version.`, path: `/projects/${slug}/history/${String(f.path).split("/").map(encodeURIComponent).join("/")}` };
      if (f.what === "route") return { head: `A route your agent worked on reached a result: "${cap(f.title, 90)}"`, why: `The route is closed with a result on ${x.projectName(it.problem_id)}, and your work is part of it.`, path: ret(f.return_id) };
      return { head: `Your agent's ${f.announce_kind ?? "result"} was announced${plus}`, why: `Trusted reviewers accepted it and marked it for the project's announcement, which credits you.`, path: ret(f.return_id) };
    case "first": return { head: `Your first accepted result on ${x.projectName(it.problem_id)}${plus}`, why: `Trusted reviewers accepted your agent's ${typeName(f.type)}. It is now part of the project's record.`, path: ret(f.return_id) };
    case "breakthrough": return { head: `Your agent's ${typeName(f.type)} held${plus}`, why: `Trusted reviewers accepted it as a breakthrough: the objection or counterexample stands.`, path: ret(f.return_id) };
    case "accepted": return { head: `Accepted: your agent's ${typeName(f.type)}${plus}`, why: `Trusted reviewers accepted return #${f.return_id}${f.final_rung ? ` as ${f.final_rung}` : ""}. It is now part of the project's record.`, path: ret(f.return_id) };
    case "cited": { const who = x.handleOfReturn.get(Number(f.by_return_id)) ?? "Another contributor"; return { head: `${who} built on your work${plus}`, why: `Their accepted return #${f.by_return_id} cites your return #${f.return_id}.`, path: ret(f.by_return_id ?? f.return_id) }; }
    case "milestone":
      if (f.what === "top10") return { head: `You're in this month's top 10 on ${x.projectName(it.problem_id)}${f.to ? `: #${f.to}, up from #${f.from}` : ""}`, why: `Ranked by points over the last 30 days.`, path: `/projects/${slug}#contributors` };
      if (f.what === "first_place") return { head: `You're #1 this month on ${x.projectName(it.problem_id)}${f.from ? `, up from #${f.from}` : ""}`, why: `Ranked by points over the last 30 days.`, path: `/projects/${slug}#contributors` };
      return { head: `You passed ${n(Number(f.points))} points on ${x.projectName(it.problem_id)}`, why: `Points are paid only on trusted acceptance.`, path: `/projects/${slug}#contributors` };
    case "rank": return { head: `Up ${f.from - f.to} places this month, to #${f.to}`, why: `From #${f.from} at your last email, in the 30-day standings.`, path: `/projects/${slug}#contributors` };
    case "verdict":
      if (f.status === "contested") return { head: `Contested: your agent's ${typeName(f.type)} (return #${f.return_id})`, why: `Trusted reviewers disagree, so it stays open. Nothing you earned on it is taken back without a recorded decision.`, path: ret(f.return_id) };
      return { head: `Not accepted: your agent's ${typeName(f.type)}${f.reason ? ` (${REASONS[f.reason] ?? f.reason})` : ""}`, why: `Nothing is lost: the reviewers' notes say what would carry it, your agent sees them on its next assignment, and if a later accepted return cites it, it still earns points.`, path: ret(f.return_id) };
    case "queue": return { head: `${n(Number(f.waiting))} returns are waiting for a trusted verdict`, why: `Returns you may decide on ${x.projectName(it.problem_id)}. Your agent gets them as review assignments.`, path: `/projects/${slug}/board` };
    case "ask": {
      const a = x.asks.get(Number(f.ask_id));
      const who = a ? creditText(a) : "Someone";
      return { head: `${who} asks: "${cap(a?.body_md, 280)}"`, why: a?.expires_at ? `Open until ${day(a.expires_at)}.` : "", path: `/projects/${slug}/asks/${f.ask_id}` };
    }
    default: return { head: "", why: "", path: `/projects/${slug}` };
  }
}

export function subjectOf(c: Pick<Composed, "edition" | "lead" | "rest" | "asks" | "stats" | "letters">, x: Pick<Ctx, "slug" | "projectName" | "handleOfReturn" | "asks" | "letters">): string {
  if (c.edition === "letter") { const l = x.letters.get(Number(c.letters[0]?.facts?.letter_id)); return cap(l?.subject ?? "From solveathome", 110); }
  const others = c.rest.length + c.asks.length - (c.lead?.kind === "ask" ? 1 : 0);
  let head = c.lead ? describe(c.lead, x).head : "";
  if (c.lead?.kind === "ask") head = `A question for you from ${describe(c.lead, x).head.split(" asks:")[0]}`;
  if (!head && c.stats) head = `Your agent made ${n(c.stats.returns7.made)} return${c.stats.returns7.made === 1 ? "" : "s"} this week${c.stats.pending ? `; ${n(c.stats.pending)} waiting on review` : ""}`;
  const more = others > 0 ? `, and ${others} more` : "";
  if (c.edition === "weekly") head = `Your week: ${/^(Your|You're|You|Accepted|Contested|Not|Up) /.test(head) ? head[0].toLowerCase() + head.slice(1) : head}`;
  return cap(`${head}${more}`, 120);
}

export async function compose(userId: number, opts: { weekday: number; day: string; dry?: boolean } ): Promise<Composed | null> {
  const prefs = await prefsOf(userId);
  const waiting = await q<any>(`SELECT id, kind, score, news, problem_id, facts, happened_at, dedupe_key FROM email_items WHERE user_id = $1 AND email_id IS NULL ORDER BY happened_at`, [userId]);
  // Asks that were answered or expired since they were queued are no longer news.
  const askIds = waiting.filter((w) => w.kind === "ask").map((w) => Number(w.facts?.ask_id));
  const openAsks = new Set((askIds.length ? await q<any>(`SELECT id FROM asks WHERE id = ANY($1) AND status = 'open' AND expires_at > now()`, [askIds]) : []).map((a) => Number(a.id)));
  const live = waiting.filter((w) => w.kind !== "ask" || openAsks.has(Number(w.facts?.ask_id))).map((w) => ({ ...w, problem_id: w.problem_id == null ? null : Number(w.problem_id), id: Number(w.id) }));
  const last = await one<any>(`SELECT sections, sent_at, created_at FROM email_outbox WHERE user_id = $1 AND status IN ('sent','suppressed') ORDER BY local_day DESC LIMIT 1`, [userId]);
  const s = prefs.updates === "off" ? null : await stats(userId, last ? new Date(last.sent_at ?? last.created_at) : null);
  const computed = s ? composeTimeItems(userId, s, (last?.sections?.stats as Stats) ?? null, opts.day) : [];
  const d = decide(prefs, live, computed, s, opts.weekday);
  if (!d) return null;
  const lead = pickLead(d.items);
  const asks = d.items.filter((i) => i.kind === "ask" && i !== lead);
  const others = d.items.filter((i) => i !== lead && i.kind !== "ask").sort((a, b) => +new Date(b.happened_at) - +new Date(a.happened_at));
  const quiet = s?.agent.last_seen && Date.now() - +new Date(s.agent.last_seen) > 14 * 86400_000 ? s.agent.last_seen : null;
  const offerLetter = !prefs.newsletter && d.items.some((i) => i.kind === "first");
  return { edition: d.edition, subject: "", lead, asks, rest: others.slice(0, LIST_MAX), more: Math.max(0, others.length - LIST_MAX), stats: d.edition === "letter" ? null : s, letters: d.letters, items: [...d.items, ...d.letters], quietSince: quiet, offerLetter, prefs };
}

/** The small label beside a line in the list, and the eyebrow over the lead. */
export function labelOf(it: Item): string {
  const f = it.facts ?? {};
  switch (it.kind) {
    case "record": return f.what === "revision" ? "In the record" : f.what === "route" ? "Route closed" : "Announced";
    case "first": return "First result";
    case "breakthrough": return "It held";
    case "accepted": return "Accepted";
    case "cited": return "Built on";
    case "milestone": return "Milestone";
    case "rank": return "Rank";
    case "verdict": return f.status === "contested" ? "Contested" : "Not accepted";
    case "queue": return "To review";
    case "ask": return "Question";
    default: return "";
  }
}

/** Text and HTML for a composed email. Every link carries ?e=<outbox id> so a click is counted against this email. */
export async function render(c: Composed, userId: number, outboxId: number): Promise<{ subject: string; text: string; html: string; unsubscribe: string }> {
  const x = await context(c, outboxId);
  const subject = subjectOf(c, x);
  const u = (a: UnsubAction) => `${BASE()}/email/u/${unsubToken(userId, a)}`;
  const me = await one<any>(`SELECT handle FROM users WHERE id = $1`, [userId]);
  const page = `/@${me?.handle ?? ""}`;
  const T: string[] = [], B: string[] = [];
  let preheader = "";
  const quiet = c.quietSince && c.lead ? `Your agent was last seen on ${day(c.quietSince)}. While it was away:` : "";
  if (quiet) T.push(quiet, "");
  if (c.lead) {
    const d = describe(c.lead, x);
    T.push(d.head, `${d.why}\n${x.link(d.path)}`, "");
    preheader = d.why;
    B.push(tpl.hero({ eyebrow: labelOf(c.lead), head: d.head, why: d.why, href: x.link(d.path), cta: c.lead.kind === "ask" ? "Answer" : c.lead.kind === "record" && c.lead.facts?.what === "revision" ? "See the change" : "See it", note: quiet || undefined }));
  } else if (c.stats && c.edition === "weekly") {
    const s = c.stats;
    const head = `Your agent made ${n(s.returns7.made)} return${s.returns7.made === 1 ? "" : "s"} and ${n(s.agent.reviews)} review${s.agent.reviews === 1 ? "" : "s"} this week.`;
    const why = s.pending ? `${n(s.pending)} ${s.pending === 1 ? "is" : "are"} waiting on review, worth up to ${n(s.pending_points)} points if accepted.` : "Here is where it stands.";
    T.push(`Your agent made ${s.returns7.made} returns and ${s.agent.reviews} reviews this week.${s.pending ? ` ${s.pending} waiting on review, worth up to ${s.pending_points} points if accepted.` : ""}`, "");
    preheader = why;
    B.push(tpl.hero({ eyebrow: "Your week", head, why, href: x.link(page), cta: "Your page" }));
  }
  if (c.offerLetter) {
    B.push(tpl.spacer(20), tpl.paragraph(`Want the monthly letter too? It's one email a month about what the whole project moved. <a href="${esc(x.link("/settings#email"))}" style="color:inherit;text-decoration:underline">Turn it on</a>`));
    T.push(`Want the monthly letter too? ${x.link("/settings#email")}`, "");
  }
  if (c.asks.length) {
    T.push("NEEDS YOUR ANSWER", "");
    const asks = c.asks.map((it) => { const d = describe(it, x); T.push(`${d.head} ${d.why}\n${x.link(d.path)}`, ""); return { head: d.head, why: d.why, href: x.link(d.path) }; });
    B.push(tpl.askBlock(asks));
  }
  if (c.rest.length) {
    const title = c.edition === "weekly" ? "Also this week" : "Also since your last email";
    T.push(title.toUpperCase(), "");
    const lines = c.rest.map((it) => { const d = describe(it, x); T.push(`- ${d.head}  ${x.link(d.path)}`); return { label: labelOf(it), head: d.head, href: x.link(d.path) }; });
    if (c.more) T.push(`- and ${c.more} more on your page`);
    T.push("");
    B.push(tpl.rows(title, lines, c.more ? { label: `and ${c.more} more on your page`, href: x.link(page) } : undefined));
  }
  if (c.stats?.project) {
    const s = c.stats, r = s.rank30, r7 = s.returns7, ag = s.agent;
    const title = c.edition === "weekly" ? "Your week in numbers" : "Your stats";
    const lines: Array<[string, string]> = [];
    lines.push([`Points <b>${n(s.points)}</b> (+${n(s.points_since)} since your last email, +${n(s.points_7d)} this week)`, `Points ${n(s.points)} (+${n(s.points_since)} since your last email, +${n(s.points_7d)} this week)`]);
    if (s.pending) lines.push(["", `Pending: ${s.pending} returns, worth up to ${s.pending_points} if accepted`]);
    const nb = r.rank ? [r.above ? `@${r.above.handle} ${n(r.above.points)}` : "", `you ${n(r.me)}`, r.below ? `@${r.below.handle} ${n(r.below.points)}` : ""].filter(Boolean).join(" · ") : "";
    if (r.rank) lines.push(["", `Rank, 30 days: #${r.rank}${s.rank7 ? ` · 7 days: #${s.rank7}` : ""} (${nb})`]);
    if (r7.made) lines.push(["", `Returns this week: ${r7.made} made, ${r7.accepted} accepted, ${r7.rejected} not accepted, ${r7.pending} pending`]);
    if (s.routes.result || s.routes.active) lines.push(["", `Routes: ${s.routes.result} reached a result, ${s.routes.active} open`]);
    const agentLine = !ag.returns && !ag.reviews ? `Your agent made no returns or reviews this week${ag.last_seen ? `; last seen ${day(ag.last_seen)}` : ""}`
      : `Your agent this week: ${ag.returns} returns, ${ag.reviews} reviews, ${tok(ag.tokens)} tokens, ${ag.cpu_hours.toFixed(1)} CPU hours${ag.last_seen ? `, last seen ${day(ag.last_seen)}` : ""}`;
    lines.push(["", agentLine]);
    if (s.streak >= 2) lines.push(["", `${s.streak} weeks in a row with an accepted result`]);
    T.push(title.toUpperCase(), "", ...lines.map((l) => l[1]), "", `Your page: ${x.link(page)}`, "");
    const cards: Array<{ value: string; label: string; sub?: string }> = [
      { value: n(s.points), label: "Points", sub: `+${n(s.points_since)} since your last email` },
      ...(r.rank ? [{ value: `#${r.rank}`, label: "Rank, 30 days", sub: s.rank7 ? `#${s.rank7} over 7 days` : undefined }] : []),
      ...(s.pending ? [{ value: n(s.pending), label: "Waiting on review", sub: `worth up to ${n(s.pending_points)} if accepted` }] : []),
      r7.made ? { value: n(r7.made), label: "Returns this week", sub: `${n(r7.accepted)} accepted · ${n(r7.rejected)} not · ${n(r7.pending)} pending` }
        : { value: "0", label: "Returns this week", sub: ag.last_seen ? `agent last seen ${day(ag.last_seen)}` : undefined },
    ];
    const details = [
      ...(nb ? [`Around you this month: ${esc(nb)}`] : []),
      ...(s.routes.result || s.routes.active ? [`Routes: ${n(s.routes.result)} reached a result, ${n(s.routes.active)} open`] : []),
      ...(ag.returns || ag.reviews ? [`Your agent this week: ${n(ag.returns)} returns, ${n(ag.reviews)} reviews, ${tok(ag.tokens)} tokens, ${ag.cpu_hours.toFixed(1)} CPU hours${ag.last_seen ? `, last seen ${esc(day(ag.last_seen))}` : ""}`] : []),
      ...(s.streak >= 2 ? [`<b class="txt" style="color:inherit">${s.streak} weeks in a row</b> with an accepted result`] : []),
    ];
    B.push(tpl.statCards(title, cards, details, { href: x.link(page), label: "Your page →" }));
  }
  for (const l of c.letters) {
    const L = x.letters.get(Number(l.facts?.letter_id)); if (!L) continue;
    const title = c.edition !== "letter" ? (L.kind === "project" ? "New on solveathome" : "From Chris this month") : null;
    if (title) T.push(title.toUpperCase(), "");
    T.push(L.subject, String(L.body_md), "");
    if (!preheader) preheader = cap(String(L.body_md).replace(/[*_#>`]/g, ""), 140);
    B.push(c.edition === "letter" && !B.length ? tpl.letterBlock(null, L.subject, marked.parse(String(L.body_md), { async: false }) as string).replace(/^<tr><td style="height:\d+px[^]*?<\/tr>/, "") : tpl.letterBlock(title, L.subject, marked.parse(String(L.body_md), { async: false }) as string));
  }
  const why = c.edition === "letter"
    ? `You get this because you asked for ${c.letters.some((l) => l.kind === "project") ? "news of new projects" : "the monthly letter"}. We never send more than one email a day.`
    : `You get one update ${c.prefs.updates === "weekly" ? "a week, on Mondays" : "a day at most, only on days something happened to your work"}.`;
  const links: Array<[string, string]> = c.edition === "letter"
    ? [[u(c.letters.some((l) => l.kind === "letter") ? "newsletter-off" : "projects-off"), "Stop these"], [`${BASE()}/settings#email`, "All settings"]]
    : [...(c.prefs.updates === "daily" ? [[u("weekly"), "Weekly instead"] as [string, string]] : []), [u("updates-off"), "Off"], [`${BASE()}/settings#email`, "All settings"]];
  T.push("--", why, ...links.map(([href, label]) => `${label}: ${href}`));
  const eyebrow = `${c.stats?.project?.name ?? "solveathome"} · ${c.edition === "weekly" ? "Weekly edition" : c.edition === "letter" ? "Letter" : "Daily update"}`;
  const html = tpl.shell({ title: subject, preheader: preheader || subject, eyebrow, body: B.join("\n"), footerWhy: why, footerLinks: links });
  const unsubscribe = c.edition === "letter" ? u(c.letters.some((l) => l.kind === "letter") ? "newsletter-off" : "projects-off") : u("updates-off");
  return { subject, text: T.join("\n"), html, unsubscribe };
}

/** The holdout (decision 9): EMAIL_HOLDOUT_PERCENT of people (10 by default), fixed per person, get no update until EMAIL_HOLDOUT_UNTIL. */
export function inHoldout(userId: number, now = new Date()): boolean {
  const until = process.env.EMAIL_HOLDOUT_UNTIL; if (!until || !(new Date(until) > now)) return false;
  const pct = Math.max(0, Math.min(100, Number(process.env.EMAIL_HOLDOUT_PERCENT ?? 10)));
  return createHash("sha256").update(`holdout:${userId}`).digest().readUInt32BE(0) % 100 < pct;
}

/** People whose local 08:00 has passed today and who have no email for today yet, with something that could make one. */
async function due(limit = 200): Promise<Array<{ id: number; email: string; day: string; weekday: number; handle: string }>> {
  const allow = (process.env.EMAIL_ALLOWLIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return q<any>(`WITH c AS (SELECT u.id, u.email, u.handle, (now() AT TIME ZONE coalesce(u.email_tz, 'UTC')) AS lt FROM users u
      WHERE u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL AND u.email_status IS NULL ${allow.length ? `AND lower(u.handle) = ANY($2)` : ""})
    SELECT c.id::int AS id, c.email, c.handle, to_char(c.lt::date, 'YYYY-MM-DD') AS day, extract(isodow FROM c.lt)::int AS weekday FROM c
    LEFT JOIN email_preferences p ON p.user_id = c.id
    WHERE extract(hour FROM c.lt) >= ${SEND_HOUR}
      AND NOT EXISTS (SELECT 1 FROM email_outbox o WHERE o.user_id = c.id AND o.local_day = c.lt::date)
      AND (EXISTS (SELECT 1 FROM email_items i WHERE i.user_id = c.id AND i.email_id IS NULL) OR (extract(isodow FROM c.lt) = 1 AND coalesce(p.updates, 'daily') <> 'off'))
    ORDER BY c.id LIMIT $1`, allow.length ? [limit, allow] : [limit]);
}

/** Write and send one person's email for today, or nothing. Returns what happened, for the log and the tests. */
export async function deliver(person: { id: number; email: string; day: string; weekday: number }): Promise<string> {
  const c = await compose(person.id, { weekday: person.weekday, day: person.day });
  if (!c) return "nothing";
  const holdout = c.edition !== "letter" && inHoldout(person.id);
  // Claim the day. The unique (user, local_day) key is the cap: whoever inserts first writes today's email, everyone else stops here.
  const row = await one<{ id: number }>(`INSERT INTO email_outbox (user_id, local_day, edition, holdout, status, suppressed_reason) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (user_id, local_day) DO NOTHING RETURNING id`, [person.id, person.day, c.edition, holdout, holdout ? "suppressed" : "queued", holdout ? "holdout" : null]);
  if (!row) return "already";
  const id = Number(row.id);
  // Items worked out now (rank, top 10, queue) are stored so the record shows what the email said; the waiting ones are marked reported.
  for (const it of c.items.filter((i) => !i.id)) {
    const r = await one<{ id: number }>(`INSERT INTO email_items (user_id, problem_id, kind, score, news, dedupe_key, facts, happened_at, email_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [person.id, it.problem_id, it.kind, it.score, it.news, it.dedupe_key, it.facts, it.happened_at, id]);
    if (r) it.id = Number(r.id);
  }
  const ids = c.items.flatMap((i: any) => [i.id, ...(i.merged ?? [])]).filter(Boolean);
  // Waiting items that were merged into another line, or cut from a long list, are reported too: the page holds the rest.
  await q(`UPDATE email_items SET email_id = $2 WHERE user_id = $1 AND email_id IS NULL AND (id = ANY($3) OR kind NOT IN ('letter','project'))`, [person.id, id, ids]);
  const m = await render(c, person.id, id);
  await q(`UPDATE email_outbox SET subject = $2, sections = $3 WHERE id = $1`, [id, m.subject, { lead: c.lead?.dedupe_key ?? null, items: ids.length, stats: c.stats }]);
  if (holdout) return "holdout";
  const r = await send({ to: person.email, subject: m.subject, html: m.html, text: m.text, stream: "broadcast", unsubscribeUrl: m.unsubscribe, tag: c.edition, from: c.edition === "letter" && c.letters.some((l) => l.kind === "letter") ? letterFromAddress() : undefined });
  if (r.ok) { await q(`UPDATE email_outbox SET status = 'sent', sent_at = now(), provider_message_id = $2 WHERE id = $1`, [id, r.id]); return "sent"; }
  // A failed send keeps the day (one email a day, never two) and gives the items back to tomorrow's email.
  await q(`UPDATE email_outbox SET status = $2, suppressed_reason = $3 WHERE id = $1`, [id, r.reason.startsWith("no provider") ? "suppressed" : "failed", r.reason]);
  await q(`UPDATE email_items SET email_id = NULL WHERE email_id = $1`, [id]);
  return r.reason.startsWith("no provider") ? "no-provider" : "failed";
}

/** A dry run for the person's own preview: what today's email would say, written with nothing stored and nothing sent. */
export async function preview(userId: number, weekday?: number): Promise<{ subject: string; html: string; text: string } | null> {
  const lt = await one<any>(`SELECT to_char((now() AT TIME ZONE coalesce(email_tz, 'UTC'))::date, 'YYYY-MM-DD') AS day, extract(isodow FROM now() AT TIME ZONE coalesce(email_tz, 'UTC'))::int AS wd FROM users WHERE id = $1`, [userId]);
  const c = await compose(userId, { weekday: weekday ?? lt?.wd ?? 2, day: lt?.day ?? "" });
  if (!c) return null;
  const m = await render(c, userId, 0);
  return { subject: m.subject, html: m.html, text: m.text };
}

let running = false;
/** One pass: queue new items, then write today's email for whoever is due. Off unless EMAIL_ENABLED=1. */
export async function emailTick(): Promise<void> {
  if (process.env.EMAIL_ENABLED !== "1" || running) return;
  running = true;
  try {
    await scan();
    for (const person of await due()) {
      try { const r = await deliver(person); if (r !== "nothing" && r !== "already") console.log(`email: @${person.handle} ${person.day} ${r}`); }
      catch (e: any) { console.error(`email: @${person.handle}:`, e?.message ?? e); }
    }
  } finally { running = false; }
}
