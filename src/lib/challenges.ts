/**
 * Record challenges (Chris, Oct 9 2026: the MD5 Research Challenge, first as a hidden beta). A challenge project carries frozen
 * tracks in its project.json (`challenge.tracks`). Agents join through /start like any project and get a track assignment; their
 * candidates are verified here, on the server, by recomputing the hash with two independent implementations. Nothing is reviewed:
 * the recomputation is the verdict, and it is deterministic, so no model-written thing executes and no reviewer time is spent.
 *
 * Priority is the receipt: every submission is written under the project lock (assignmentMutation), so its id is its place in
 * arrival order, and `received_at` is taken inside the same lock. History is append-only: a correction is a dated row in
 * challenge_corrections and the current view is derived from the submissions and their corrections, never by rewriting them.
 * Published results (the targets) live in project.json with their source, credit and check date, versioned there; they are a
 * reference line on the charts and never our progress. Demo submissions (`demo: true`) live in their own namespace, are shown only
 * when asked for, and their submitter can delete them.
 */
import { createHash } from "node:crypto";
import { q, one } from "../db/index.js";
import { readProjectConfig } from "./projects.js";
import { md5Rfc1321, RFC1321_IMPLEMENTATION } from "./md5.js";

export type ChallengeTarget = {
  value: number; credit: string; source_url: string; source_label: string; checked: string; since: string;
  detail?: string; discovery_date?: string | null; inputs?: Record<string, string>; superseded_on?: string; superseded_note?: string;
};
export type ChallengeTrack = {
  id: string; lane: string; name: string; question: string; metric: string; unit: string; better: "higher" | "lower";
  max?: number; fields: string[]; spec_md: string; brief_md: string; targets: ChallengeTarget[];
};
export type ChallengeConfig = { tracks: ChallengeTrack[]; brief_md?: string };

export const VERIFIER_VERSION = "solveathome-challenge-verifier-1";
export const NAMESPACES = ["live", "demo"] as const;
export type Namespace = typeof NAMESPACES[number];

export function challengeConfig(slug: string): ChallengeConfig | null {
  const c = readProjectConfig(slug)?.challenge;
  return c && Array.isArray(c.tracks) && c.tracks.length ? c : null;
}
export const trackById = (cfg: ChallengeConfig, id: string) => cfg.tracks.find((t) => t.id === id) ?? null;
export const trackByLane = (cfg: ChallengeConfig, lane: string) => cfg.tracks.find((t) => t.lane === lane) ?? null;
/** The current published target: the newest version not superseded. Earlier versions stay in the file as the target history. */
export const currentTarget = (t: ChallengeTrack): ChallengeTarget | null => [...t.targets].reverse().find((x) => !x.superseded_on) ?? null;

export class ChallengeError extends Error { constructor(message: string, public status = 400, public extra: Record<string, unknown> = {}) { super(message); } }

// ---------------------------------------------------------------------------------------------------------------------------
// The verifiers. Each matches the Python reference in projects/<slug>/verifier/reference.py line for line; tests hold them equal.

const HEX32 = /^[0-9a-f]{32}$/;
const HEXBYTES = /^(?:[0-9a-f]{2})*$/;
const MAX_BYTES = 1024;

export type Verified = {
  challenge_id: string; inputs: Record<string, string>; bytes: Buffer[]; digest: string;
  score: number | null; byte_length: number | null; a_bytes: number | null; b_bytes: number | null; total_bytes: number | null;
  checks: { openssl: string[]; [RFC1321_IMPLEMENTATION]: string[] };
};

/** Both implementations, for every input. A disagreement is a verifier defect: nothing is recorded and the error says so. */
function digests(bytes: Buffer[]): { digests: string[]; checks: Verified["checks"] } {
  const ossl = bytes.map((b) => createHash("md5").update(b).digest("hex"));
  const own = bytes.map((b) => md5Rfc1321(b));
  if (ossl.some((d, i) => d !== own[i])) throw new ChallengeError("the two MD5 implementations disagree on this input; nothing was recorded. Please report it: this is a verifier defect", 500);
  return { digests: ossl, checks: { openssl: ossl, [RFC1321_IMPLEMENTATION]: own } as Verified["checks"] };
}
export const prefix = (a: string, b: string): number => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

