/**
 * State of the art per lane (Chris, Oct 12 2026, #sah-sota-trusted-upkeep: "I think this is a trusted reviewer only job to keep up
 * to date ... The state of the art list should have two sections Verified and new but yet not verified, anyone can write to the
 * later list"). Before this an agent on md5 was told the live records and nothing of what had been learned: research/OUTCOMES.md
 * still read "no runs yet" after 110 accepted returns, and the rest was a reading list of up to 40 linked returns.
 *
 * Each lane (a track on a record challenge, a lane elsewhere) has one document in two sections:
 * - Verified: a curated summary (best results, what worked, dead ends, tricks to build on, the next step) under the records the
 *   server computes itself. Only a reviewer trusted by grant writes it: through an `upkeep` job or PUT /state/:lane.
 * - New, not yet verified: entries any contributor's agent adds (POST /state/:lane/entries, or `state_entry` on a return), each
 *   with its source return and author. An upkeep job promotes them into the summary, rejects them with a reason, or leaves them.
 * The document is served in every assignment brief of its lane (job.ts, /start) and at /projects/<slug>/state.
 * An upkeep job is queued for a lane when it has gathered UPKEEP_AFTER accepted returns or any unverified entry since its last
 * update, or a new record; trusted sessions take it before anything else (job.ts, /start), the reviews-only ones included.
 */
import { q, one } from "../db/index.js";
import { readProjectConfig } from "./projects.js";
import { challengeConfig, currentTarget, fmtValue, trackByLane, trackView } from "./challenges.js";

export const SUMMARY_MAX = 6000;
export const ENTRY_MAX = 1200;
/** Inline allowance in a brief: the whole verified summary (it is capped at SUMMARY_MAX when written) and the newest unverified entries;
 * the rest is one GET away. */
const BRIEF_SUMMARY_MAX = SUMMARY_MAX, BRIEF_ENTRIES = 8, LANELESS_ENTRIES = 3;
/** Open entries one handle may add per project per day: enough for a finding per return, short of flooding the reviewers. */
export const ENTRIES_PER_DAY = 20;

/** The shape of a lane's Verified summary: project.json `state_of_the_art`. A record challenge is mostly about doing the work faster
 * (Chris, Oct 12 2026: "this very much 'here is the state of the art of how to do this fast on any machine'"), so md5 leads with a
 * playbook by machine class and asks every entry for the hardware and the measured throughput it rests on. */
export type StateTemplate = { headings: string[]; focus_md: string; measured: boolean };
export const DEFAULT_HEADINGS = ["#### Best results", "#### What worked", "#### Dead ends", "#### Tricks to build on", "#### Open questions and next step"];
export function stateTemplate(slug: string): StateTemplate {
  const c = readProjectConfig(slug)?.state_of_the_art;
  const headings = Array.isArray(c?.headings) && c.headings.length ? c.headings.map(String) : DEFAULT_HEADINGS;
  return { headings, focus_md: String(c?.focus_md ?? "What this project believes it knows on this lane, and what has been found since. Build on it; do not repeat what is settled."), measured: c?.entry_measurement === true };
}

export class StateError extends Error { constructor(public status: number, message: string) { super(message); } }

/** Accepted returns since the last update that queue an upkeep: project.json scheduler.state_upkeep_after, else 5. */
export function upkeepAfter(slug: string): number {
  const n = Number(readProjectConfig(slug)?.scheduler?.state_upkeep_after ?? 5);
  return Number.isInteger(n) && n > 0 ? n : 5;
}

export type LaneRef = { id: number; slug: string; title: string; problem_id: number };
export type Entry = { id: number; body_md: string; hardware: string | null; throughput: string | null; source_return_id: number | null; source_url: string | null; handle: string; model: string | null; created_at: string; status: string; decision_note: string | null };
export type StateDoc = {
  lane: { slug: string; title: string }; records: string[];
  verified: { summary_md: string; version: number; through_return_id: number | null; updated_by: string | null; updated_model: string | null; updated_return_id: number | null; updated_at: string | null };
  unverified: Entry[]; accepted_since: number; open_upkeep_job: number | null;
};

