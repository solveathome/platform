/**
 * Record posts (Chris, Oct 19 2026, #sah-discord-record-posts: "it should VERY much share into discord each time we break a record").
 * A new best on a record-challenge track gets one post in the project's Discord, through the same webhook and kill switch as the
 * announcements of accepted returns (src/lib/announce.ts), in an outbox of its own (record_announcements).
 *
 * The trigger is the server's own record event: challenge_events kind 'record' in the live namespace, written in the receipt's
 * transaction only after both MD5 implementations recomputed the result (src/lib/challenges.ts submit). A claim is never read.
 * One row per submission, ever (the unique submission_id). The post waits `record_hold_minutes` after the receipt so a burst on one
 * track becomes one post: when it is due, the record is read again from the current view (trackView, corrections applied), and a row
 * whose submission was withdrawn, or was passed by a newer verified record meanwhile, is dropped with the reason. A sent post whose
 * submission is later withdrawn is edited, with a correction after it. Template text only: every line is a record field.
 *
 * Config per project in project.json, off unless set: "announce": { "records": true, "records_since": "<ISO time>",
 * "record_hold_minutes": 10, "record_max_per_day": 12 }. Only record events from records_since on are posted (no backfill; without it
 * nothing is). The webhook is the project's announce.webhook_env; ANNOUNCE_ENABLED=0 stops it all.
 */
import { q, one } from "../db/index.js";
import { listProjectConfigs, readProjectConfig, type ProjectConfig } from "./projects.js";
import { announceConfig, announceEnabled, overclaim, quoteSafe, webhookUrl, type Fetch } from "./announce.js";
import { challengeConfig, currentTarget, recordLead, trackById, trackView, LIVE_SQL, type ChallengeTrack, type Step } from "./challenges.js";

export type RecordAnnounceConfig = { records: boolean; since: Date | null; hold_minutes: number; max_per_day: number };
export function recordAnnounceConfig(cfg: ProjectConfig | null | undefined): RecordAnnounceConfig {
  const a = (cfg as any)?.announce ?? {};
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  const since = typeof a.records_since === "string" && !Number.isNaN(Date.parse(a.records_since)) ? new Date(a.records_since) : null;
  return { records: a.records === true, since, hold_minutes: num(a.record_hold_minutes, 10), max_per_day: num(a.record_max_per_day, 12) };
}
export const recordSlugs = (): string[] => listProjectConfigs().filter((c) => recordAnnounceConfig(c).records && challengeConfig(c.slug)).map((c) => c.slug);

const handleOf = (h: string) => String(h).replace(/[^A-Za-z0-9_.-]/g, "");
const day = (d: string | Date) => new Date(d).toISOString().slice(0, 10);
export const valueText = (t: ChallengeTrack, v: number) => `${v} ${t.display?.unit ?? t.unit}`;
export function duration(s: number | null | undefined): string | null {
  if (s === null || s === undefined || !Number.isFinite(Number(s))) return null;
  const x = Number(s);
  return x < 120 ? `${Math.round(x * 10) / 10} s` : x < 7200 ? `${Math.round(x / 60)} min` : `${Math.round(x / 360) / 10} h`;
}

export type RecordFacts = { track: ChallengeTrack; slug: string; base: string; submission_id: number; value: number; handle: string; received_at: string | Date;
  previous: Pick<Step, "submission_id" | "value" | "handle" | "received_at"> | null; hardware?: string | null; runtime_s?: number | null };
/** The post. The finder is the one name; the previous record and the published best are the comparison; nothing is reworded. */
export function buildRecordPost(f: RecordFacts): { title: string; description: string; url: string; color: number } {
  const P = `${f.base}/projects/${f.slug}`, t = f.track, h = handleOf(f.handle);
  const target = currentTarget(t);
  const lead = recordLead(t, { value: f.value }, target);
  const lines = [`**${valueText(t, f.value)}**, found by **[@${h}](${f.base}/@${h})**.`];
  lines.push(f.previous
    ? `Previous solveathome record: ${valueText(t, f.previous.value)}, [#${f.previous.submission_id}](${P}/submissions/${f.previous.submission_id}) by @${handleOf(f.previous.handle)} (${day(f.previous.received_at)}).`
    : "The first verified result on this track.");
  if (target) {
    const vs = lead ? `This record is ${lead.phrase}.`
      : target.value === f.value ? "This matches it; it does not pass it."
      : `That is still ${Math.abs(target.value - f.value)} ${t.display?.reference_unit ?? t.unit} ${t.better === "lower" ? "smaller" : "more"} than this record.`;
    lines.push(`Best known before solveathome: ${valueText(t, target.value)}, ${quoteSafe(target.credit, 200)} ([source](${target.source_url})). ${vs}`);
  }
  const hw = f.hardware && !overclaim(f.hardware) ? quoteSafe(f.hardware, 240) : null, time = duration(f.runtime_s);
  if (hw || time) lines.push([hw ? `Hardware: ${hw}` : null, time ? `${hw ? "search" : "Search"} time ${time}` : null].filter(Boolean).join("; ") + ".");
  lines.push(`Checked on the server: two independent MD5 implementations recompute the result. Received ${new Date(f.received_at).toISOString().slice(0, 16).replace("T", " ")} UTC.`);
  lines.push(`[Submission #${f.submission_id}](${P}/submissions/${f.submission_id}) · [Track standings](${P}/tracks/${t.lane})`);
  return { title: `New record: ${t.display?.name ?? t.name}`.slice(0, 256), description: lines.join("\n").slice(0, 4000), url: `${P}/submissions/${f.submission_id}`, color: lead ? 0xc9a227 : 0x1565c0 };
}