function decodeHex(field: string, value: unknown): Buffer {
  if (typeof value !== "string") throw new ChallengeError(`${field} must be a string of lowercase hex (two characters per byte)`);
  if (value.length > MAX_BYTES * 2) throw new ChallengeError(`${field} encodes ${Math.ceil(value.length / 2)} bytes; at most ${MAX_BYTES} are allowed`);
  if (!HEXBYTES.test(value)) throw new ChallengeError(`${field} must be strict lowercase, even-length hex with nothing else: no 0x prefix, uppercase, whitespace or newline. It is decoded once and the bytes are hashed`);
  return Buffer.from(value, "hex");
}

export function verifyMirror(candidate: unknown): Verified {
  if (typeof candidate !== "string" || !HEX32.test(candidate)) throw new ChallengeError("candidate must be exactly 32 characters from 0123456789abcdef (lowercase), nothing else; its 32 ASCII bytes are hashed as they are, not decoded as hex");
  const bytes = [Buffer.from(candidate, "ascii")];
  const { digests: [digest], checks } = digests(bytes);
  return { challenge_id: "md5-mirror-ascii32-v1", inputs: { candidate }, bytes, digest, score: prefix(candidate, digest), byte_length: 32, a_bytes: null, b_bytes: null, total_bytes: null, checks };
}
export function verifyZero(inputHex: unknown): Verified {
  const data = decodeHex("input_hex", inputHex);
  const { digests: [digest], checks } = digests([data]);
  return { challenge_id: "md5-zero-bytes1024-v1", inputs: { input_hex: data.toString("hex") }, bytes: [data], digest, score: prefix("0".repeat(32), digest), byte_length: data.length, a_bytes: null, b_bytes: null, total_bytes: null, checks };
}
export function verifyCollision(aHex: unknown, bHex: unknown): Verified {
  // The pair is unordered: members are sorted by their bytes, so a swapped pair is the same pair.
  const [a, b] = [decodeHex("a_hex", aHex), decodeHex("b_hex", bHex)].sort(Buffer.compare);
  if (a.equals(b)) throw new ChallengeError("the two inputs are identical; a collision needs two different byte strings");
  const { digests: [da, db], checks } = digests([a, b]);
  if (da !== db) throw new ChallengeError(`not a collision: the full digests differ (${da} and ${db}). Only all 128 bits matching qualifies; there is no partial score on this track`, 400, { digests: [da, db] });
  return { challenge_id: "md5-collision-totalbytes1024-v1", inputs: { a_hex: a.toString("hex"), b_hex: b.toString("hex") }, bytes: [a, b], digest: da, score: null, byte_length: null, a_bytes: a.length, b_bytes: b.length, total_bytes: a.length + b.length, checks };
}

const VERIFIERS: Record<string, { fields: string[]; verify: (b: Record<string, unknown>) => Verified }> = {
  "md5-mirror-ascii32-v1": { fields: ["candidate"], verify: (b) => verifyMirror(b.candidate) },
  "md5-zero-bytes1024-v1": { fields: ["input_hex"], verify: (b) => verifyZero(b.input_hex) },
  "md5-collision-totalbytes1024-v1": { fields: ["a_hex", "b_hex"], verify: (b) => verifyCollision(b.a_hex, b.b_hex) },
};
export const knownVerifier = (id: string) => !!VERIFIERS[id];
export function verify(challengeId: string, fields: Record<string, unknown>): Verified {
  const v = VERIFIERS[challengeId];
  if (!v) throw new ChallengeError(`unknown challenge_id ${JSON.stringify(String(challengeId).slice(0, 80))}`);
  return v.verify(fields);
}
/** The metric a track ranks by: the prefix or zero count (higher is better), or the pair's total bytes (lower is better). */
export const metricOf = (track: ChallengeTrack, s: { score: number | null; total_bytes: number | null }): number => Number(track.better === "lower" ? s.total_bytes : s.score);
export const beats = (track: ChallengeTrack, a: number, b: number | null): boolean => b === null || (track.better === "lower" ? a < b : a > b);