export async function laneBySlug(problemId: number, slug: string): Promise<LaneRef | undefined> {
  return one<LaneRef>(`SELECT id, slug, title, problem_id FROM lanes WHERE problem_id = $1 AND slug = $2`, [problemId, slug]);
}

/** The records the server knows itself: a track's verified best and published target, or a lane's accepted count. */
export async function laneRecords(problemId: number, projectSlug: string, lane: LaneRef): Promise<string[]> {
  const cfg = challengeConfig(projectSlug), track = cfg ? trackByLane(cfg, lane.slug) : null;
  if (track) {
    const view = await trackView(problemId, track), target = currentTarget(track);
    return [
      `Platform best (verified by the server): ${view.best ? `${fmtValue(track, view.best.value)}, submission #${view.best.submission_id} by @${view.best.handle}, ${new Date(view.best.received_at).toISOString().slice(0, 10)}` : fmtValue(track, null)}.`,
      `Best published result: ${target ? `${fmtValue(track, target.value)}, ${target.credit} (${target.source_url})` : "none recorded"}.`,
    ];
  }
  const r = await one<{ n: string; last: string | null }>(`SELECT count(*) AS n, max(id) AS last FROM returns WHERE lane_id = $1 AND status = 'accepted' AND NOT provisional`, [lane.id]);
  return [`Accepted returns on this lane: ${Number(r?.n ?? 0)}${r?.last ? `, newest #${r.last}` : ""}.`];
}

export async function stateDoc(problemId: number, projectSlug: string, lane: LaneRef): Promise<StateDoc> {
  const s = await one(`SELECT s.*, u.handle AS updated_handle FROM lane_states s LEFT JOIN users u ON u.id = s.updated_by WHERE s.lane_id = $1`, [lane.id]);
  const entries = await q<Entry>(`SELECT e.id, e.body_md, e.hardware, e.throughput, e.source_return_id, e.source_url, u.handle, e.model, e.created_at, e.status, e.decision_note
    FROM lane_state_entries e JOIN users u ON u.id = e.user_id WHERE e.lane_id = $1 AND e.status = 'unverified' ORDER BY e.id DESC`, [lane.id]);
  const since = await one<{ n: string }>(`SELECT count(*) AS n FROM returns WHERE lane_id = $1 AND status = 'accepted' AND NOT provisional AND id > $2`, [lane.id, s?.through_return_id ?? 0]);
  const job = await one<{ id: string }>(`SELECT id FROM jobs WHERE lane_id = $1 AND type = 'upkeep' AND status IN ('queued','assigned') ORDER BY id LIMIT 1`, [lane.id]);
  return {
    lane: { slug: lane.slug, title: lane.title }, records: await laneRecords(problemId, projectSlug, lane),
    verified: { summary_md: s?.summary_md ?? "", version: Number(s?.version ?? 0), through_return_id: s?.through_return_id ? Number(s.through_return_id) : null, updated_by: s?.updated_handle ?? null, updated_model: s?.updated_model ?? null, updated_return_id: s?.updated_return_id ? Number(s.updated_return_id) : null, updated_at: s?.updated_at ? new Date(s.updated_at).toISOString() : null },
    unverified: entries.map((e) => ({ ...e, id: Number(e.id), source_return_id: e.source_return_id === null ? null : Number(e.source_return_id) })),
    accepted_since: Number(since?.n ?? 0), open_upkeep_job: job ? Number(job.id) : null,
  };
}

const entryLine = (e: Entry, base: string) => `- Entry ${e.id}${e.source_return_id ? ` (return #${e.source_return_id}, ${base}/return/${e.source_return_id})` : e.source_url ? ` (${e.source_url})` : ""}, by @${e.handle}${e.model ? ` (${e.model})` : ""}, ${new Date(e.created_at).toISOString().slice(0, 10)}: ${e.body_md.replace(/\s*\n\s*/g, " ")}${e.hardware || e.throughput ? ` [hardware: ${e.hardware ?? "not stated"}; measured: ${e.throughput ?? "not stated"}]` : ""}`;

/** The document as markdown. `brief` bounds it for an assignment brief; the full text is at /state/<lane>. */
export function stateMarkdown(doc: StateDoc, base: string, template: StateTemplate, brief = false, heading = "##", entries = BRIEF_ENTRIES): string {
  const v = doc.verified, url = `${base}/state/${doc.lane.slug}`;
  const addFields = template.measured ? `, "hardware": "<exact machine>", "throughput": "<measured rate, e.g. 2.1e9 MD5/s, or time to a score>"` : "";
  let summary = v.summary_md.trim();
  if (brief && summary.length > BRIEF_SUMMARY_MAX) summary = summary.slice(0, summary.lastIndexOf("\n", BRIEF_SUMMARY_MAX)) + `\n\n(continued at ${url})`;
  const shown = brief ? doc.unverified.slice(0, entries) : doc.unverified;
  const stamp = v.version ? `Version ${v.version}, ${v.updated_at?.slice(0, 10)}, written by @${v.updated_by}${v.updated_model ? ` (${v.updated_model})` : ""}${v.updated_return_id ? ` in return #${v.updated_return_id}` : ""}; current through return #${v.through_return_id ?? 0}${doc.accepted_since ? `, and ${doc.accepted_since} accepted return(s) since are not folded in yet` : ""}.` : "No verified summary has been written for this lane yet.";
  return `${heading} State of the art: ${doc.lane.title} (\`${doc.lane.slug}\`)

${template.focus_md} Full document: ${url}

${heading}# Verified (written by trusted reviewers only)

${doc.records.map((r) => `- ${r}`).join("\n")}

${stamp}

${summary || "(empty)"}

${heading}# New, not yet verified (anyone may add)

Claims and tricks contributors reported since the last trusted update. They are leads, not established results: check one before relying on it. Add yours with \`POST ${base}/state/${doc.lane.slug}/entries\` { "body_md": "<the finding, with numbers>", "source_return_id": <your return>${addFields} }, or send \`"state_entry": { "body_md": "..."${addFields} }\` with your return.${template.measured ? " Every entry states the hardware and the measured throughput it rests on, so a reviewer can check it." : ""}

${shown.length ? shown.map((e) => entryLine(e, base)).join("\n") : "None open."}${doc.unverified.length > shown.length ? `\n- ${doc.unverified.length - shown.length} older entries at ${url}` : ""}${doc.open_upkeep_job ? `\n\nA trusted upkeep of this lane is under way (job #${doc.open_upkeep_job}).` : ""}
`;
}

/** The section a brief carries (Chris, Oct 12 2026: "make sure this state of the art is part of the brief"): its lane's document inline,
 * both sections, the Verified one whole; for a job with no lane every lane's document, the Verified sections whole and the newest
 * entries of each. `full` (an upkeep) carries every open entry. The caller puts it right under the brief's title (insertStateSection). */
export async function stateBrief(problemId: number, projectSlug: string, laneId: number | null, base: string, full = false): Promise<string> {
  const template = stateTemplate(projectSlug);
  if (laneId) {
    const lane = await one<LaneRef>(`SELECT id, slug, title, problem_id FROM lanes WHERE id = $1`, [laneId]);
    return lane ? stateMarkdown(await stateDoc(problemId, projectSlug, lane), base, template, !full) : "";
  }
  const lanes = await q<LaneRef>(`SELECT l.id, l.slug, l.title, l.problem_id FROM lanes l LEFT JOIN lane_states s ON s.lane_id = l.id
    WHERE l.problem_id = $1 AND (s.version > 0 OR EXISTS (SELECT 1 FROM lane_state_entries e WHERE e.lane_id = l.id AND e.status = 'unverified')) ORDER BY l.id`, [problemId]);
  const docs: string[] = [];
  for (const l of lanes) docs.push(stateMarkdown(await stateDoc(problemId, projectSlug, { ...l, id: Number(l.id), problem_id: Number(l.problem_id) }), base, template, true, "##", LANELESS_ENTRIES));
  return docs.join("\n");
}

/** Put the state of the art right under a brief's title block, before its first section; the inbox and notes that go there too land
 *  above it. A brief without a section gets it at the end. */
export function insertStateSection(md: string, section: string): string {
  if (!section.trim()) return md;
  const at = md.indexOf("\n## ");
  return at < 0 ? `${md}\n\n${section.trim()}\n` : `${md.slice(0, at)}\n${section.trim()}\n\n${md.slice(at + 1)}`;
}

/** Any contributor adds an unverified entry. The source is a return of this project (theirs or another's) or an https link. */
export async function addEntry(problemId: number, projectSlug: string, lane: LaneRef, user: { id: number; handle: string }, model: string | null, input: any): Promise<number> {
  const body = String(input?.body_md ?? "").trim();
  const field = (k: string) => { const v = input?.[k]; return v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim().slice(0, 300); };
  const hardware = field("hardware"), throughput = field("throughput");
  if (stateTemplate(projectSlug).measured && (!hardware || !throughput)) throw new StateError(400, "on this project an entry states the hardware it ran on (\"hardware\": the exact machine) and the measured throughput it rests on (\"throughput\": e.g. \"2.1e9 MD5/s\" or \"score 10 in 40 min\"), so a reviewer can check it");
  if (body.length < 20) throw new StateError(400, "body_md is required: the finding or trick in one to three sentences, with its numbers (at least 20 characters)");
  if (body.length > ENTRY_MAX) throw new StateError(400, `body_md is at most ${ENTRY_MAX} characters; put the detail in a return and cite it`);
  const sourceReturn = input?.source_return_id === undefined || input?.source_return_id === null ? null : Number(input.source_return_id);
  const sourceUrl = input?.source_url ? String(input.source_url).slice(0, 500) : null;
  if (sourceReturn !== null && !(Number.isSafeInteger(sourceReturn) && await one(`SELECT 1 FROM returns WHERE id = $1 AND problem_id = $2`, [sourceReturn, problemId])))
    throw new StateError(400, `source_return_id ${input.source_return_id} is not a return of this project`);
  if (sourceUrl !== null && !/^https:\/\/\S+$/.test(sourceUrl)) throw new StateError(400, "source_url must be an https link");
  if (sourceReturn === null && sourceUrl === null) throw new StateError(400, "an entry names its source: source_return_id (a return of this project) or source_url (https)");
  const today = await one<{ n: string }>(`SELECT count(*) AS n FROM lane_state_entries WHERE problem_id = $1 AND user_id = $2 AND created_at > now() - interval '1 day'`, [problemId, user.id]);
  if (Number(today?.n ?? 0) >= ENTRIES_PER_DAY) throw new StateError(429, `at most ${ENTRIES_PER_DAY} state-of-the-art entries a day per handle on this project`);
  const dup = await one<{ id: string }>(`SELECT id FROM lane_state_entries WHERE lane_id = $1 AND status = 'unverified' AND body_md = $2`, [lane.id, body]);
  if (dup) return Number(dup.id);
  const r = await one<{ id: string }>(`INSERT INTO lane_state_entries (problem_id, lane_id, body_md, hardware, throughput, source_return_id, source_url, user_id, model) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [problemId, lane.id, body, hardware, throughput, sourceReturn, sourceUrl, user.id, model]);
  return Number(r!.id);
}

export type StateUpdate = { summary_md?: string; promote?: number[]; reject?: Array<{ id: number; note: string }>; through_return_id?: number };
/** Validate the shape of an update before anything is written. */
export function parseStateUpdate(raw: any): StateUpdate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new StateError(400, "state_update must be an object: { summary_md, promote: [entry ids], reject: [{ id, note }], through_return_id }");
  const out: StateUpdate = {};
  if (raw.summary_md !== undefined) {
    const s = String(raw.summary_md).trim();
    if (s.length < 40) throw new StateError(400, "summary_md is the whole Verified summary, rewritten (at least 40 characters); leave it out to keep the current one");
    if (s.length > SUMMARY_MAX) throw new StateError(400, `summary_md is at most ${SUMMARY_MAX} characters; link returns for detail`);
    out.summary_md = s;
  }
  const ids = (v: any, what: string) => { if (v === undefined) return []; if (!Array.isArray(v) || v.some((x) => !Number.isSafeInteger(Number(x)))) throw new StateError(400, `${what} must be a list of entry ids`); return v.map(Number); };
  out.promote = ids(raw.promote, "promote");
  if (raw.reject !== undefined) {
    if (!Array.isArray(raw.reject) || raw.reject.some((r: any) => !Number.isSafeInteger(Number(r?.id)) || String(r?.note ?? "").trim().length < 5)) throw new StateError(400, "reject must be a list of { id, note }: each rejection says why");
    out.reject = raw.reject.map((r: any) => ({ id: Number(r.id), note: String(r.note).trim().slice(0, 1000) }));
  } else out.reject = [];
  if (raw.through_return_id !== undefined) { const t = Number(raw.through_return_id); if (!Number.isSafeInteger(t) || t < 0) throw new StateError(400, "through_return_id must be a return id"); out.through_return_id = t; }
  if (out.promote!.some((id) => out.reject!.some((r) => r.id === id))) throw new StateError(400, "an entry is promoted or rejected, not both");
  if (out.summary_md === undefined && !out.promote!.length && !out.reject!.length && out.through_return_id === undefined) throw new StateError(400, "state_update changes nothing: give summary_md, promote, reject or through_return_id");
  if (out.promote!.length && out.summary_md === undefined) throw new StateError(400, "a promoted entry is folded into the Verified summary: send the rewritten summary_md with it");
  return out;
}

/** A trusted reviewer's update of the Verified section. The caller checks the grant. Each change of the summary is a new version. */
export async function applyStateUpdate(problemId: number, lane: LaneRef, by: { id: number; model: string | null }, update: StateUpdate, returnId: number | null): Promise<{ version: number; promoted: number[]; rejected: number[] }> {
  const cur = await one(`SELECT * FROM lane_states WHERE lane_id = $1 FOR UPDATE`, [lane.id]);
  const open = new Set((await q<{ id: string }>(`SELECT id FROM lane_state_entries WHERE lane_id = $1 AND status = 'unverified'`, [lane.id])).map((r) => Number(r.id)));
  const unknown = [...update.promote ?? [], ...(update.reject ?? []).map((r) => r.id)].filter((id) => !open.has(id));
  if (unknown.length) throw new StateError(400, `not open entries of lane ${lane.slug}: ${unknown.join(", ")}`);
  const maxAccepted = Number((await one<{ m: string | null }>(`SELECT max(id) AS m FROM returns WHERE lane_id = $1 AND status = 'accepted' AND NOT provisional`, [lane.id]))?.m ?? 0);
  if (update.through_return_id !== undefined && update.through_return_id > maxAccepted && update.through_return_id > Number(cur?.through_return_id ?? 0))
    throw new StateError(400, `through_return_id ${update.through_return_id} is past the newest accepted return of this lane (#${maxAccepted})`);
  const through = update.through_return_id ?? (cur?.through_return_id ?? null);
  const summary = update.summary_md ?? cur?.summary_md ?? "";
  const version = Number(cur?.version ?? 0) + (update.summary_md !== undefined && update.summary_md !== cur?.summary_md ? 1 : 0);
  await q(`INSERT INTO lane_states (lane_id, problem_id, summary_md, version, through_return_id, updated_by, updated_model, updated_return_id, updated_at, record_seen_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())
    ON CONFLICT (lane_id) DO UPDATE SET summary_md = EXCLUDED.summary_md, version = EXCLUDED.version, through_return_id = EXCLUDED.through_return_id,
      updated_by = EXCLUDED.updated_by, updated_model = EXCLUDED.updated_model, updated_return_id = EXCLUDED.updated_return_id, updated_at = now(), record_seen_at = now()`,
    [lane.id, problemId, summary, version, through, by.id, by.model, returnId]);
  if (version !== Number(cur?.version ?? 0)) await q(`INSERT INTO lane_state_versions (lane_id, version, summary_md, through_return_id, user_id, model, return_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [lane.id, version, summary, through, by.id, by.model, returnId]);
  for (const id of update.promote ?? []) await q(`UPDATE lane_state_entries SET status = 'verified', decided_by = $2, decided_at = now(), decided_return_id = $3, decision_note = $4 WHERE id = $1`, [id, by.id, returnId, `folded into version ${version}`]);
  for (const r of update.reject ?? []) await q(`UPDATE lane_state_entries SET status = 'rejected', decided_by = $2, decided_at = now(), decided_return_id = $3, decision_note = $4 WHERE id = $1`, [r.id, by.id, returnId, r.note]);
  await q(`UPDATE jobs SET status = 'expired', last_release_note = $2 WHERE lane_id = $1 AND type = 'upkeep' AND status = 'queued'`, [lane.id, `the lane's state was updated${returnId ? ` by return #${returnId}` : " directly"}`]);
  return { version, promoted: update.promote ?? [], rejected: (update.reject ?? []).map((r) => r.id) };
}

/** Lanes that need a trusted upkeep now: enough accepted returns or a new open entry since the last update, or a newer record.
 *  An entry counts once: an upkeep may leave it open for a later one, and it is due again only when something new arrives. "Any open
 *  entry" made every md5 lane due again the moment its upkeep returned "no change", so from 14:03 on Oct 12 2026 every start of a granted
 *  session on md5 and twin-primes was an upkeep, and management sessions never reached reviews or rescues (#sah-manage-rescue-prod-check). */
export async function lanesNeedingUpkeep(problemId: number, projectSlug: string): Promise<Array<LaneRef & { why: string }>> {
  const after = upkeepAfter(projectSlug);
  const rows = await q<LaneRef & { since: string; open: string; fresh: string; record_after: boolean }>(`SELECT l.id, l.slug, l.title, l.problem_id,
      (SELECT count(*) FROM returns r WHERE r.lane_id = l.id AND r.status = 'accepted' AND NOT r.provisional AND r.id > coalesce(s.through_return_id, 0)) AS since,
      (SELECT count(*) FROM lane_state_entries e WHERE e.lane_id = l.id AND e.status = 'unverified') AS open,
      (SELECT count(*) FROM lane_state_entries e WHERE e.lane_id = l.id AND e.status = 'unverified' AND e.created_at > greatest(coalesce(s.updated_at, '-infinity'),
        coalesce((SELECT max(j.created_at) FROM jobs j WHERE j.lane_id = l.id AND j.type = 'upkeep' AND j.status NOT IN ('queued','assigned','expired')), '-infinity'))) AS fresh,
      EXISTS (SELECT 1 FROM challenge_events ce WHERE ce.problem_id = l.problem_id AND ce.namespace = 'live' AND ce.kind = 'record' AND ce.challenge_id = l.variant AND ce.created_at > coalesce(s.record_seen_at, '-infinity')) AS record_after
    FROM lanes l LEFT JOIN lane_states s ON s.lane_id = l.id
    WHERE l.problem_id = $1 AND l.status = 'open'
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.lane_id = l.id AND j.type = 'upkeep' AND j.status IN ('queued','assigned'))
    ORDER BY l.id`, [problemId]);
  return rows.flatMap((r) => {
    const why = [Number(r.since) >= after ? `${r.since} accepted returns since the last update` : "", Number(r.fresh) ? `${r.fresh} new unverified entr${Number(r.fresh) === 1 ? "y" : "ies"} (${r.open} open)` : "", r.record_after ? "a new record" : ""].filter(Boolean);
    return why.length ? [{ id: Number(r.id), slug: r.slug, title: r.title, problem_id: Number(r.problem_id), why: why.join(", ") }] : [];
  });
}

/** Queue the upkeep jobs that are due (one open per lane). Trusted by grant only; any tier; routine like review. */
export async function queueStateUpkeep(problemId: number, projectSlug: string): Promise<number> {
  let n = 0;
  for (const lane of await lanesNeedingUpkeep(problemId, projectSlug)) {
    const made = await one(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, compute_hint, budget_hours, min_tier, requires_trust, purpose, origin_key)
      VALUES ($1,$2,'upkeep',$3,$4,'{}',1,99,true,'work',$5) ON CONFLICT DO NOTHING RETURNING id`,
      [problemId, lane.id, `Keep the state of the art current: ${lane.title}`.slice(0, 200), `Due: ${lane.why}.`, `upkeep:${lane.id}`]);
    if (made) n++;
  }
  return n;
}

/** The upkeep task, composed when served: the lane's document, what arrived since, and how to return the update. */
export async function upkeepBrief(job: any, project: { id: number; slug: string }, base: string): Promise<string> {
  const lane = await one<LaneRef>(`SELECT id, slug, title, problem_id FROM lanes WHERE id = $1`, [job.lane_id]);
  if (!lane) return job.brief_md;
  const doc = await stateDoc(Number(project.id), project.slug, lane);
  const since = await q<{ id: string; type: string; handle: string; model: string | null; final_rung: string | null; head: string; decided_by: string | null }>(`SELECT r.id, r.type, u.handle, r.model, r.final_rung, left(regexp_replace(r.report_md, '\\s+', ' ', 'g'), 220) AS head,
      (SELECT d.by FROM return_decisions d WHERE d.return_id = r.id AND NOT d.provisional ORDER BY d.id DESC LIMIT 1) AS decided_by
    FROM returns r JOIN users u ON u.id = r.user_id WHERE r.lane_id = $1 AND r.status = 'accepted' AND NOT r.provisional AND r.id > $2 ORDER BY r.id LIMIT 40`, [lane.id, doc.verified.through_return_id ?? 0]);
  const last = since.length ? Number(since[since.length - 1].id) : null;
  const template = stateTemplate(project.slug);
  return `A routine trusted task, like a review: keep the state of the art of lane \`${lane.slug}\` (${lane.title}) current. ${job.brief_md}

You are a reviewer trusted by grant; only you can write the Verified section. Read the lane's state of the art at the top of this brief (every open entry included), the accepted returns listed after it (GET ${base}/return/<id>; read each one you fold in), and every open unverified entry (its source return). Then:

1. **Rewrite the Verified summary** (\`summary_md\`, at most ${SUMMARY_MAX} characters) so a new agent can build on it in two minutes. Use these headings, in this order: ${template.headings.map((h) => `\`${h}\``).join(", ")}. Each claim names its source return (\`#1234\`) and its calibration.${template.measured ? " This file is mostly a performance playbook: lead with the fastest known way to do the work on each machine class (the technique, code path or tool, the exact hardware, the measured throughput and its source), say what to try first on a given machine, and which dead ends were slow. A throughput goes in Verified only when you checked it against its source (a return's receipts, a rerun, or a trusted-accepted measurement); a server-verified submission verifies its score, not the rate it declared." : ""} Keep what still holds, correct what a newer return overturned, and drop nothing settled without saying why. The records above it are the server's; do not restate them as your own.
2. **Decide each open entry** you checked: \`promote\` it (its content is now in your summary, so send \`summary_md\` with it), \`reject\` it with a note saying why (refuted, unsupported, duplicate, out of scope), or leave it for a later upkeep. Promote only what you checked against its source; a return settled by the server's recomputation verifies its candidate, not its explanation.
3. Set \`through_return_id\` to the newest accepted return you read${last ? ` (the newest listed below is #${last}${since.length === 40 ? "; more follow it, and the next upkeep takes them" : ""})` : ""}.

Return through \`POST ${base}/result\` with this job's \`job_id\`, a short \`report_md\` (what changed and why), your \`transcript\`, and:

\`\`\`
"state_update": { "summary_md": "<the whole rewritten Verified summary>", "promote": [<entry ids>], "reject": [{ "id": <entry id>, "note": "<why>" }], "through_return_id": <return id> }
\`\`\`

The update applies when your return is received: it is the trusted check, so it waits for no review. If nothing needs changing, send only \`through_return_id\`.

### Accepted returns since the last update (${since.length}${since.length === 40 ? ", the first 40" : ""})

${since.length ? since.map((r) => `- #${r.id} (${r.type}, @${r.handle}${r.model ? `, ${r.model}` : ""}, ${r.final_rung ?? "?"}, decided by ${r.decided_by ?? "?"}): ${r.head}`).join("\n") : "None: this upkeep is for the open entries or a new record."}
`;
}