/** Outbox rows for the project's record events since records_since that have none. Returns the ids created. */
export async function scanRecords(slug: string): Promise<number[]> {
  const rc = recordAnnounceConfig(readProjectConfig(slug)); const cfg = challengeConfig(slug);
  if (!rc.records || !rc.since || !cfg) return [];
  const p = await one<{ id: string }>(`SELECT id FROM problems WHERE slug = $1`, [slug]); if (!p) return [];
  const made: number[] = [];
  const evs = await q(`SELECT e.challenge_id, e.value, e.submission_id, s.user_id, s.received_at FROM challenge_events e JOIN challenge_submissions s ON s.id = e.submission_id
    WHERE e.problem_id = $1 AND e.namespace = 'live' AND e.kind = 'record' AND e.created_at >= $2
      AND NOT EXISTS (SELECT 1 FROM record_announcements r WHERE r.submission_id = e.submission_id) ORDER BY e.id`, [p.id, rc.since]);
  for (const e of evs) {
    if (!trackById(cfg, e.challenge_id)) continue;
    const due = new Date(new Date(e.received_at).getTime() + rc.hold_minutes * 60_000);
    const row = await one<{ id: string }>(`INSERT INTO record_announcements (problem_id, challenge_id, submission_id, finder_user_id, value, due_at)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (submission_id) DO NOTHING RETURNING id`, [p.id, e.challenge_id, e.submission_id, e.user_id, e.value, due]);
    if (row) made.push(Number(row.id));
  }
  return made;
}