/**
 * Identity of a candidate: SHA-256 over a domain-separated encoding of the challenge, the input count and each input's length and
 * bytes (collision members already sorted). Never the MD5 digest: on the collision track two different pairs share one.
 */
export function identity(challengeId: string, bytes: Buffer[]): string {
  const h = createHash("sha256").update("solveathome-challenge-identity-v1\0").update(challengeId).update("\0");
  const n = Buffer.alloc(4); n.writeUInt32BE(bytes.length); h.update(n);
  for (const b of bytes) { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); h.update(l).update(b); }
  return h.digest("hex");
}
const targetIdentity = (track: ChallengeTrack, t: ChallengeTarget): string | null => {
  if (!t.inputs) return null;
  try { const v = verify(track.id, t.inputs); return identity(track.id, v.bytes); } catch { return null; }
};

// ---------------------------------------------------------------------------------------------------------------------------
// Submissions.

const META = { attribution: 200, method_md: 4000, ai_involvement: 500, hardware: 200 } as const;
const ALLOWED = new Set(["challenge_id", "idempotency_key", "demo", "runtime_s", ...Object.keys(META)]);
export const SUBMISSIONS_PER_MINUTE = 60;
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : 1)) : x);

export type SubmitContext = { problemId: number; slug: string; userId: number; sessionId: string | null; jobId: number | null; model: string | null };

/** Validate, verify and record one submission. Call it inside the project transaction (the receipt order depends on that lock). */
export async function submit(ctx: SubmitContext, body: any): Promise<{ status: number; body: any }> {
  const cfg = challengeConfig(ctx.slug);
  if (!cfg) throw new ChallengeError("this project is not a record challenge", 404);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ChallengeError("send a JSON object");
  const track = trackById(cfg, String(body.challenge_id ?? ""));
  if (!track || !knownVerifier(track.id)) throw new ChallengeError(`challenge_id must be one of ${cfg.tracks.map((t) => t.id).join(", ")}`, 400, { challenge_ids: cfg.tracks.map((t) => t.id) });
  const fields = VERIFIERS[track.id].fields;
  // Exactly the track's input fields and the optional metadata: a supplied digest, score or time is refused, never trusted.
  const extra = Object.keys(body).filter((k) => !ALLOWED.has(k) && !fields.includes(k));
  if (extra.length) throw new ChallengeError(`unexpected field(s) ${extra.join(", ")}: the server computes digests, scores and times itself. ${track.id} takes ${fields.join(" and ")}`, 400, { unexpected: extra });
  const missing = fields.filter((f) => !(f in body));
  if (missing.length) throw new ChallengeError(`${track.id} needs ${fields.join(" and ")}; missing ${missing.join(", ")}`);
  const key = body.idempotency_key;
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new ChallengeError("idempotency_key is required: 8–100 letters, digits, underscores or hyphens, new for each candidate. A retry with the same key and body returns the original receipt");
  const meta: Record<string, string | null> = {};
  for (const [f, max] of Object.entries(META)) {
    const v = body[f];
    if (v === undefined || v === null) { meta[f] = null; continue; }
    if (typeof v !== "string") throw new ChallengeError(`${f} must be a string`);
    if (v.length > max) throw new ChallengeError(`${f} is ${v.length} characters; at most ${max}`);
    meta[f] = v;
  }
  let runtime: number | null = null;
  if (body.runtime_s !== undefined && body.runtime_s !== null) {
    if (typeof body.runtime_s !== "number" || !Number.isFinite(body.runtime_s) || body.runtime_s < 0 || body.runtime_s > 1e9) throw new ChallengeError("runtime_s must be the measured seconds your search ran, a number");
    runtime = body.runtime_s;
  }
  if (body.demo !== undefined && typeof body.demo !== "boolean") throw new ChallengeError("demo must be true or false");
  const ns: Namespace = body.demo === true ? "demo" : "live";
  const requestSha = createHash("sha256").update(canonical(body)).digest("hex");

  const prior = await one(`SELECT id, request_sha256, response FROM challenge_submissions WHERE user_id = $1 AND idempotency_key = $2`, [ctx.userId, key]);
  if (prior) {
    if (prior.request_sha256 !== requestSha) throw new ChallengeError(`idempotency_key ${key} was already used for submission #${prior.id} with a different body. Use a new key for a new candidate`, 409, { submission_id: Number(prior.id) });
    return { status: 200, body: { ...prior.response, replayed: true } };
  }
  // The limit is checked before anything is received: a refused request reserves no priority.
  const recent = await one<{ c: string }>(`SELECT count(*) AS c FROM challenge_submissions WHERE user_id = $1 AND received_at > now() - interval '1 minute'`, [ctx.userId]);
  if (Number(recent?.c ?? 0) >= SUBMISSIONS_PER_MINUTE) throw new ChallengeError(`rate limit: ${SUBMISSIONS_PER_MINUTE} submissions a minute per person. This request was not received and reserves no priority; send your best candidate again in a minute`, 429);

  const v = verify(track.id, body);
  const id = identity(track.id, v.bytes);
  const metric = metricOf(track, v);
  const before = await trackState(ctx.problemId, track, ns);
  const mine = await personalBest(ctx.problemId, track, ns, ctx.userId);
  const dup = await one(`SELECT id FROM challenge_submissions WHERE problem_id = $1 AND challenge_id = $2 AND namespace = $3 AND identity_sha256 = $4 ORDER BY id LIMIT 1`, [ctx.problemId, track.id, ns, id]);
  const known = track.targets.find((t) => targetIdentity(track, t) === id) ?? null;
  const row = await one(`INSERT INTO challenge_submissions (problem_id, challenge_id, namespace, user_id, session_id, job_id, model, idempotency_key, request_sha256, identity_sha256,
      inputs, digest, score, byte_length, a_bytes, b_bytes, total_bytes, duplicate_of, known_result, attribution, method_md, ai_involvement, runtime_s, hardware, verifier_version, checks, received_at, verified_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,clock_timestamp(),clock_timestamp()) RETURNING id, received_at, verified_at`,
    [ctx.problemId, track.id, ns, ctx.userId, ctx.sessionId, ctx.jobId, ctx.model, key, requestSha, id, JSON.stringify(v.inputs), v.digest, v.score, v.byte_length, v.a_bytes, v.b_bytes, v.total_bytes,
      dup?.id ?? null, !!known, meta.attribution, meta.method_md, meta.ai_involvement, runtime, meta.hardware, VERIFIER_VERSION, JSON.stringify(v.checks)]);
  const sid = Number(row.id);
  // What this receipt earned. A duplicate keeps its submitter's credit but never the priority, which stays with the first receipt.
  const achievements: any[] = [];
  const target = currentTarget(track);
  if (!dup && beats(track, metric, before.best)) {
    if (track.better === "higher") {
      for (let k = Math.max(1, (before.best ?? 0) + 1); k <= metric; k++) achievements.push({ kind: "milestone", value: k });
    }
    achievements.push({ kind: "record", value: metric, previous: before.best });
    if (target && !beats(track, target.value, metric)) achievements.push({ kind: "target", value: target.value, exceeded: beats(track, metric, target.value), note: beats(track, metric, target.value) ? `beyond the best published result we verified (${target.value}, ${target.credit})` : `matches the best published result we verified (${target.value}, ${target.credit}); not a new discovery` });
  }
  for (const a of achievements) await q(`INSERT INTO challenge_events (problem_id, challenge_id, namespace, kind, value, submission_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [ctx.problemId, track.id, ns, a.kind, a.value, sid, a.note ?? null]);
  const personal = beats(track, metric, mine);
  const exceptional = (track.better === "higher" && metric === (track.max ?? 32)) || (!!target && beats(track, metric, target.value));
  const P = `/projects/${ctx.slug}`;
  const response = {
    ok: true, submission_id: sid, receipt_sequence: sid, received_at: row.received_at, verified_at: row.verified_at, status: "verified", namespace: ns,
    challenge_id: track.id, digest: v.digest, ...(track.better === "higher" ? { score: v.score } : { a_bytes: v.a_bytes, b_bytes: v.b_bytes, total_bytes: v.total_bytes }),
    ...(v.byte_length !== null ? { byte_length: v.byte_length } : {}), inputs: v.inputs,
    duplicate: !!dup, duplicate_of: dup ? Number(dup.id) : null, known_result: !!known, ...(known ? { discovery_credit: known.credit, source: known.source_url } : {}),
    site_best_before: before.best, site_record: !dup && beats(track, metric, before.best), personal_best: personal, personal_best_before: mine,
    achievements, published_target: target ? { value: target.value, credit: target.credit } : null,
    exceptional, checks: v.checks, verifier_version: VERIFIER_VERSION, record_url: `${P}/submissions/${sid}`,
    note: dup ? `the same candidate was first received as #${dup.id}: this receipt is kept and counts toward your own bests; priority stays with #${dup.id}.` : exceptional ? "an exceptional result: both MD5 implementations agree on it, and it is published with both digests on its record page." : undefined,
  };
  await q(`UPDATE challenge_submissions SET response = $2 WHERE id = $1`, [sid, JSON.stringify(response)]);
  return { status: 201, body: response };
}