async function send(fetchImpl: Fetch, url: string, method: string, body: any): Promise<any> {
  const r = await fetchImpl(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`webhook ${method} answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return method === "POST" ? r.json() : null;
}
const withPath = (u: URL, extra: string, wait: boolean): string => { const x = new URL(u.toString()); x.pathname = x.pathname.replace(/\/$/, "") + extra; if (wait) x.searchParams.set("wait", "true"); return x.toString(); };

export type RecordDispatch = { sent: number[]; suppressed: number[]; corrected: number[]; waiting: Record<string, string> };
/** One pass for one project. Safe from two containers at once: every send claims its row first. */
export async function dispatchRecords(slug: string, opts: { now?: Date; fetchImpl?: Fetch; env?: Record<string, string | undefined>; base?: string } = {}): Promise<RecordDispatch> {
  const now = opts.now ?? new Date(); const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as Fetch);
  const base = (opts.base ?? process.env.BASE_URL ?? "https://solveathome.org").replace(/\/$/, "");
  const out: RecordDispatch = { sent: [], suppressed: [], corrected: [], waiting: {} };
  const pc = readProjectConfig(slug), rc = recordAnnounceConfig(pc), cfg = challengeConfig(slug);
  if (!cfg) return out;
  const p = await one<{ id: string }>(`SELECT id FROM problems WHERE slug = $1`, [slug]); if (!p) return out;
  const hook = webhookUrl(announceConfig(pc), opts.env ?? process.env);
  const live = async (sid: string) => !!(await one(`SELECT 1 FROM challenge_submissions s WHERE s.id = $1 AND ${LIVE_SQL}`, [sid]));

  // A sent record whose submission was withdrawn: edit the post, then say so after it. Not rate-limited.
  for (const s of await q(`SELECT * FROM record_announcements WHERE problem_id = $1 AND status = 'sent' ORDER BY id`, [p.id])) {
    if (await live(s.submission_id)) continue;
    if (!hook || !s.discord_message_id) { out.waiting[s.id] = !hook ? "correction due; webhook unset" : "correction due; no message id to edit"; continue; }
    const why = await one(`SELECT note FROM challenge_corrections WHERE submission_id = $1 AND kind = 'void' ORDER BY id DESC LIMIT 1`, [s.submission_id]);
    const note = `Revisited ${day(now)}: submission #${s.submission_id} was withdrawn${why?.note ? ` (${quoteSafe(why.note, 200)})` : ""}.`;
    const claimed = await one(`UPDATE record_announcements SET status = 'corrected', corrected_at = $2, correction = $3 WHERE id = $1 AND status = 'sent' RETURNING id`, [s.id, now, note]);
    if (!claimed) continue;
    try {
      const e = s.payload?.embeds?.[0] ?? {};
      await send(fetchImpl, withPath(hook, `/messages/${s.discord_message_id}`, false), "PATCH", { embeds: [{ ...e, title: `[Withdrawn] ${String(e.title ?? "").slice(0, 240)}`, description: `**${note}** The record below no longer stands.\n\n~~${String(e.description ?? "").replace(/~~/g, "")}~~`.slice(0, 4000), color: 0x757575 }] });
      await send(fetchImpl, withPath(hook, "", true), "POST", { content: `Correction: ${note} The record post about it no longer stands. <${base}/projects/${slug}/submissions/${s.submission_id}>` });
      out.corrected.push(Number(s.id));
    } catch (err: any) {
      await q(`UPDATE record_announcements SET status = 'sent', corrected_at = NULL, correction = NULL WHERE id = $1`, [s.id]);
      console.error(`record posts ${slug}: correction of #${s.id} failed, will retry:`, err?.message ?? err);
    }
  }

  const views = new Map<string, Awaited<ReturnType<typeof trackView>>>();
  for (const h of await q(`SELECT * FROM record_announcements WHERE problem_id = $1 AND status = 'held' ORDER BY id`, [p.id])) {
    const track = trackById(cfg, h.challenge_id);
    const drop = async (why: string) => { await q(`UPDATE record_announcements SET status = 'suppressed', suppressed_reason = $2 WHERE id = $1 AND status = 'held'`, [h.id, why]); out.suppressed.push(Number(h.id)); };
    if (!track) { await drop("the track is no longer in project.json"); continue; }
    if (!views.has(track.id)) views.set(track.id, await trackView(Number(p.id), track, "live"));
    const view = views.get(track.id)!;
    const i = view.steps.findIndex((st) => st.submission_id === Number(h.submission_id));
    if (i < 0) { await drop(`before posting: submission #${h.submission_id} is not a record in the current view${(await live(h.submission_id)) ? "" : " (withdrawn)"}`); continue; }
    if (i < view.steps.length - 1) { await drop(`before posting: passed by #${view.steps.at(-1)!.submission_id}, which is posted instead`); continue; }
    if (new Date(h.due_at) > now) { out.waiting[h.id] = `hold until ${new Date(h.due_at).toISOString()}`; continue; }
    if (!rc.records) { out.waiting[h.id] = "record posts are off for this project"; continue; }
    if (!hook) { out.waiting[h.id] = "webhook unset"; continue; }
    const n = await one<{ n: string }>(`SELECT count(*) AS n FROM record_announcements WHERE problem_id = $1 AND sent_at > $2::timestamptz - interval '24 hours'`, [p.id, now]);
    if (Number(n?.n ?? 0) >= rc.max_per_day) { out.waiting[h.id] = `daily limit (${rc.max_per_day})`; continue; }
    const s = await one(`SELECT s.hardware, s.runtime_s, s.received_at, u.handle FROM challenge_submissions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`, [h.submission_id]);
    const step = view.steps[i];
    const post = buildRecordPost({ track, slug, base, submission_id: step.submission_id, value: step.value, handle: s.handle, received_at: s.received_at, previous: view.steps[i - 1] ?? null, hardware: s.hardware, runtime_s: s.runtime_s === null ? null : Number(s.runtime_s) });
    const payload = { embeds: [post] };
    const claimed = await one(`UPDATE record_announcements SET status = 'sent', sent_at = $2, payload = $3 WHERE id = $1 AND status = 'held' RETURNING id`, [h.id, now, JSON.stringify(payload)]);
    if (!claimed) continue;
    try {
      const msg = await send(fetchImpl, withPath(hook, "", true), "POST", payload);
      await q(`UPDATE record_announcements SET discord_message_id = $2 WHERE id = $1`, [h.id, msg?.id ? String(msg.id) : null]);
      out.sent.push(Number(h.id));
    } catch (err: any) {
      await q(`UPDATE record_announcements SET status = 'held', sent_at = NULL, payload = NULL WHERE id = $1`, [h.id]);
      out.waiting[h.id] = `send failed: ${err?.message ?? err}`;
      console.error(`record posts ${slug}: send of #${h.id} failed, will retry:`, err?.message ?? err);
    }
  }
  return out;
}

let running = false;
/** The periodic pass (server.ts, beside announceTick): scan, then dispatch per project. ANNOUNCE_ENABLED=0 stops both. */
export async function recordTick(): Promise<void> {
  if (running || !announceEnabled()) return;
  running = true;
  try { for (const s of recordSlugs()) { await scanRecords(s); await dispatchRecords(s); } } finally { running = false; }
}