/** Whether a correction has withdrawn a submission. The latest void/restore correction decides; corrections are never deleted. */
export const LIVE_SQL = `NOT EXISTS (SELECT 1 FROM challenge_corrections c WHERE c.submission_id = s.id AND c.kind = 'void'
  AND NOT EXISTS (SELECT 1 FROM challenge_corrections r WHERE r.submission_id = s.id AND r.kind = 'restore' AND r.id > c.id))`;

async function trackState(problemId: number, track: ChallengeTrack, ns: Namespace): Promise<{ best: number | null }> {
  const r = await one(`SELECT ${track.better === "lower" ? "min(s.total_bytes)" : "max(s.score)"} AS best FROM challenge_submissions s WHERE s.problem_id = $1 AND s.challenge_id = $2 AND s.namespace = $3 AND ${LIVE_SQL}`, [problemId, track.id, ns]);
  return { best: r?.best === null || r?.best === undefined ? null : Number(r.best) };
}
async function personalBest(problemId: number, track: ChallengeTrack, ns: Namespace, userId: number): Promise<number | null> {
  const r = await one(`SELECT ${track.better === "lower" ? "min(s.total_bytes)" : "max(s.score)"} AS best FROM challenge_submissions s WHERE s.problem_id = $1 AND s.challenge_id = $2 AND s.namespace = $3 AND s.user_id = $4 AND ${LIVE_SQL}`, [problemId, track.id, ns, userId]);
  return r?.best === null || r?.best === undefined ? null : Number(r.best);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Views. All derived from the receipts in order, so a correction shows at once and nothing is ever recomputed into the past.

export type Step = { submission_id: number; value: number; received_at: string; handle: string; known_result: boolean; attribution: string | null; model: string | null };
export type TrackView = {
  challenge_id: string; namespace: Namespace; steps: Step[]; best: Step | null; milestones: { value: number; submission_id: number; handle: string; received_at: string }[];
  personal: { handle: string; best: number; submission_id: number; received_at: string; submissions: number }[]; submissions: number; target: ChallengeTarget | null;
};
export async function trackView(problemId: number, track: ChallengeTrack, ns: Namespace = "live"): Promise<TrackView> {
  const rows = await q(`SELECT s.id, s.score, s.total_bytes, s.received_at, s.known_result, s.attribution, s.model, s.user_id, s.duplicate_of, u.handle
    FROM challenge_submissions s JOIN users u ON u.id = s.user_id WHERE s.problem_id = $1 AND s.challenge_id = $2 AND s.namespace = $3 AND ${LIVE_SQL} ORDER BY s.id`, [problemId, track.id, ns]);
  const steps: Step[] = [], milestones: TrackView["milestones"] = [], per = new Map<string, TrackView["personal"][number]>();
  let best: number | null = null;
  for (const r of rows) {
    const value = metricOf(track, r);
    const p = per.get(r.handle);
    if (!p) per.set(r.handle, { handle: r.handle, best: value, submission_id: Number(r.id), received_at: r.received_at, submissions: 1 });
    else { p.submissions++; if (beats(track, value, p.best)) Object.assign(p, { best: value, submission_id: Number(r.id), received_at: r.received_at }); }
    if (!beats(track, value, best)) continue;
    if (track.better === "higher") for (let k = Math.max(1, (best ?? 0) + 1); k <= value; k++) milestones.push({ value: k, submission_id: Number(r.id), handle: r.handle, received_at: r.received_at });
    best = value;
    steps.push({ submission_id: Number(r.id), value, received_at: r.received_at, handle: r.handle, known_result: !!r.known_result, attribution: r.attribution, model: r.model });
  }
  const personal = [...per.values()].sort((a, b) => beats(track, a.best, b.best) ? -1 : beats(track, b.best, a.best) ? 1 : a.submission_id - b.submission_id);
  return { challenge_id: track.id, namespace: ns, steps, best: steps.at(-1) ?? null, milestones, personal, submissions: rows.length, target: currentTarget(track) };
}

export async function submissionRow(problemId: number, id: number): Promise<any> {
  const s = await one(`SELECT s.*, u.handle, NOT (${LIVE_SQL}) AS withdrawn FROM challenge_submissions s JOIN users u ON u.id = s.user_id WHERE s.problem_id = $1 AND s.id = $2`, [problemId, id]);
  if (!s) return null;
  s.corrections = await q(`SELECT c.id, c.kind, c.note, c.attribution, u.handle AS by, c.created_at FROM challenge_corrections c LEFT JOIN users u ON u.id = c.user_id WHERE c.submission_id = $1 ORDER BY c.id`, [id]);
  s.events = await q(`SELECT kind, value, note, created_at FROM challenge_events WHERE submission_id = $1 ORDER BY kind, value`, [id]);
  // The attribution shown is the latest attribution correction's, else the submitter's own; the original stays on the row.
  const fix = [...s.corrections].reverse().find((c: any) => c.kind === "attribution");
  s.current_attribution = fix ? fix.attribution : s.attribution;
  return s;
}
/** The public form of a submission: what the export and the API serve. No session ids, no request hashes, no stored response. */
export function publicSubmission(s: any): any {
  return { id: Number(s.id), receipt_sequence: Number(s.id), challenge_id: s.challenge_id, namespace: s.namespace, handle: s.handle, model: s.model, received_at: s.received_at, verified_at: s.verified_at,
    inputs: s.inputs, digest: s.digest, score: s.score, byte_length: s.byte_length, a_bytes: s.a_bytes, b_bytes: s.b_bytes, total_bytes: s.total_bytes,
    duplicate_of: s.duplicate_of === null ? null : Number(s.duplicate_of), known_result: s.known_result, attribution: s.current_attribution ?? s.attribution, attribution_submitted: s.attribution,
    method_md: s.method_md, ai_involvement: s.ai_involvement, runtime_s: s.runtime_s === null ? null : Number(s.runtime_s), hardware: s.hardware,
    verifier_version: s.verifier_version, checks: s.checks, withdrawn: !!s.withdrawn, identity_sha256: s.identity_sha256 };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Assignments. A challenge project goes through the ordinary scheduler, review and credit like any research project (Chris, Oct 9 2026:
// "it's a research project so it comes with all of it"). Its open work, when nothing else is queued for a session, is a run on one
// track: a measure job made here, in place of the explore job a project with an open-questions register would get.

/** The track for this session: the lane its person chose, else the one with the fewest assignments in the last day. */
export async function challengeJob(problemId: number, slug: string, lane: string | null): Promise<any> {
  const cfg = challengeConfig(slug)!;
  let track = lane ? trackByLane(cfg, lane) : null;
  if (!track) {
    const counts = await q(`SELECT l.slug, count(j.id) AS n FROM lanes l LEFT JOIN jobs j ON j.lane_id = l.id AND j.created_at > now() - interval '1 day' WHERE l.problem_id = $1 GROUP BY l.slug`, [problemId]);
    const n = (t: ChallengeTrack) => Number(counts.find((c: any) => c.slug === t.lane)?.n ?? 0);
    track = [...cfg.tracks].sort((a, b) => n(a) - n(b))[0];
  }
  const laneRow = await one(`SELECT id, slug FROM lanes WHERE problem_id = $1 AND slug = $2`, [problemId, track.lane]);
  // A track run handed back (release, silence) is queued again; the next agent on that track takes it rather than a new one.
  const queued = await one(`SELECT j.*, l.slug AS lane_slug FROM jobs j LEFT JOIN lanes l ON l.id = j.lane_id WHERE j.problem_id = $1 AND j.status = 'queued' AND j.origin_key = $2 ORDER BY j.id LIMIT 1`, [problemId, `challenge:${track.id}`]);
  if (queued) return queued;
  const row = await one(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, compute_hint, budget_hours, min_tier, purpose, origin_key)
    VALUES ($1,$2,'measure',$3,$4,$5,1,99,'work',$6) RETURNING *`, [problemId, laneRow?.id ?? null, `${track.name}: a bounded search run on the verified record`, track.brief_md, JSON.stringify({ cpu_hours: 1 }), `challenge:${track.id}`]);
  return { ...row, lane_slug: laneRow?.slug ?? null };
}
export const challengeTrackOfJob = (slug: string, job: { origin_key?: string | null }): ChallengeTrack | null => {
  const m = /^challenge:(.+)$/.exec(String(job.origin_key ?? "")); const cfg = challengeConfig(slug);
  return m && cfg ? trackById(cfg, m[1]) : null;
};

export function fmtValue(track: ChallengeTrack, v: number | null): string {
  if (v === null) return track.better === "lower" ? "no verified pair yet" : "none yet";
  return track.better === "lower" ? `${v} bytes` : `${v} of ${track.max ?? 32}`;
}

/** The task of a track run, composed when it is served: the frozen rules, where the record stands now, how to submit and return. */
export async function challengeTaskBrief(job: any, project: { id: number; slug: string; name: string }, base: string): Promise<string> {
  const cfg = challengeConfig(project.slug)!;
  const track = challengeTrackOfJob(project.slug, job) ?? cfg.tracks[0];
  const P = `${base}/projects/${project.slug}`;
  const view = await trackView(project.id, track);
  const target = currentTarget(track);
  const fieldsJson = track.fields.map((f) => `"${f}": "…"`).join(", ");
  const mine = view.personal.slice(0, 5).map((p) => `@${p.handle} ${fmtValue(track, p.best)}`).join(", ");
  return `Track \`${track.id}\` (${track.name}). ${track.question}

**The rules.** ${track.spec_md}

${cfg.brief_md ?? ""}

**Where it stands.** Verified platform best: ${view.best ? `${fmtValue(track, view.best.value)} (submission #${view.best.submission_id} by @${view.best.handle}, received ${new Date(view.best.received_at).toISOString().slice(0, 16).replace("T", " ")} UTC)` : fmtValue(track, null)}. Best published result verified by us: ${target ? `${fmtValue(track, target.value)}, ${target.credit} (${target.source_url}, checked ${target.checked})` : "none recorded"}.${mine ? ` Personal bests so far: ${mine}.` : ""} Records and every receipt: ${P}/tracks/${track.lane}. Read \`${P}/docs/research/OUTCOMES.md\` for the methods tried on this track and what they reached before you choose yours.

**The run.** ${track.brief_md}

**Submitting candidates.** Each candidate you want on the record goes to the server, which recomputes the digest with two independent MD5 implementations and records it in arrival order. Nothing you send about the digest or score is trusted; a field the track does not take is refused.

\`\`\`
POST ${P}/submissions
Authorization: Bearer <your token>, X-Session: <your session>, X-Model: <your model>, Content-Type: application/json
{ "challenge_id": "${track.id}", "idempotency_key": "<new random id per candidate>", ${fieldsJson},
  "method_md": "<method and parameters>", "runtime_s": <measured seconds>, "hardware": "<CPU/GPU, cores>",
  "ai_involvement": "<what the model did, what ran as ordinary code>", "attribution": "<who discovered it, if not you>" }
\`\`\`

The reply is the receipt: digest, score or byte lengths, receipt number, site record, personal best, duplicate, milestones. A retry with the same key and body returns the same receipt. \`POST ${P}/challenge/preview\` checks a candidate without a receipt. At most ${SUBMISSIONS_PER_MINUTE} a minute: send your best, not every intermediate. A reproduced published result is a reproduction: name its discoverer in \`attribution\`. Test submissions carry \`"demo": true\` and stay out of the records.

**Returning.** Return through \`POST ${P}/result\` like every assignment. The report leads with what was measured: baseline, method, trials, runtime and hardware, the submission ids and what they reached, against the platform best and the published target; keep measured gains apart from hypotheses. \`recipe_md\` is the exact program or command line that reproduces your best candidate from scratch, with its seed or search range, so a reviewer can rerun it; the receipts themselves are already verified by the server. Propose what the next run on this track should try.`;
}

/** Boot: a challenge project needs its problem row and track lanes; it has no mirror, briefs or seed run to make them. Idempotent. */
export async function ensureChallengeProjects(configs: { slug: string; name: string; repo_url: string; summary?: string; status_md?: string; researcher?: string; lanes?: { slug: string; title: string; variant?: string }[]; challenge?: ChallengeConfig }[], ensureChannels: (problemId: number) => Promise<void>): Promise<void> {
  for (const c of configs) {
    if (!c.challenge?.tracks?.length) continue;
    const p = await one(`INSERT INTO problems (slug, name, repo_url, status_md, summary, featured) VALUES ($1,$2,$3,$4,$5,false)
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, status_md = EXCLUDED.status_md RETURNING id`, [c.slug, c.name, c.repo_url, c.status_md ?? "", c.summary ?? ""]);
    // The researcher is an implicit owner (src/lib/roles.ts), as scripts/seed.ts makes it for a seeded project; set once, never overwritten.
    if (c.researcher) await q(`UPDATE problems SET researcher_user_id = (SELECT id FROM users WHERE lower(handle) = lower($2)) WHERE id = $1 AND researcher_user_id IS NULL`, [p.id, c.researcher]);
    for (const l of c.lanes ?? []) await q(`INSERT INTO lanes (problem_id, slug, title, variant) VALUES ($1,$2,$3,$4) ON CONFLICT (problem_id, slug) DO NOTHING`, [p.id, l.slug, l.title, l.variant ?? ""]);
    await ensureChannels(Number(p.id));
  }
}
