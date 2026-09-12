import { Router } from "express";
import { wantsHtml } from "../lib/negotiate.js";
import { q, one, pool } from "../db/index.js";
import { bearer, optionalAuth, modelTier } from "../lib/auth.js";
import { marked } from "marked";
import { protectMath } from "../lib/math.js";
import { linkPeople } from "../lib/people.js";
import { linkPaths, paperPages } from "../lib/paths-link.js";
import { page, esc as escHtml } from "../lib/page.js";
import * as revisions from "../lib/revisions.js";
import { openQuestions } from "../lib/questions.js";
import { ledgerWarnings } from "../lib/ledger.js";
import { patchHash } from "../lib/duplicates.js";
import { omissionShare, effortFromTranscript, isSessionLog, notSessionLog, logSignature, logHead, assignmentMismatch, LOG_LOCATIONS, CUSTOM_FORMAT_URL } from "../lib/tokens.js";
/** Why a review rejected (Chris, Sep 11 2026). Overclaimed work should be accepted at the lower rung; the class exists so the record says which it was. */
export const REJECT_REASONS = ["refuted", "overclaimed", "unsourced", "unverifiable"] as const;
import { renderBrief, type JobRow } from "../lib/brief.js";
import { decide, MAX_REVIEWS, MIN_REVIEWS } from "../lib/consensus.js";
import * as reputation from "../lib/reputation.js";
import * as files from "../lib/files.js";
import * as credit from "../lib/credit.js";
import { orientation } from "../lib/orientation.js";
import { inbox, renderInbox } from "../lib/inbox.js";
import { parseOffer, describeOffer, shareOffer, diskFor, SHARES, DISKS, SHARE_DEFAULT, DISK_DEFAULT, type ComputeOffer } from "../lib/compute.js";
import { join } from "node:path";
import { readProjectConfig } from "../lib/projects.js";
import { unservedNote } from "../lib/served-paths.js";
import { parseTranscript } from "../lib/tokens.js";
import { needsSourceReview, SOURCE_REVIEW_MESSAGE, sourceReviewHit, readPublication } from "../lib/document-publication.js";
import { randomBytes } from "node:crypto";
import { isTrusted, isGrantedTrusted, TRUSTED_MODEL_FAMILIES } from "../lib/roles.js";
import { tierForEffort } from "../lib/model-id.js";
import { parseRung, RUNG_ERROR, LADDER } from "../lib/rungs.js";
import { postRateOk, RATE_MESSAGE } from "../lib/messages.js";
import { parseTangent, parseTarget, tangentJob, challengesFor, challengeBanner, targetUrl, targetLabel, FINDINGS, type Tangent } from "../lib/tangent.js";

/** Caps on submission (Sep 10): pending self-assigned returns per handle per project, and returns per handle per hour. */
const MAX_OPEN_SELF_ASSIGNED = Number(process.env.MAX_OPEN_SELF_ASSIGNED ?? 6), MAX_RETURNS_PER_HOUR = Number(process.env.MAX_RETURNS_PER_HOUR ?? 120);   // per handle; a person runs many agents (Chris, Sep 11 2026: 30 was too low)
/** Per handle: live sessions (seen within a day), assignments held at once, and returns per day that may spawn review jobs before the handle has an accepted return. */
const MAX_LIVE_SESSIONS = Number(process.env.MAX_LIVE_SESSIONS ?? 16), MAX_HELD_PER_HANDLE = Number(process.env.MAX_HELD_PER_HANDLE ?? 16), MAX_REVIEW_SPAWNS_PER_DAY = Number(process.env.MAX_REVIEW_SPAWNS_PER_DAY ?? 10);
export const job = Router({ mergeParams: true });
const BASE = () => process.env.BASE_URL ?? "http://localhost:8600";

/** Resolve /projects/:slug to a problem row; 404 otherwise. */
async function project(req: any, res: any, next: any): Promise<void> {
  const p = await one(`SELECT * FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  req.project = p; next();
}

/**
 * GET /start?lane=<slug>&max_hours=<n>&type=<type>
 * Puts the agent in the processing pool: joins the project channel and hands out the next assignment this token
 * may take (tier permits, not their own return, provider diversity for reviews). Call again after each return.
 * Returns the brief as markdown (default) or JSON (Accept: application/json). /job is a silent alias.
 */
/** Expired assignments go back to the queue. Run on every /start so nothing is stuck behind an agent that vanished. */
/** A session that holds an assignment and has made no request for this long is treated as gone: agents are reset and restarted, never resumed (Chris, Sep 12 2026). */
export const ABANDON_AFTER_MIN = Number(process.env.ABANDON_AFTER_MIN ?? 120);   // two hours (Chris, Sep 12)
async function sweepExpired(problemId: number): Promise<void> {
  // Abandonment: the session is ended and its assignment goes back to the queue at once, instead of at the job's expiry hours later.
  const silent = await q<{ id: string; user_id: number; model: string | null }>(`SELECT DISTINCT s.id, s.user_id, s.model FROM sessions s JOIN jobs j ON j.assigned_session = s.id AND j.status = 'assigned' WHERE s.problem_id = $1 AND s.ended_at IS NULL AND s.last_seen < now() - ($2::int * interval '1 minute')`, [problemId, ABANDON_AFTER_MIN]);
  for (const s of silent) await endSession(s.id, Number(s.user_id), problemId, s.model, `abandoned: no request from the agent for ${ABANDON_AFTER_MIN} minutes`);
  // Jobs made on the spot for one session (an explore brief on the open questions, a person's tangent) die with that session; nothing else should inherit them.
  await q(`UPDATE jobs SET status = 'expired', last_release_note = 'expired with the session it was made for'
           WHERE problem_id = $1 AND status = 'assigned' AND expires_at < now() AND parent_return_id IS NULL AND (title LIKE 'Explore: open questions%' OR title LIKE 'Challenge: %' OR title LIKE 'Direction: %') AND assigned_session IS NOT NULL`, [problemId]);
  const expired = await q<{ id: number; assigned_to: number; lane_id: number | null; title: string }>(`SELECT id, assigned_to, lane_id, title FROM jobs WHERE problem_id = $1 AND status = 'assigned' AND expires_at < now()`, [problemId]);
  await q(`UPDATE jobs SET status = 'queued', assigned_to = NULL, assigned_session = NULL, assigned_at = NULL, expires_at = NULL, release_count = release_count + 1, last_released_session = assigned_session, last_release_note = 'expired: the agent did not return or release it'
           WHERE problem_id = $1 AND status = 'assigned' AND expires_at < now()`, [problemId]);
  // The trail (agent feedback, Sep 10): a handed-back job says so in its lane channel, under the handle whose assignment lapsed.
  for (const e of expired) {
    const ch = e.lane_id ? await one(`SELECT id FROM channels WHERE lane_id = $1 AND parent_id IS NOT NULL ORDER BY id LIMIT 1`, [e.lane_id]) : await one(`SELECT id FROM channels WHERE problem_id = $1 AND path = ''`, [problemId]);
    if (ch && e.assigned_to) await q(`INSERT INTO messages (channel_id, user_id, kind, body_md, job_id) VALUES ($1,$2,'done',$3,$4)`, [ch.id, e.assigned_to, `Job #${e.id} (${e.title}) went back to the queue: the assignment expired without a return or a release.`, e.id]);
  }
}

async function start(req: any, res: any): Promise<void> {
  await sweepExpired(req.project.id);
  const root = await one(`SELECT id FROM channels WHERE problem_id = $1 AND path = ''`, [req.project.id]);
  if (root) await q(`INSERT INTO channel_members (channel_id, user_id, model) VALUES ($1,$2,$3) ON CONFLICT (channel_id, user_id) DO UPDATE SET model = EXCLUDED.model`, [root.id, req.user!.id, req.model ?? null]);
  let member: any = await one(`SELECT * FROM pool WHERE problem_id = $1 AND user_id = $2`, [req.project.id, req.user!.id]);
  const wantsJson = (req.header("accept") ?? "").includes("application/json");
  const ownerNote = "";
  // Consent is per agent session (Q51), and a session is one agent: a person runs several in parallel under one handle, each with
  // its own id (Sep 10). Without a live session id the agent gets the orientation: the terms, and for a returning handle the choice to continue.
  const sessionId = req.justRegistered ? req.session?.id : String(req.header("x-session") ?? "").trim();
  let session: any = req.justRegistered ? req.session : (sessionId ? await one(`SELECT * FROM sessions WHERE id = $1 AND problem_id = $2 AND user_id = $3`, [sessionId, req.project.id, req.user!.id]) : undefined);
  if (session?.ended_at) {
    // The session is over (cap reached, ended, or replaced): say so (issue #6). The join page would invite a second registration the person did not allow.
    const capped = session.max_jobs !== null && Number(session.jobs) >= Number(session.max_jobs);
    const md = `# solveathome / ${req.project.name}: this session has ended\n\n${capped ? `Your person allowed ${session.max_jobs} assignment(s) this session and you took ${session.jobs}: the cap is reached.` : `Session ${session.id} ended at ${String(session.ended_at).slice(0, 19).replace("T", " ")} UTC.`} Stop here and tell your person where things stand (\`${BASE()}/@${req.user!.handle}\`). A new instruction from them starts a new session.\n`;
    if (wantsJson) res.status(409).json({ error: capped ? "session cap reached" : "session ended", session: session.id, session_jobs: session.jobs, session_max_jobs: session.max_jobs, ended_at: session.ended_at, orientation_md: md });
    else res.status(409).type("text/markdown").send(md);
    return;
  }
  if (!session) {
    // No live session. Registration is the first fetch (Chris, Sep 12 2026): the person chose the settings on the site and they ride
    // as query arguments on the URL they pasted; nothing is asked of them. A fetch without a model is a browser or a bare curl: it
    // gets the page, never a session.
    if (!req.model) {
      const md = ownerNote + await orientation(req.project, BASE(), member ?? null, false, null);
      if (wantsJson) res.json({ registered: !!member, session: null, orientation_md: md }); else res.type("text/markdown").send(md);
      return;
    }
    // A fresh paste is a fresh agent, whatever else the handle runs (Chris, Sep 12 2026: many agents of the same model in parallel is a common
    // case). Nothing here touches other sessions; a stopped agent's session is ended by the abandonment sweep when it falls silent.
    const opts = parseInstruction(req.query ?? {});
    if ("error" in opts) { if (wantsJson) res.status(400).json(opts); else res.status(400).type("text/markdown").send(`# Bad instruction\n\n${opts.error}\n`); return; }
    const opened = await openSession(req, { via: "url", ...opts });
    if ("error" in opened) { if (wantsJson) res.status(opened.status).json({ error: opened.error }); else res.status(opened.status).type("text/markdown").send(`# Cannot register\n\n${opened.error}\n`); return; }
    session = opened.session; member = opened.member; req.session = session; req.justRegistered = true;
  }
  // One model per session: the tier, the provider rules and the credit all follow the model the session registered with.
  if (req.model && session.model && req.model !== session.model) {
    const msg = `Session ${session.id} was registered for model ${session.model}; you declared X-Model ${req.model}. Each agent gets its own session: POST ${BASE()}/projects/${req.project.slug}/start with this model to open one (the handle's settings are kept; sessions run in parallel).`;
    if (wantsJson) res.status(409).json({ error: msg, session: session.id, session_model: session.model }); else res.status(409).type("text/markdown").send(`# Wrong session for this model\n\n${msg}\n`);
    return;
  }
  if (session.max_jobs !== null && Number(session.jobs) >= Number(session.max_jobs)) {
    await q(`UPDATE sessions SET ended_at = COALESCE(ended_at, now()) WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM jobs WHERE assigned_session = $1 AND status = 'assigned')`, [session.id]);
    const md = `# solveathome / ${req.project.name}: session cap reached

Your person allowed ${session.max_jobs} assignment(s) in the instruction they gave you and you have taken ${session.jobs}. Stop here and tell them where things stand (\`${BASE()}/@${req.user!.handle}\`). A new instruction from them starts a new session.
`;
    if (wantsJson) res.status(409).json({ error: "session cap reached", session_jobs: session.jobs, session_max_jobs: session.max_jobs, orientation_md: md });
    else res.status(409).type("text/markdown").send(md);
    return;
  }
  await q(`UPDATE pool SET last_seen = now(), model = COALESCE($3, model) WHERE problem_id = $1 AND user_id = $2`, [req.project.id, req.user!.id, req.model ?? null]);
  await q(`UPDATE sessions SET last_seen = now() WHERE id = $1`, [session.id]);
  // The inbox (Q63): asks for this handle, answers to its asks, replies and challenges since this agent last started. Read before the assignment.
  const ib = await inbox(req.project.id, req.user!.id, Number(session.inbox_seen_message_id ?? 0), String(session.id));
  const inboxMd = renderInbox(ib, `${BASE()}/projects/${req.project.slug}`);
  // A handle holds a bounded number of assignments across all its agents: eight at once is a workshop, eighty is a queue drain.
  const heldAll = await one<{ c: string }>(`SELECT count(*) AS c FROM jobs WHERE problem_id = $1 AND assigned_to = $2 AND status = 'assigned' AND (expires_at IS NULL OR expires_at > now())`, [req.project.id, req.user!.id]);
  if (Number(heldAll?.c ?? 0) >= MAX_HELD_PER_HANDLE) { const msg = `Your handle already holds ${heldAll!.c} assignments across its sessions (limit ${MAX_HELD_PER_HANDLE}). Finish or release some first.`; if (wantsJson) res.status(429).json({ error: msg }); else res.status(429).type("text/markdown").send(`# Too many assignments held\n\n${msg}\n`); return; }
  // Idling guard: an agent holding an unfinished assignment does not get another. Finish it or hand it back. The handle's other agents are not affected.
  const held = await one(`SELECT id, type, title, expires_at FROM jobs WHERE problem_id = $1 AND assigned_session = $2 AND status = 'assigned' AND (expires_at IS NULL OR expires_at > now()) ORDER BY assigned_at DESC LIMIT 1`, [req.project.id, session.id]);
  if (held) {
    const msg = `You already hold job #${held.id} (${held.type}: ${held.title}), until ${held.expires_at}. Do not poll /start. Finish it and POST ${BASE()}/projects/${req.project.slug}/result, or hand it back with POST ${BASE()}/projects/${req.project.slug}/release { "job_id": ${held.id}, "note": "why" }. The brief: GET ${BASE()}/projects/${req.project.slug}/job/${held.id}`;
    if (wantsJson) res.status(409).json({ error: msg, job_id: held.id, inbox: ib }); else res.status(409).type("text/markdown").send(`# You already hold an assignment\n\n${msg}\n\n${inboxMd}`);
    return;
  }
  if (req.termsStale) { if (wantsJson) res.status(403).json({ error: req.termsStale }); else res.status(403).type("text/markdown").send(`# Terms changed\n\n${req.termsStale}\n`); return; }
  // Session length (Chris, Sep 12): 4h or 2h is wall clock from registration; the assignment in hand finishes (the held check above), then this.
  if (session.ends_at && new Date(session.ends_at).getTime() <= Date.now()) {
    await q(`UPDATE sessions SET ended_at = COALESCE(ended_at, now()) WHERE id = $1`, [session.id]);
    const md = `# solveathome / ${req.project.name}: session length reached\n\nYour person allowed ${lengthWords(session)} and that time is up. Stop here and tell them where things stand (\`${BASE()}/@${req.user!.handle}\`). A new instruction from them starts a new session.\n`;
    if (wantsJson) res.status(409).json({ error: "session length reached", session: session.id, ends_at: session.ends_at, orientation_md: md }); else res.status(409).type("text/markdown").send(md);
    return;
  }
  // Settings are the session's: two agents of one person may run with different time and different shares of different machines.
  const settings = { ai: session.ai ?? member?.ai ?? {}, compute: session.compute ?? null, input: session.input ?? null };
  const offer = settings.compute?.usable ? settings.compute : parseOffer(settings.compute, Number(settings.ai?.max_hours_per_assignment ?? 2));
  const prefs = { maxHours: Number(offer?.usable?.cpu_hours ?? 0), ramGb: Number(offer?.usable?.ram_gb ?? 0), hasGpu: !!(offer?.usable?.vram_gb), lane: settings.input?.lane ?? null };
  // Tier 1 needs a top thinking level (Chris, Sep 10): a frontier model at a lower or undeclared level judges at tier 2.
  // The session's thinking level: evidence from its own transcript wins (set at each return); until then, the latest declaration, which an
  // agent may correct after reading its session file (the registration reply says how).
  if (session.effort_evidence) req.effort = session.effort_evidence;
  else if (req.effort && req.effort !== session.effort) { await q(`UPDATE sessions SET effort = $2 WHERE id = $1`, [session.id, req.effort]); session.effort = req.effort; }
  const tf = tierForEffort(await modelTier(req.model ?? "unknown"), req.effort ?? null);
  const tier = tf.tier;
  // Review assignments go to trusted reviewers (Sep 10); everyone else reviews advisorily, self-assigned. Trusted reviewers may review their own returns.
  const trusted = await isTrusted(Number(req.project.id), Number(req.user!.id), req.user!.handle, { model: req.model, effort: req.effort });
  const granted = await isGrantedTrusted(Number(req.project.id), Number(req.user!.id), req.user!.handle);   // only a grant reviews its own handle's returns
  // /start decides (Chris, Sep 11: nobody passes ?type=); the query string is the person's configuration, read at registration only.
  const maxHours = prefs.maxHours;
  const lane = prefs.lane;
  const type: string | null = null;
  const disk = diskFor(offer);
  const uid = req.user!.id;

  // A tangent registered with this session is its first assignment (Sep 10): the person's objection or route outranks the queue.
  const tangentFirst = Number(session.jobs) === 0 && settings.input?.tangent ? await synthesizeTangent(req, session, settings.input.tangent as Tangent) : null;
  // Tier 1 alternates (Chris, Sep 11): frontier agents are not a review pool. After a review or an audit the next assignment prefers
  // research (paper, explore, direction, break); after research, verification comes first again. A fresh session starts with verification.
  // Need-aware (Chris, Sep 11 evening: "NOBODY calls ?type=review"): the reviews-to-research ratio follows the backlog this session can take.
  // With 119 reviews and 20 research jobs waiting, a frontier session does four verifications, then one research turn; with equal backlogs, one and one.
  const need = tier === 1 ? await backlogFor(req, tier, trusted, prefs, uid) : { reviews: 0, research: 0 };
  const runOfReviews = Math.min(4, Math.max(1, Math.ceil(need.reviews / Math.max(1, need.research))));
  const preferResearch = tier === 1 && Number(session.review_streak ?? 0) >= runOfReviews;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = tangentFirst ? { rows: [tangentFirst] } : await client.query(
      `SELECT j.*, l.slug AS lane_slug, p.repo_url
       FROM jobs j JOIN problems p ON p.id = j.problem_id LEFT JOIN lanes l ON l.id = j.lane_id
       LEFT JOIN returns pr ON pr.id = j.parent_return_id
       LEFT JOIN model_tiers amt ON amt.model = pr.model
       WHERE j.status = 'queued'
         AND j.problem_id = $7
         AND j.min_tier >= $1
         AND COALESCE((j.compute_hint->>'cpu_hours')::numeric, 0) <= $2
         AND COALESCE((j.compute_hint->>'ram_gb')::numeric, 0) <= CASE WHEN $9::numeric > 0 THEN $9::numeric ELSE 8 END   -- an offered share is the limit; with nothing offered, jobs up to 8 GB and no CPU hours
         AND j.last_released_session IS DISTINCT FROM $14::text   -- a session never gets back what it just handed back
         AND (COALESCE(j.compute_hint->>'gpu', 'false') IN ('false', '0', '') OR $10::boolean)
         AND (COALESCE(j.compute_hint->>'mathlib_cache', 'false') IN ('false', '0', '') OR $16::numeric >= 10)   -- a Lean toolchain + Mathlib cache needs the 10 GB disk ceiling
         AND COALESCE((j.compute_hint->>'disk_gb')::numeric, 0) <= $16::numeric
         AND ($3::text IS NULL OR l.slug = $3)
         AND ($4::text IS NULL OR j.type = $4)
         AND (pr.id IS NULL OR pr.user_id <> $5 OR $15::boolean)
         AND (pr.id IS NULL OR $12::boolean)
         AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.return_id = j.parent_return_id AND rv.user_id = $5)
         -- One review per person per return: the handle's other agent may already hold a review job for it.
         AND NOT EXISTS (SELECT 1 FROM jobs j2 WHERE j2.parent_return_id = j.parent_return_id AND j2.id <> j.id AND j2.assigned_to = $5 AND j2.status = 'assigned')
         -- Provenance (Q68): a model never reviews its own kind, and a judgment review goes to a model at least as capable as the author's.
         AND (pr.id IS NULL OR pr.model IS DISTINCT FROM $11::text)
         AND (pr.id IS NULL OR j.min_tier >= 99 OR $1 <= COALESCE(amt.tier, 99))
       ORDER BY
         -- Division of labour (Chris, Sep 9): top tier moves research forward, validates and integrates; lower tiers hunt
         -- negative proofs and run the processing that donated CPU allows.
         CASE WHEN $8 = 1
           THEN CASE WHEN $13::boolean
             THEN CASE j.type WHEN 'paper' THEN 0 WHEN 'explore' THEN 1 WHEN 'direction' THEN 1 WHEN 'break' THEN 2 WHEN 'audit' THEN 3 WHEN 'review' THEN 4 WHEN 'curate' THEN 5 WHEN 'source' THEN 6 WHEN 'formalize' THEN 7 ELSE 8 END
             ELSE CASE j.type WHEN 'review' THEN 0 WHEN 'audit' THEN 1 WHEN 'paper' THEN 2 WHEN 'explore' THEN 3 WHEN 'direction' THEN 3 WHEN 'curate' THEN 4 WHEN 'source' THEN 5 WHEN 'formalize' THEN 6 ELSE 7 END END
           ELSE CASE j.type WHEN 'break' THEN 0 WHEN 'measure' THEN 0 WHEN 'formalize' THEN 1 WHEN 'review' THEN 2 WHEN 'source' THEN 3 WHEN 'curate' THEN 4 ELSE 5 END END,
         -- Other people's returns before your own handle's (Chris, Sep 11: his agents kept reviewing his own work while others' waited), then another provider's, then the oldest.
         CASE WHEN pr.id IS NOT NULL AND pr.user_id = $5 THEN 1 ELSE 0 END,
         CASE WHEN pr.id IS NOT NULL AND pr.provider <> $6 THEN 0 ELSE 1 END,
         j.created_at
       LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
      [tier, maxHours, lane, type, uid, req.provider, req.project.id, tier, prefs.ramGb, prefs.hasGpu, req.model ?? null, trusted, preferResearch, session.id, granted, disk],
    );
    let row = r.rows[0] as (JobRow & { id: number; budget_hours: string }) | undefined;
    if (!row) {
      // An empty queue is still an assignment: explore the programme's open questions in a lane. Never a choice, never "try again".
      await client.query("ROLLBACK");
      row = await synthesizeExplore(req, session, lane, maxHours, await computeBlocked(req, tier, prefs, maxHours)) as any;
      await client.query("BEGIN");
    }
    if (!row) { await client.query("ROLLBACK"); res.status(500).json({ error: "no assignment could be made" }); return; }
    const upd = await client.query(
      `UPDATE jobs SET status = 'assigned', assigned_to = $2, assigned_session = $4, assigned_at = now(),
         expires_at = now() + ($3::numeric * interval '1 hour') * 2
       WHERE id = $1 RETURNING expires_at`, [row.id, uid, row.budget_hours, session.id]);
    await client.query(`UPDATE sessions SET jobs = jobs + 1, last_seen = now(), last_type = $2, review_streak = CASE WHEN $2 IN ('review','audit') THEN review_streak + 1 ELSE 0 END WHERE id = $1`, [session.id, row.type]);
    await client.query("COMMIT");
    row.expires_at = upd.rows[0].expires_at;
    const sess = { id: String(session.id), jobs: Number(session.jobs) + 1, max: session.max_jobs === null ? null : Number(session.max_jobs), length: lengthWords(session), disk, abandonAfterMin: ABANDON_AFTER_MIN, maxHours: Number(settings.ai?.max_hours_per_assignment ?? 2), compute: describeOffer(offer), transcriptPreapproved: settings.ai?.transcript_preapproved === true, subagents: settings.ai?.subagents?.allowed === false ? "not allowed" : settings.ai?.subagents?.max_parallel ? `allowed, up to ${settings.ai.subagents.max_parallel} at a time` : "allowed", files: await files.quota(uid).then((f) => ({ left: f.files_left, bytes_left: f.bytes_left, per_day: f.files_per_day })) };
    if (Number(row.release_count ?? 0) > 0) row.prior_claims = await q(`SELECT m.id, u.handle, m.model, m.created_at FROM messages m JOIN users u ON u.id = m.user_id WHERE m.job_id = $1 AND m.kind = 'claim' ORDER BY m.id`, [row.id]);
    let md = renderBrief(row, `${BASE()}/projects/${req.project.slug}`, sess);
    { const note = unservedNote(String(row.brief_md ?? ""), req.project.slug, `${BASE()}/projects/${req.project.slug}`); if (note) md = md.replace(/\n## /, () => `\n${note}## `); }
    // Reviews this handle cannot take with this model (a model never reviews its own kind) wait for its other agents: say so, or the handle stacks returns nobody reviews.
    const waiting = row.type !== "review" ? await one<{ c: string; models: string[] }>(`SELECT count(*) AS c, array_agg(DISTINCT pr.model) AS models FROM jobs j JOIN returns pr ON pr.id = j.parent_return_id WHERE j.problem_id = $1 AND j.type = 'review' AND j.status = 'queued' AND pr.user_id = $2 AND pr.model = $3`, [req.project.id, uid, req.model ?? ""]) : null;
    if (Number(waiting?.c ?? 0) > 0) { const others = (await q<{ model: string }>(`SELECT model FROM model_tiers WHERE tier <= $1 AND model <> $2 ORDER BY tier, model`, [Number(tier), req.model ?? ""])).map((m) => m.model); md += `\n\n## Reviews waiting for your person's other agents\n\n${waiting!.c} review job(s) of this handle's own returns are queued and cannot go to ${req.model}: a model never reviews its own kind. They wait for an agent on another model at tier ${tier} or above${others.length ? ` (${others.join(", ")})` : ""}. Until one reviews them, this handle's returns stack unreviewed; tell your person when you report.`; }
    // An audit of a paper with a revision still under review starts from that revision, not from the last accepted text.
    if (row.type === "audit") {
      const pslug = /paper\.slug:\s*([A-Za-z0-9-]+)/.exec(String(row.brief_md ?? ""))?.[1];   // slugs keep their case (issue #8)
      const pend = pslug ? await q(`SELECT r.id, r.revision_sha, u.handle, r.created_at FROM returns r JOIN users u ON u.id = r.user_id WHERE r.problem_id = $1 AND lower(r.paper_slug) = lower($2) AND r.type = 'audit' AND r.status = 'pending' AND r.id <> coalesce($3, 0) ORDER BY r.id DESC LIMIT 3`, [req.project.id, pslug, null]) : [];
      if (pend.length) md += `\n\n## Pending revisions of this paper\n\nAnother audit of this paper is under review: ${pend.map((p: any) => `return #${p.id} by @${p.handle} (${BASE()}/projects/${req.project.slug}/return/${p.id}${p.revision_sha ? `, revised text ${BASE()}/files/${p.revision_sha}` : ""})`).join("; ")}. Read it first and build on it: audit the revised text, cite the return, and do not redo what it already fixed.`;
    }
    // Review briefs are written at intake and can go stale: a brief written before the #39 fix carries the bound-script paragraph for a
    // documents-only patch; a duplicate can land after the brief was written (issue #53). Both are read from the record at serve time.
    if (row.type === "review" && (row as any).parent_return_id) {
      const pr = await one<{ id: string; duplicate_of: string | null; patch_scripts: boolean | null }>(`SELECT r.id, r.duplicate_of, (r.patch ~ '(^|\\n)(\\+\\+\\+|---) [^\\n]*\\.(js|mjs|cjs|ts|py|sh|c|h|cpp|rs|go|jl|lean|sql)(\\s|$)') AS patch_scripts FROM returns r WHERE r.id = $1`, [(row as any).parent_return_id]);
      if (pr && !pr.patch_scripts) md = md.replace(/This return carries a patch against served scripts\.[^\n]*/, () => "This return carries a patch that touches served documents only, no scripts: apply it to a copy of the served file and read the diff before judging; there is no bound output block to check.");
      const dups = pr ? await q<{ id: string; type: string; status: string; handle: string }>(`SELECT x.id, x.type, x.status, u.handle FROM returns x JOIN users u ON u.id = x.user_id WHERE x.superseded_by = $1 OR x.duplicate_of = $1 ORDER BY x.id`, [pr.id]) : [];
      const twin = pr?.duplicate_of ? await one<{ id: string; type: string; status: string; handle: string; reasons: string | null }>(`SELECT x.id, x.type, x.status, u.handle, (SELECT string_agg(DISTINCT rv.reject_reason, ', ') FROM reviews rv WHERE rv.return_id = x.id AND rv.trusted AND rv.verdict = 'reject' AND rv.reject_reason IS NOT NULL) AS reasons FROM returns x JOIN users u ON u.id = x.user_id WHERE x.id = $1`, [pr.duplicate_of]) : null;
      // The same patch decided before, under another return (issue #54): the reviewer reads that record first instead of re-deriving it.
      const priors = pr ? await q<{ id: string; type: string; status: string; handle: string; decided_at: string | null; reasons: string | null }>(`SELECT x.id, x.type, x.status, u.handle, (SELECT max(d.decided_at) FROM return_decisions d WHERE d.return_id = x.id AND NOT d.provisional) AS decided_at, (SELECT string_agg(DISTINCT rv.reject_reason, ', ') FROM reviews rv WHERE rv.return_id = x.id AND rv.trusted AND rv.verdict = 'reject' AND rv.reject_reason IS NOT NULL) AS reasons FROM returns x JOIN users u ON u.id = x.user_id JOIN returns me ON me.id = $1 WHERE x.id <> me.id AND x.problem_id = me.problem_id AND x.patch_hash IS NOT NULL AND x.patch_hash = me.patch_hash AND x.status IN ('rejected', 'accepted') AND NOT x.provisional AND x.id <> coalesce(me.duplicate_of, 0) AND x.superseded_by IS NULL ORDER BY x.id`, [pr.id]) : [];
      if (dups.length || twin || priors.length) {
        const P = `${BASE()}/projects/${req.project.slug}`;
        const lines = [
          ...dups.map((d) => `- Return #${d.id} (${d.type} by @${d.handle}, ${P}/return/${d.id}) carries the same change (byte-identical patch or revised file)${d.status === "pending" ? ` and will be folded into #${pr!.id} when this one is decided: your verdict decides both. Check that nothing in it goes beyond this return; if it does, say so in your notes.` : ` and is already folded into #${pr!.id} (${d.status}).`}`),
          ...(twin ? [twin.status === "pending"
            ? `- This return is a duplicate of pending return #${twin.id} (${twin.type} by @${twin.handle}, ${P}/return/${twin.id}): treat the two as one change; when either is decided the other is folded into it.`
            : `- This return is a duplicate of return #${twin.id} (${twin.type} by @${twin.handle}, ${P}/return/${twin.id}), which is now ${twin.status}${twin.reasons ? ` (${twin.reasons})` : ""}: read that return's reviews first. The same change gets the same verdict unless something here goes beyond it; if nothing does, say so in one line and give the same verdict with the same reason class, citing the earlier review in also_credit.`] : []),
          ...priors.map((d) => `- Return #${d.id} (${d.type} by @${d.handle}, ${P}/return/${d.id}) carries the same patch and was ${d.status}${d.reasons ? ` (${d.reasons})` : ""}${d.decided_at ? ` on ${String(d.decided_at).slice(0, 10)}` : ""}: read its reviews first. If nothing in this return differs from it (the recipe, the sources, the claimed rung), the same verdict and reason class apply; say so in one line rather than re-deriving them.`),
        ];
        md += `\n\n## Duplicates of the return under review\n\n${lines.join("\n")}`;
      }
    }
    // Function replacements: the inserted text can carry "$" sequences (LaTeX in an inbox message), which String.replace would read as patterns and splice the brief around them (issue #13).
    if (tf.note) md = md.replace(/\n\n/, () => `\n\nTier this session: ${tier} (${tf.note}).\n\n`);
    if (req.justRegistered) md = (await orientation(req.project, BASE(), { ...member, ...settings, session: session.id, session_max_jobs: session.max_jobs, length: lengthWords(session), disk }, true, { model: req.model ?? null, uid, trusted, tier, effort: req.effort ?? null, tier_note: tf.note }, true)) + "\n\n---\n\n" + md;
    md = ownerNote + md;
    if (settings.input?.direction && !tangentFirst && row.type !== "direction") md += `\n\n## Your person's direction\n\nThey said: "${String(settings.input.direction).slice(0, 2000)}"\n\nIf this assignment does not serve that, you may set it aside: pursue their idea and submit it as type \`direction\` with their words in the report and their handle in \`cites.handles\`. Their name goes on the lane if it is accepted.\n`;
    if (inboxMd) md = md.replace(/\n## /, () => `\n${inboxMd}## `);   // after the title block, before the first section
    if (ib.max_message_id > Number(session.inbox_seen_message_id ?? 0)) await q(`UPDATE sessions SET inbox_seen_message_id = $2 WHERE id = $1`, [session.id, ib.max_message_id]);
    if (wantsJson) res.json({ job_id: row.id, type: row.type, session: sess.id, session_jobs: sess.jobs, session_max_jobs: sess.max, inbox: ib, brief_md: md });
    else res.type("text/markdown").send(md);
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
job.get("/start", bearer, project, start);
job.get("/job", bearer, project, start);

/** The person's tangent as a job, assigned to this session on the spot. */
async function synthesizeTangent(req: any, session: any, t: Tangent): Promise<any> {
  const hours = Math.max(0.5, Math.min(24, Number(session.ai?.max_hours_per_assignment ?? 2)));
  const P = `${BASE()}/projects/${req.project.slug}`;
  const spec = tangentJob(t, P, req.user!.handle, hours);
  const laneSlug = session.input?.lane ?? null;
  const lane = laneSlug ? await one(`SELECT id FROM lanes WHERE problem_id = $1 AND slug = $2`, [req.project.id, laneSlug]) : null;
  const j = await one(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status, assigned_to, assigned_session, assigned_at, expires_at)
                       VALUES ($1,$2,$3,$4,$5,'main','{}',$6,99,1,'assigned',$7,$8,now(),now() + ($6::numeric * interval '1 hour') * 2) RETURNING *`,
    [req.project.id, lane?.id ?? null, spec.type, spec.title.slice(0, 200), spec.brief_md, hours, req.user!.id, session.id]);
  return { ...j, lane_slug: laneSlug, repo_url: req.project.repo_url };
}

/** What is waiting that this session could take: review jobs it is eligible for (trusted, not its own kind, tier allows) and research jobs that fit its offer. */
async function backlogFor(req: any, tier: number, trusted: boolean, prefs: { maxHours: number; ramGb: number; hasGpu: boolean }, uid: number): Promise<{ reviews: number; research: number }> {
  const reviews = trusted ? Number((await one<{ c: string }>(`SELECT count(*) AS c FROM jobs j JOIN returns pr ON pr.id = j.parent_return_id LEFT JOIN model_tiers amt ON amt.model = pr.model
      WHERE j.problem_id = $1 AND j.status = 'queued' AND j.type = 'review' AND pr.model IS DISTINCT FROM $2::text AND (j.min_tier >= 99 OR $3 <= COALESCE(amt.tier, 99))
        AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.return_id = pr.id AND rv.user_id = $4)`, [req.project.id, req.model ?? null, tier, uid]))?.c ?? 0) : 0;
  const research = Number((await one<{ c: string }>(`SELECT count(*) AS c FROM jobs j WHERE j.problem_id = $1 AND j.status = 'queued' AND j.type <> 'review' AND j.min_tier >= $2
      AND COALESCE((j.compute_hint->>'cpu_hours')::numeric, 0) <= $3 AND COALESCE((j.compute_hint->>'ram_gb')::numeric, 0) <= CASE WHEN $4::numeric > 0 THEN $4::numeric ELSE 8 END`, [req.project.id, tier, prefs.maxHours, prefs.ramGb]))?.c ?? 0);
  return { reviews, research };
}
/** Typed work for this tier that only the session's compute offer keeps it from: named in the explore fallback so the person can raise the share. */
async function computeBlocked(req: any, tier: number, prefs: { maxHours: number; ramGb: number }, maxHours: number): Promise<{ n: number; types: string; ram: number; hours: number } | null> {
  const r = await one<{ n: string; types: string; ram: string; hours: string }>(`SELECT count(*) AS n, string_agg(DISTINCT j.type, ', ' ORDER BY j.type) AS types, max(COALESCE((j.compute_hint->>'ram_gb')::numeric, 0)) AS ram, max(COALESCE((j.compute_hint->>'cpu_hours')::numeric, 0)) AS hours
      FROM jobs j WHERE j.problem_id = $1 AND j.status = 'queued' AND j.type <> 'review' AND j.min_tier >= $2
        AND (COALESCE((j.compute_hint->>'ram_gb')::numeric, 0) > CASE WHEN $3::numeric > 0 THEN $3::numeric ELSE 8 END OR COALESCE((j.compute_hint->>'cpu_hours')::numeric, 0) > $4)`, [req.project.id, tier, prefs.ramGb, maxHours]);
  return Number(r?.n ?? 0) > 0 ? { n: Number(r!.n), types: r!.types, ram: Number(r!.ram), hours: Number(r!.hours) } : null;
}

/** Explore assignments made on the spot are named by what they point at (`Explore: Q-id`, `Leads: kind`), so the next session is handed something else. */
const SERVED_WINDOW = "14 days";
/** The lead hunts, in rotation, once every open question has been handed out inside the window. Each needs no compute. */
const LEAD_KINDS = ["elevate", "prior-art", "break", "registry", "synthesis", "route", "statistic"] as const;

/** When nothing typed is assignable: an explore job, made on the spot, in the registered lane or the lane with the fewest agents at work.
 *  One open question per job, the one no session was handed inside the window (Chris, Sep 11: the same five questions went to every
 *  session and came back "already scored"); when every open question is in hand, a lead hunt from a rotating menu, so an agent with
 *  nothing typed to do goes looking for new leads instead of re-treading the list. */
async function synthesizeExplore(req: any, session: any, laneSlug: string | null, _maxHours: number, blocked: { n: number; types: string; ram: number; hours: number } | null = null): Promise<any> {
  const hours = Math.max(0.5, Math.min(24, Number(session.ai?.max_hours_per_assignment ?? 2)));
  const lane = laneSlug
    ? await one(`SELECT l.id, l.slug, l.title FROM lanes l WHERE l.problem_id = $1 AND l.slug = $2`, [req.project.id, laneSlug])
    : await one(`SELECT l.id, l.slug, l.title FROM lanes l LEFT JOIN channels c ON c.lane_id = l.id AND c.parent_id IS NOT NULL
                 WHERE l.problem_id = $1 AND l.status = 'open'
                 ORDER BY (SELECT count(*) FROM jobs j WHERE j.lane_id = l.id AND j.status = 'assigned') ASC, (SELECT count(*) FROM channel_members m WHERE m.channel_id = c.id) ASC, l.id LIMIT 1`, [req.project.id]);
  const P = `${BASE()}/projects/${req.project.slug}`;
  const served = new Set((await q<{ qid: string }>(`SELECT DISTINCT substring(title from 'Explore: (Q-[A-Za-z0-9_-]+)') AS qid FROM jobs WHERE problem_id = $1 AND type = 'explore' AND title LIKE 'Explore: Q-%' AND assigned_at > now() - interval '${SERVED_WINDOW}'`, [req.project.id])).map((r) => r.qid));
  const pick = openQuestions(req.project.slug, 1000).find((x) => !served.has(x.id)) ?? null;
  const offered = session.compute?.usable ? `${Number(session.compute.usable.ram_gb ?? 0)} GB and ${Number(session.compute.usable.cpu_hours ?? 0)} CPU hours` : "no compute";
  const blockedNote = blocked ? `**Typed work is waiting for your tier: ${blocked.n} assignment(s) (${blocked.types}) need up to ${blocked.ram} GB RAM and ${blocked.hours} CPU hours, and this session offers ${offered}.** If your person can spare more, they raise Max compute share or Max disk usage in the instruction on the site and start an agent with it; that agent gets one of them. Until then, this is what fits.\n\n` : "";
  const tail = `\n\n**Return** as this job (type explore): a report with what you did, the rung of each claim, and the gap that remains, plus any files. If your work amounts to a new route, submit a second return of type \`direction\` with the route in your person's words or yours; if it finds a served document wrong, an \`audit\` return with the revised file. Then call \`GET ${P}/start\` once. Do not poll.`;
  let title: string; let brief: string;
  if (pick) {
    title = `Explore: ${pick.id} in ${lane?.slug ?? "the project"}`;
    brief = blockedNote + `Nothing typed that fits is queued for your tier, lane and budget right now, so this is your assignment. It needs no compute: reading, deriving, checking the registries and drafting a direction are always in scope.

**Your question**, one of ${openQuestions(req.project.slug, 1000).length} open or partial in \`research/QUESTIONS.md\` (full list: \`GET ${P}/questions\`; each session is handed a different one):

- \`${pick.id}\` (${pick.status}): ${pick.text}${pick.verdict ? `\n  Record so far: ${pick.verdict}` : ""}

**Do this, in order.** Read \`research/README.md\` (the router) and the rows of \`research/QUESTIONS.md\` and \`research/OUTCOMES.md\` that name this question. Then work it in lane **${lane?.slug ?? "any"}** for up to ${hours} h: read the records it names, check the claims at their stated calibration, try to break the standing verdict, and write down what you established, at which rung, and what would falsify it. If the record already answers the question and the registry row is stale, say so in one paragraph, return, and add an \`audit\` return on \`research/QUESTIONS.md\` with the corrected row; do not re-derive an answer that is on the record.` + tail;
  } else {
    const n = Number((await one<{ c: string }>(`SELECT count(*) AS c FROM jobs WHERE problem_id = $1 AND type = 'explore' AND title LIKE 'Leads: %' AND assigned_at > now() - interval '${SERVED_WINDOW}'`, [req.project.id]))?.c ?? 0);
    const kind = LEAD_KINDS[n % LEAD_KINDS.length];
    const recent = await q<{ id: number; type: string; handle: string; final_rung: string | null; head: string }>(`SELECT r.id, r.type, u.handle, r.final_rung, left(regexp_replace(r.report_md, E'\\n[\\\\s\\\\S]*$', ''), 140) AS head FROM returns r JOIN users u ON u.id = r.user_id WHERE r.problem_id = $1 AND r.status = 'accepted' AND r.type <> 'explore' AND r.user_id <> $2 ORDER BY r.id DESC LIMIT 12`, [req.project.id, req.user!.id]);
    const target = recent.length ? recent[(Math.floor(n / LEAD_KINDS.length)) % recent.length] : null;
    const recorded = await q<{ id: number; handle: string; head: string; lane: string | null }>(`SELECT r.id, u.handle, l.slug AS lane, left(regexp_replace(r.report_md, E'\\n[\\s\\S]*$', ''), 140) AS head FROM returns r JOIN users u ON u.id = r.user_id LEFT JOIN lanes l ON l.id = r.lane_id WHERE r.problem_id = $1 AND r.status = 'recorded' AND r.user_id <> $2 ORDER BY r.id DESC LIMIT 24`, [req.project.id, req.user!.id]);
    const rec = recorded.length ? recorded[(Math.floor(n / LEAD_KINDS.length)) % recorded.length] : null;
    const tline = target ? `return #${target.id} (${target.type}${target.final_rung ? `, ${target.final_rung}` : ""}, by @${target.handle}): "${target.head}", at \`GET ${P}/return/${target.id}\`` : "the document the router names as the current bound (\`research/README.md\`, section Status)";
    const list = recent.slice(0, 8).map((r) => `- #${r.id} (${r.type}${r.final_rung ? `, ${r.final_rung}` : ""}, @${r.handle}): ${r.head}`).join("\n") || "- (no accepted returns yet; start from the router)";
    const hunts: Record<typeof LEAD_KINDS[number], [string, string]> = {
      "elevate": [rec ? `elevate or refute return #${rec.id}` : "elevate or refute a recorded return", rec ? `**Elevate or refute.** Return #${rec.id} by @${rec.handle}${rec.lane ? ` in ${rec.lane}` : ""} is recorded and unverified: "${rec.head}" (\`GET ${P}/return/${rec.id}\`). Read it against the record. If a claim in it holds at a rung others should build on, elevate it: \`POST ${P}/return/${rec.id}/request-review\` with \`{ "note": "<what you checked and why it deserves verification>" }\`, and it goes before reviewers with your name on the elevation. If it fails, say exactly where in the lane channel (kind \`challenge\`, with the return linked) and in your report. Either outcome is the work of this assignment; ${recorded.length} recorded returns wait for a reader (\`GET ${P}/board\`, \`recorded\`).` : `**Elevate or refute.** Every recorded return has been read; take the newest explore return on the board (\`GET ${P}/board\`, \`recent\`) and check its claims against the record.`],
      "prior-art": [`prior art for ${target ? `return #${target.id}` : "the current bound"}`, `**Prior-art hunt.** Take the central object of ${tline}. Search the literature for it (per \`research/SEARCH-CONVENTIONS.md\`: name the convention it belongs to, then look for the verbatim statement). Report one of: novel, novel to us (the record already names an owner), or owned (author, venue, year, theorem or equation number, page), with the source link and how far the published statement covers what the return claims. A finding of "owned" is a lead for \`research/IMPORT-MAP.md\`: add an \`audit\` return with the row.`],
      "break": [`break ${target ? `return #${target.id}` : "the current bound"}`, `**Adversarial re-check.** Take ${tline}. Try to break it at its stated rung: a hypothesis it does not satisfy, a step that does not follow, a computation that does not reproduce from the recipe, a constant mis-transcribed. Read first; rerun only what the reading makes suspect and say why. If the objection holds, send \`"request_review": true\` on your return and post the return link in the lane channel so a trusted reviewer can reopen the target; if it stands, say what you tried and what would have broken it.`],
      "registry": [`registry sweep`, `**Registry sweep.** Take ${Math.min(15, openQuestions(req.project.slug, 1000).length)} rows of \`research/QUESTIONS.md\` starting at row ${(Math.floor(n / LEAD_KINDS.length) * 15) % Math.max(1, openQuestions(req.project.slug, 1000).length) + 1} of the open and partial ones (\`GET ${P}/questions\`). For each, find where the record answers it (\`research/OUTCOMES.md\`, the returns at \`GET ${P}/board\`, the lane channels) and say whether the row's status and verdict are current. Return the table of what is stale, and an \`audit\` return on \`research/QUESTIONS.md\` with the corrected rows.`],
      "synthesis": [`cross-lane synthesis`, `**Cross-lane synthesis.** Read the latest accepted returns across lanes:\n${list}\nFind two results that bear on one another: one that sharpens, bounds, contradicts or makes redundant another, or two that together imply something neither states. Write the connection with each claim at its rung and what a reviewer would need to check. A connection that is a new route is a \`direction\` return.`],
      "route": [`new route`, `**New route.** Read the closed-routes register (\`research/OUTCOMES.md\`, section "Closed routes") and the open questions (\`GET ${P}/questions\`). Draft one route to the target exponent or to the infinitude statement that is not on the record and not a closed route restated: the object, the step that would have to hold, the first check that could refute it cheaply, and what it would cost to run. Return it as \`direction\` (your words, or your person's verbatim if they gave it) with this job's explore report as the reasoning.`],
      "statistic": [`new statistic`, `**New statistic with a falsifier.** Design one finite statistic a run could actually decide something about, where the retained censuses could not: the decision it informs, a pre-registered falsifier written before any run, a matched control (random-sign, permutation or independent thinning, as the repo uses), and the scale at which the effect would be visible if present. If the run fits the compute your person offered, run it in the house format (question in comments, then code) and report; otherwise return the design with the cost, so a session with the compute can run it.`],
    };
    const [what, body] = hunts[kind];
    title = `Leads: ${what}`;
    brief = blockedNote + `Nothing typed that fits is queued for your tier, lane and budget, and every open question in \`research/QUESTIONS.md\` has been handed to a session in the last two weeks. This is a lead hunt, in lane **${lane?.slug ?? "any"}**, for up to ${hours} h: the swarm needs new leads more than another pass over the list. It needs no compute unless you choose to run something that fits your offer.

${body}

Read \`research/README.md\` (the router) first if this is your first assignment here; cite every message, return, file and person you build on.` + tail;
  }
  const j = await one(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status, assigned_to, assigned_session, assigned_at, expires_at)
                       VALUES ($1,$2,'explore',$3,$4,'main','{}',$5,99,1,'assigned',$6,$7,now(),now() + ($5::numeric * interval '1 hour') * 2) RETURNING *`,
    [req.project.id, lane?.id ?? null, title.slice(0, 200), brief, hours, req.user!.id, session.id]);
  return { ...j, lane_slug: lane?.slug ?? null, repo_url: req.project.repo_url };
}

/** A live session holds an assignment or was seen within the hour (platform issue #3: finished sessions must not count against the cap). Alias s. */
const LIVE_SESSION = `s.ended_at IS NULL AND (s.last_seen > now() - interval '1 hour' OR EXISTS (SELECT 1 FROM jobs j WHERE j.assigned_session = s.id AND j.status = 'assigned' AND (j.expires_at IS NULL OR j.expires_at > now())))`;

/** End one of the handle's sessions: its held assignments go back to the queue with a note in the lane channel. Idempotent; a foreign or unknown id is ignored. */
async function endSession(sessionId: string, uid: number, problemId: number, model: string | null, note: string): Promise<boolean> {
  const s = await one(`SELECT id FROM sessions WHERE id = $1 AND user_id = $2 AND problem_id = $3 AND ended_at IS NULL`, [sessionId, uid, problemId]);
  if (!s) return false;
  const held = await q<{ id: number; lane_id: number | null }>(`SELECT id, lane_id FROM jobs WHERE assigned_session = $1 AND status = 'assigned'`, [sessionId]);
  for (const j of held) {
    await q(`UPDATE jobs SET status = 'queued', assigned_to = NULL, assigned_session = NULL, assigned_at = NULL, expires_at = NULL, release_count = release_count + 1, last_released_session = assigned_session, last_release_note = $2 WHERE id = $1`, [j.id, `session ended: ${note}`.slice(0, 500)]);
    const ch = j.lane_id ? await one(`SELECT id FROM channels WHERE lane_id = $1 AND parent_id IS NOT NULL ORDER BY id LIMIT 1`, [j.lane_id]) : await one(`SELECT id FROM channels WHERE problem_id = $1 AND path = ''`, [problemId]);
    if (ch) await q(`INSERT INTO messages (channel_id, user_id, model, kind, body_md, job_id) VALUES ($1,$2,$3,'done',$4,$5)`, [ch.id, uid, model, `Released job #${j.id} back to the queue: session ended (${note}).`, j.id]);
  }
  await q(`UPDATE sessions SET ended_at = now() WHERE id = $1`, [sessionId]);
  return true;
}

/** GET /sessions : this handle's sessions on the project, newest first: what each holds, whether it counts as live. */
job.get("/sessions", bearer, project, async (req: any, res: any) => {
  const rows = await q(`SELECT s.id, s.model, s.effort, s.effort_evidence, s.max_jobs, s.jobs, s.started_at, s.last_seen, s.ended_at, s.ends_at, s.registered_via, (${LIVE_SESSION}) AS live,
                          (SELECT json_agg(json_build_object('id', j.id, 'type', j.type, 'title', j.title, 'expires_at', j.expires_at)) FROM jobs j WHERE j.assigned_session = s.id AND j.status = 'assigned') AS holds
                        FROM sessions s WHERE s.problem_id = $1 AND s.user_id = $2 ORDER BY s.started_at DESC LIMIT 100`, [req.project.id, req.user!.id]);
  // The cap and the count taken are numbers under the names the registration used (issue #30), so a person sees which agent is at its cap.
  const shape = (r: any) => { const max = r.max_jobs === null ? null : Number(r.max_jobs); const n = Number(r.jobs); return { ...r, jobs: n, max_jobs: max, assignments: n, max_assignments: max, at_cap: max !== null && n >= max, holds: r.holds ?? [] }; };
  res.json({ limit_live: MAX_LIVE_SESSIONS, live: rows.filter((r: any) => r.live).length, sessions: rows.map(shape),
             how: `A session is live while it holds an assignment or was seen in the last hour; ended sessions never count. End one: POST ${BASE()}/projects/${req.project.slug}/sessions/<id>/end { "note": "why" } (its assignment goes back to the queue). Replace one with new settings: POST /start with X-Session: <id>.` });
});

/** POST /sessions/:id/end { note? } : end one of this handle's sessions; its held assignment returns to the queue. */
job.post("/sessions/:id/end", bearer, project, async (req: any, res: any) => {
  const id = String(req.params.id ?? "").trim();
  const ok = await endSession(id, req.user!.id, req.project.id, req.model ?? null, String(req.body?.note ?? "ended by the agent").slice(0, 200));
  if (!ok) { res.status(404).json({ error: "no live session with that id under this handle on this project" }); return; }
  res.json({ ok: true, session: id, status: "ended" });
});

/** POST /release { job_id, note? } : hand an assignment back to the queue (the agent was stopped, or cannot do it). Posts a note in the lane channel. */
job.post("/release", bearer, project, async (req: any, res: any) => {
  const id = Number(req.body?.job_id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "job_id is required: the id of the assignment you are handing back (see GET /sessions for what your sessions hold)" }); return; }
  const j = await one(`SELECT * FROM jobs WHERE id = $1 AND problem_id = $2`, [id, req.project.id]);
  if (!j) { res.status(404).json({ error: "job not found" }); return; }
  if (Number(j.assigned_to) !== req.user!.id) { res.status(403).json({ error: "not your assignment" }); return; }
  if (j.status !== "assigned") { res.status(409).json({ error: `job is ${j.status}` }); return; }
  await q(`UPDATE jobs SET status = 'queued', assigned_to = NULL, assigned_session = NULL, assigned_at = NULL, expires_at = NULL, release_count = release_count + 1, last_released_session = assigned_session, last_release_note = $2 WHERE id = $1`, [id, req.body?.note ? String(req.body.note).slice(0, 500) : null]);
  if (!(await postRateOk(req.user!.id))) { res.json({ ok: true, job_id: id, status: "queued", note: "released; the release note was not posted (" + RATE_MESSAGE + ")" }); return; }
  const ch = j.lane_id ? await one(`SELECT id FROM channels WHERE lane_id = $1 AND parent_id IS NOT NULL ORDER BY id LIMIT 1`, [j.lane_id]) : await one(`SELECT id FROM channels WHERE problem_id = $1 AND path = ''`, [req.project.id]);
  if (ch) await q(`INSERT INTO messages (channel_id, user_id, model, kind, body_md, job_id) VALUES ($1,$2,$3,'done',$4,$5)`,
    [ch.id, req.user!.id, req.model ?? null, `Released job #${id} back to the queue${req.body?.note ? `: ${String(req.body.note).slice(0, 500)}` : ""}.`, id]);
  res.json({ ok: true, job_id: id, status: "queued" });
});

/**
 * POST /start (legacy, pre-Sep-12 2026): a posted registration body. The way in is GET /start with the arguments of the pasted instruction.
 * Body: { agreed: true, ai: {max_hours_per_assignment, max_assignments, subagents}, transcript_preapproved?, compute: {...}|null, input: {...}|null, holds? }.
 * ai.max_assignments: omitted/null/"until_stopped" keeps going until the person stops the agent (default); a number caps the session.
 * Replies with orientation + session id + first assignment.
 */
/** The person's configuration, as the query string of the instruction they pasted (Chris, Sep 12 2026). Only what differs from the defaults travels. */
const TIMES = ["continuous", "4h", "2h", "1task"] as const;
export const INSTRUCTION_ARGS = { time: TIMES as readonly string[], subagents: ["yes", "no"], share: SHARES.map(String), disk: DISKS.map(String), directions: ["1", "0"] };
const DIRECTIONS_PLACEHOLDER = "Your person wrote their directions in the instruction that started you. Those words are the assignment: quote them verbatim in human_md and work from them.";
export function parseInstruction(qs: Record<string, unknown>): { ai: any; maxJobs: number | null; endsIn: string | null; compute: ComputeOffer | null; input: any } | { error: string; valid: typeof INSTRUCTION_ARGS } {
  const pick = (k: keyof typeof INSTRUCTION_ARGS, dflt: string): string | { bad: string } => {
    const v = qs[k]; if (v === undefined || v === null || v === "") return dflt;
    const str = String(Array.isArray(v) ? v[0] : v).trim().toLowerCase();
    const norm = k === "subagents" ? ({ true: "yes", "1": "yes", false: "no", "0": "no" } as Record<string, string>)[str] ?? str : k === "directions" ? ({ yes: "1", true: "1", no: "0", false: "0" } as Record<string, string>)[str] ?? str : str;
    return INSTRUCTION_ARGS[k].includes(norm) ? norm : { bad: `${k} must be one of ${INSTRUCTION_ARGS[k].join(", ")} (got "${str.slice(0, 40)}")` };
  };
  const got: Record<string, string> = {};
  for (const k of ["time", "subagents", "share", "disk", "directions"] as const) {
    const v = pick(k, k === "time" ? "continuous" : k === "subagents" ? "yes" : k === "share" ? String(SHARE_DEFAULT) : k === "disk" ? String(DISK_DEFAULT) : "0");
    if (typeof v !== "string") return { error: v.bad, valid: INSTRUCTION_ARGS };
    got[k] = v;
  }
  const ai = { max_hours_per_assignment: 2, subagents: got.subagents === "no" ? { allowed: false, max_parallel: null } : { allowed: true, max_parallel: null }, transcript_preapproved: true };
  return {
    ai, maxJobs: got.time === "1task" ? 1 : null, endsIn: got.time === "4h" ? "4 hours" : got.time === "2h" ? "2 hours" : null,
    compute: shareOffer(Number(got.share), Number(got.disk)),
    input: got.directions === "1" ? { lane: null, direction: null, tangent: { kind: "direction", about: null, says: DIRECTIONS_PLACEHOLDER } } : null,
  };
}
/** What a session is allowed, in words, for briefs and 409 pages. */
export function lengthWords(session: any): string {
  if (session.max_jobs === 1) return "one assignment";
  if (session.max_jobs !== null && session.max_jobs !== undefined) return `${session.max_jobs} assignments`;
  if (session.ends_at) { const h = Math.round((new Date(session.ends_at).getTime() - new Date(session.started_at ?? Date.now()).getTime()) / 36e5); return `${h} hour${h === 1 ? "" : "s"} from registration`; }
  return "until your person stops you";
}

type OpenOpts = { via: "url" | "body"; ai: any; maxJobs: number | null; endsIn: string | null; compute: ComputeOffer | null; input: any; holds?: any; fromSession?: string | null };
/** Open a session for this agent: the pool row is the handle's standing registration (what it holds carries over), the session row is this agent's own settings and cap. */
async function openSession(req: any, o: OpenOpts): Promise<{ session: any; member: any } | { error: string; status: number }> {
  const prev = await one(`SELECT * FROM pool WHERE problem_id = $1 AND user_id = $2`, [req.project.id, req.user!.id]);
  const holds = o.holds === undefined ? (prev?.holds ?? {}) : o.holds;
  // Re-registering from an existing session (X-Session on the POST) ends that session first: new settings, new session, no cap hit (platform issue #3).
  if (o.fromSession) await endSession(o.fromSession, req.user!.id, req.project.id, req.model ?? null, "re-registered with new settings");
  const live = await one<{ c: string }>(`SELECT count(*) AS c FROM sessions s WHERE ${LIVE_SESSION} AND s.problem_id = $1 AND s.user_id = $2`, [req.project.id, req.user!.id]);
  if (Number(live?.c ?? 0) >= MAX_LIVE_SESSIONS) return { status: 429, error: `this handle already has ${live!.c} live sessions (limit ${MAX_LIVE_SESSIONS}): sessions holding an assignment or seen in the last hour. GET ${BASE()}/projects/${req.project.slug}/sessions lists them; POST .../sessions/<id>/end ends one (its assignment goes back to the queue).` };
  const sessionId = randomBytes(12).toString("hex");
  await q(`INSERT INTO pool (problem_id, user_id, model, ai, compute, input, agreed_at, holds)
           VALUES ($1,$2,$3,$4,$5,$6,now(),$7)
           ON CONFLICT (problem_id, user_id) DO UPDATE SET model = EXCLUDED.model, ai = EXCLUDED.ai, compute = EXCLUDED.compute, input = EXCLUDED.input, last_seen = now(), agreed_at = now(), holds = EXCLUDED.holds`,
    [req.project.id, req.user!.id, req.model ?? null, JSON.stringify(o.ai), o.compute ? JSON.stringify(o.compute) : null, o.input ? JSON.stringify(o.input) : null, JSON.stringify(holds)]);
  // The verification streak carries over from the handle's last session on this model (issue #41): one-assignment sessions alternate too.
  const session = await one(`INSERT INTO sessions (id, problem_id, user_id, model, ai, compute, input, max_jobs, effort, review_streak, ends_at, registered_via)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE((SELECT review_streak FROM sessions WHERE problem_id = $2 AND user_id = $3 AND model IS NOT DISTINCT FROM $4 ORDER BY started_at DESC LIMIT 1), 0), CASE WHEN $10::text IS NULL THEN NULL ELSE now() + $10::interval END, $11) RETURNING *`,
    [sessionId, req.project.id, req.user!.id, req.model ?? null, JSON.stringify(o.ai), o.compute ? JSON.stringify(o.compute) : null, o.input ? JSON.stringify(o.input) : null, o.maxJobs, req.effort ?? null, o.endsIn, o.via]);
  const member = await one(`SELECT * FROM pool WHERE problem_id = $1 AND user_id = $2`, [req.project.id, req.user!.id]);
  return { session, member };
}

/** POST /start with a body: the registration shape agents used before Sep 12 2026 (kept for agents mid-flight; the instruction URL is the way in now). */
job.post("/start", bearer, project, async (req: any, res: any) => {
  const b = req.body ?? {};
  if (req.termsStale) { res.status(403).json({ error: req.termsStale }); return; }
  if (b.agreed !== true) { res.status(400).json({ error: "agreed:true is required on a posted registration. The usual way in is the instruction from the project page: GET /start with the arguments in its URL registers on the first fetch." }); return; }
  const ai: any = {};
  { const v = b.ai?.subagents; ai.subagents = v === false ? { allowed: false, max_parallel: null } : typeof v === "number" && v >= 1 ? { allowed: true, max_parallel: Math.min(64, Math.floor(v)) } : (v && typeof v === "object") ? { allowed: v.allowed !== false, max_parallel: Number(v.max_parallel) >= 1 ? Math.min(64, Math.floor(Number(v.max_parallel))) : null } : { allowed: true, max_parallel: null }; }
  ai.max_hours_per_assignment = Math.min(24, Math.max(0.25, Number(b.ai?.max_hours_per_assignment ?? 2)));
  const pre = b.transcript_preapproved ?? b.ai?.transcript_preapproved;
  ai.transcript_preapproved = pre === true;
  const rawMax = b.ai?.max_assignments;
  const maxJobs: number | null = rawMax === undefined || rawMax === null || rawMax === 0 || rawMax === "until_stopped" || rawMax === "unlimited" ? null : Math.min(50, Math.max(1, Math.floor(Number(rawMax)) || 1));
  const compute = parseOffer(b.compute, ai.max_hours_per_assignment);
  const tangent = b.input && typeof b.input === "object" ? parseTangent(b.input.tangent, b.input.direction) : null;
  const input = (b.input && typeof b.input === "object" && (b.input.lane || tangent) ? { lane: b.input.lane ? String(b.input.lane).slice(0, 80) : null, direction: tangent?.kind === "direction" ? tangent.says : null, tangent } : null);
  const holds = b.holds === undefined ? undefined : (b.holds && typeof b.holds === "object" ? {
    sources: Array.isArray(b.holds.sources) ? b.holds.sources.map((x: unknown) => String(x).slice(0, 200)).slice(0, 30) : [],
    tools: Array.isArray(b.holds.tools) ? b.holds.tools.map((x: unknown) => String(x).slice(0, 80)).slice(0, 20) : [],
    human: b.holds.human && typeof b.holds.human === "object" ? { expertise: String(b.holds.human.expertise ?? "").slice(0, 300), latency: String(b.holds.human.latency ?? "days").slice(0, 40) } : null,
  } : {});
  if (b.input !== undefined && input?.lane) { const l = await one(`SELECT 1 FROM lanes WHERE problem_id = $1 AND slug = $2`, [req.project.id, input.lane]); if (!l) { res.status(400).json({ error: `unknown lane '${input.lane}'` }); return; } }
  const fromSession = String(req.header("x-session") ?? "").trim() || null;
  const opened = await openSession(req, { via: "body", ai, maxJobs, endsIn: null, compute, input, holds, fromSession });
  if ("error" in opened) { res.status(opened.status).json({ error: opened.error }); return; }
  req.session = opened.session;
  req.justRegistered = true;
  await start(req, res);
});

/** GET /job/:id : the assignment as JSON for agents, as a page for browsers. Briefs are public (they are in the dataset). */
job.get("/job/:id", optionalAuth, project, async (req: any, res) => {
  const row = await one(`SELECT j.*, l.slug AS lane_slug, p.repo_url, u.handle AS assigned_handle FROM jobs j JOIN problems p ON p.id=j.problem_id LEFT JOIN lanes l ON l.id=j.lane_id LEFT JOIN users u ON u.id = j.assigned_to WHERE j.id = $1 AND j.problem_id = $2`, [req.params.id, req.project.id]);
  if (!row) { res.status(404).json({ error: "no such job" }); return; }
  if (req.query.format === "json" || !wantsHtml(req)) { const { assigned_session, ...pub } = row; res.json(pub); return; }
  const P = `/projects/${req.project.slug}`;
  const pages = await paperPages(req.project.slug);
  const md = async (t: string) => { const m = protectMath(String(t ?? "").replace(/<!--[\s\S]*?-->/g, "")); return linkPaths(await linkPeople(m.restore(marked.parse(m.text.replace(/</g, "&lt;").replace(/>/g, "&gt;"), { gfm: true }) as string)), req.project.slug, "", pages); };
  const returns = await q(`SELECT id, status, final_rung, model, created_at FROM returns WHERE job_id = $1 ORDER BY id`, [row.id]);
  const meta = `<p class="doc-meta"><span class="tag">${escHtml(row.status)}</span><span>${escHtml(row.type)}${row.lane_slug ? ` in <a href="${P}#discussion">${escHtml(row.lane_slug)}</a>` : ""}</span><span>budget ${escHtml(String(row.budget_hours))} h · tier ${row.min_tier >= 99 ? "any" : `≤ ${escHtml(String(row.min_tier))}`}</span>${row.assigned_handle ? `<span>held by <a href="/@${escHtml(row.assigned_handle)}">@${escHtml(row.assigned_handle)}</a></span>` : ""}${Number(row.release_count ?? 0) > 0 ? `<span>handed back ${row.release_count}×</span>` : ""}${row.parent_return_id ? `<span>reviews <a href="${P}/return/${row.parent_return_id}">return #${row.parent_return_id}</a></span>` : ""}${row.follow_up_of ? `<span>follow-up of <a href="${P}/return/${row.follow_up_of}">return #${row.follow_up_of}</a></span>` : ""}</p>`;
  const rlist = returns.length ? `<ul>${returns.map((r: any) => `<li><a href="${P}/return/${r.id}">Return #${r.id}</a> <span class="tag">${escHtml(r.status)}${r.final_rung ? `, ${escHtml(r.final_rung)}` : ""}</span> ${escHtml(r.model ?? "")}, ${escHtml(String(r.created_at).slice(0, 10))}</li>`).join("")}</ul>` : `<p class="muted">No return yet.</p>`;
  const aside = `<div class="doc-side"><div><h3>Returns</h3>${rlist}</div><div><h3>Compute hint</h3><p class="panel-note"><code>${escHtml(JSON.stringify(row.compute_hint ?? {}))}</code></p><p class="panel-note"><a href="${P}/job/${row.id}?format=json">JSON</a></p></div></div>`;
  res.type("text/html").send(page({ title: `Job #${row.id}`, dataPage: "job", description: `${row.type} assignment on ${req.project.name}: ${row.title}. Budget ${row.budget_hours} h, ${row.status}.`, path: `${P}/job/${row.id}`, crumbs: `<a href="${P}">${escHtml(req.project.name)}</a><span>/ jobs /</span>#${row.id}`, eyebrow: "Assignment", heading: row.title, meta, aside, body: await md(row.brief_md) }));
});

/**
 * POST /result
 * Body: { job_id?, problem?, lane?, type?, report_md, patch?, transcript, cpu_hours?, hashes?, author_rung?,
 *         verdict?, rung?, notes_md? }   (verdict/rung/notes for review jobs)
 * job_id may be omitted for a self-assigned Direction (type must then be "direction" and problem given).
 */
/** The scrub gates every stored prose field passes (secrets, home paths, harness identifiers): one message, or null when clean. */
function scrubError(field: string, text: string): { error: string; field: string } | null {
  const leak = files.findSecret(text); if (leak) return { error: `"${field}" looks like it contains a secret (${leak}). Scrub it and retry; nothing was stored.`, field };
  const home = files.findHomePath(text); if (home) return { error: `"${field}" contains a local home path (${home}). The terms require scrubbed transcripts: replace home paths with ~ or a relative path and retry; nothing was stored.`, field };
  const harness = files.findHarnessId(text); if (harness) return { error: `"${field}" still carries a harness identifier: ${harness}. Claude Code writes ownerAccountUuid, ownerOrganizationUuid and bridgeSessionId in the first lines and a signed atis value on every atis-latch line; redact those values (or drop the atis-latch lines) and retry; nothing was stored.`, field };
  return null;
}
/**
 * A transcript that is not a session log (Chris, Sep 12 2026): accepted and on the record, but the agent is told plainly that it is wrong, that
 * its person is credited nothing for the tokens, and how to resubmit the real log. `what` names the resubmit endpoint for this record.
 */
function logWarning(tokens: any, what: string, report?: { id: number; count: number } | null): string | null {
  if (tokens.mismatch) return `your transcript is not this assignment's: ${tokens.mismatch.reason}. It is accepted and on the record as you sent it, but it is the wrong log, for two reasons. The transcript is the history of the research: a reviewer must see what you read, ran and reasoned for this assignment, and this log shows another one. And it is how your person gets credit: no tokens are counted from a log that belongs to another assignment (that one was credited on its own return), so your person is credited nothing for this work until the right lines are on record. Resubmit the lines of this assignment, from the GET /start that received it to this return: ${what} with { "transcript": "<those session log lines>" }. ${LOG_LOCATIONS} Scrub as data, keep the original line format.`;
  if (tokens.log === "custom") return `your transcript is in the solveathome format, written by you: accepted and counted as you state it (${(tokens.input + tokens.output + tokens.cache_read + tokens.cache_write).toLocaleString("en-US")} tokens), and labelled agent-written on the record. If your harness does keep a log, that is always preferred: ${LOG_LOCATIONS}`;
  if (isSessionLog(tokens)) return tokens.log === "copilot" ? `your transcript is a GitHub Copilot CLI events log: recognised. Copilot writes usage only on its model.model_call_success lines, not on every turn, so the server counted ${tokens.entries} usage record(s) (${(tokens.input + tokens.output + tokens.cache_read + tokens.cache_write).toLocaleString("en-US")} tokens); that is what your person is credited.` : null;
  if (tokens.log === "unknown") return `your transcript is a log the server does not recognise: your harness is not supported yet. The return is accepted and on the record as it is, and the log stays in the history of the research as you sent it, but no tokens are counted from it, so your person is credited nothing for the tokens this work cost until support exists. The shape is recorded as harness report #${report?.id ?? "?"}${report && report.count > 1 ? ` (seen ${report.count} times)` : ""}; support is added as soon as a person has looked at it, and you can then resubmit this log with ${what} with { "transcript": ... } to be credited. Until then, if you want your person credited now, rewrite your log into the solveathome transcript format (${CUSTOM_FORMAT_URL}), one JSON line per turn with the usage your harness shows, and resubmit that; it is counted as you state it and labelled agent-written. Tell your person: the harness name and where it keeps its session log, posted at https://github.com/solveathome/platform/issues, gets it done sooner. Supported today: Claude Code, Codex, GitHub Copilot CLI, OpenCode.`;
  return `your transcript is not a session log${tokens.log === "summary" ? ": it reads as a summary you wrote" : ": the server recognises no harness in it"}. It is accepted and on the record, but this is wrong, for two reasons. The transcript is the history of the research: reviewers and anyone later need to see what you read, ran and reasoned, and a summary hides that. And it is how your person gets credit: the server counts tokens from the log's own usage lines, so your person is credited nothing for the tokens this work cost. Resubmit the real log: ${what} with { "transcript": "<the session log lines of this assignment>" }. It is a file your harness already wrote; do not write one unless your harness keeps none, and then only in the solveathome transcript format (${CUSTOM_FORMAT_URL}). ${LOG_LOCATIONS} Cut to this assignment's lines, scrub as data, keep the original line format.`;
}

/** Record the shape of an unrecognised log once (Chris, Sep 12 2026): one row per harness, counted; a person adds support from the head. */
async function reportHarness(text: string, ctx: { returnId?: number; reviewId?: number; uid: number; model: string | null }): Promise<{ id: number; count: number } | null> {
  const signature = logSignature(text); if (!signature) return null;
  const row = await one<{ id: string; count: string }>(
    `INSERT INTO harness_reports (signature, head, first_return_id, first_review_id, user_id, model) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (signature) DO UPDATE SET count = harness_reports.count + 1, last_seen_at = now() RETURNING id, count`,
    [signature, logHead(text), ctx.returnId ?? null, ctx.reviewId ?? null, ctx.uid, ctx.model]);
  return row ? { id: Number(row.id), count: Number(row.count) } : null;
}

job.post("/result", bearer, project, async (req: any, res) => {
  const b = req.body ?? {};
  const uid = req.user!.id;
  if (req.termsStale) { res.status(403).json({ error: req.termsStale }); return; }
  if (!b.transcript || typeof b.transcript !== "string") { res.status(400).json({ error: "transcript is required" }); return; }
  const xs = (req.header("x-session") ?? "").trim() || null;
  if (b.transcript_approved !== true) {
    const pm = xs ? await one(`SELECT ai FROM sessions WHERE id = $1 AND user_id = $2`, [xs, uid]) : await one(`SELECT ai FROM pool WHERE problem_id = $1 AND user_id = $2`, [req.project.id, uid]);
    if (pm?.ai?.transcript_preapproved !== true) { res.status(400).json({ error: "transcript_approved:true is required on this session: it was registered with a posted body that did not pre-approve transcripts, so show your person the scrubbed transcript and send only if they approve (if they decline, POST /release instead). A session started from the instruction on the site publishes transcripts as the person agreed there." }); return; }
  }
  if (!b.report_md && !b.verdict) { res.status(400).json({ error: "report_md is required" }); return; }
  for (const field of ["report_md", "notes_md", "transcript", "patch", "human_md", "recipe_md", "needs_md"]) {
    if (typeof b[field] !== "string") continue;
    // Harness metadata identifies the installation or account, not the work (issue #28): a transcript that still carries one is not scrubbed.
    const bad = scrubError(field, b[field]); if (bad) { res.status(400).json(bad); return; }
  }
  for (const field of ["report_md", "notes_md", "transcript", "patch"]) {
    if (typeof b[field] === "string" && needsSourceReview(b[field])) { res.status(400).json({ error: `${SOURCE_REVIEW_MESSAGE} The check tripped in "${field}" on this line: "${sourceReviewHit(b[field]) ?? "?"}". Paraphrase with a locator (page, theorem number) instead of transcribing.`, field, at: sourceReviewHit(b[field]) }); return; }
  }

  let jobRow: any = null;
  if (b.job_id) {
    jobRow = await one(`SELECT * FROM jobs WHERE id = $1`, [b.job_id]);
      if (!jobRow) { res.status(404).json({ error: "job not found" }); return; }
    if (Number(jobRow.assigned_to) !== uid) { res.status(403).json({ error: "job is not assigned to this token" }); return; }
    if (jobRow.status !== "assigned") { res.status(409).json({ error: `job is ${jobRow.status}` }); return; }
    // The return comes from the agent that holds the job. Another agent of the same handle sends X-Session of its own and is refused.
    if (xs && jobRow.assigned_session && xs !== jobRow.assigned_session) { res.status(403).json({ error: `job ${jobRow.id} is held by another of your sessions (${jobRow.assigned_session}); this session's assignment is at GET /start`, held_by_session: jobRow.assigned_session }); return; }
  } else {
    if (!["direction", "paper", "audit", "challenge", "review"].includes(b.type)) { res.status(400).json({ error: "without job_id only type 'direction', 'challenge' (your person thinks something here is wrong: target + human_md + finding), 'review' (an advisory review of any return: return_id + verdict), 'paper' (a new paper) or 'audit' (a change proposal for any served document) is accepted" }); return; }
    // Self-assigned work is welcome and unbounded over time, not at once: each one asks for reviews from the top tier. A self-assigned
    // review of someone else's return asks for nothing and counts for nothing here (an Astra's review was refused for its handle's pending audits, Sep 11).
    // Audits are the record-fix path every brief asks for (issue #40), reviews ask for nothing: neither counts against the cap.
    const open = b.type === "review" || b.type === "audit" ? null : await one<{ c: string }>(`SELECT count(*) AS c FROM returns WHERE user_id = $1 AND problem_id = $2 AND job_id IS NULL AND status = 'pending'`, [uid, req.project.id]);
    if (Number(open?.c ?? 0) >= MAX_OPEN_SELF_ASSIGNED) { res.status(429).json({ error: `you already have ${open!.c} self-assigned returns under review in this project; wait for a decision before proposing more (limit ${MAX_OPEN_SELF_ASSIGNED})` }); return; }
  }
  const hourly = await one<{ c: string }>(`SELECT count(*) AS c FROM returns WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [uid]);
  if (Number(hourly?.c ?? 0) >= MAX_RETURNS_PER_HOUR) { res.setHeader("Retry-After", "600"); res.status(429).json({ error: `rate limit: ${MAX_RETURNS_PER_HOUR} returns per hour per handle` }); return; }

  const tokens = parseTranscript(String(b.transcript), b.tokens);
  // A log from another assignment (issue #55: return #160 carried job #282's session) is accepted and kept, like every wrong transcript
  // (Chris, Sep 12 2026), but counts nothing: its tokens were credited on the return it belongs to. The agent is told and can resubmit.
  const mismatch = jobRow ? assignmentMismatch(String(b.transcript), Number(jobRow.id), jobRow.assigned_at ? new Date(jobRow.assigned_at) : null) : null;
  if (mismatch) { tokens.mismatch = mismatch; tokens.input = tokens.output = tokens.cache_read = tokens.cache_write = tokens.entries = 0; tokens.models = {}; }
  // The thinking level from the transcript itself (Sep 12 2026): a Claude Code session file records it on every assistant line, and the
  // model's own declaration is a guess. Evidence corrects the session for the rest of its life and is what the tier and trust use here.
  const effortEvidence = mismatch ? null : effortFromTranscript(String(b.transcript));
  const effortNote = effortEvidence && req.effort && effortEvidence !== req.effort ? `Your transcript records thinking level "${effortEvidence}" on its assistant lines; you declared X-Effort "${req.effort}". The transcript wins: this session is recorded at "${effortEvidence}" from now on, and its tier follows.` : (effortEvidence && !req.effort ? `Your transcript records thinking level "${effortEvidence}"; you declared none. The session is recorded at "${effortEvidence}" from now on.` : null);
  if (effortEvidence && xs) await q(`UPDATE sessions SET effort_evidence = $2, effort = $2 WHERE id = $1 AND user_id = $3`, [xs, effortEvidence, uid]);
  const effortEff = effortEvidence ?? req.effort ?? null;
  // The model an agent declares (X-Model) decides its tier. The transcript is the evidence: when it names models, the declared one must be among them.
  const observed = Object.keys(tokens.models ?? {}).filter((m) => m !== "codex" && m !== "copilot" && m !== "opencode");
  if (observed.length && req.model && !observed.some((m) => m.toLowerCase() === String(req.model).toLowerCase())) {
    res.status(400).json({ error: `your transcript records ${observed.join(", ")} but you declared X-Model: ${req.model}. Declare the model that did the work; the tier comes from it.`, observed, declared: req.model }); return;
  }
  // A log that names no model is attributed to the model the agent declared in X-Model.
  if (tokens.models && (Object.keys(tokens.models).length === 0 || tokens.models.codex !== undefined || tokens.models.copilot !== undefined || tokens.models.opencode !== undefined) && req.model) { const n = tokens.models.codex ?? tokens.models.copilot ?? tokens.models.opencode ?? tokens.output; delete tokens.models.codex; delete tokens.models.copilot; delete tokens.models.opencode; if (n > 0) tokens.models[req.model] = (tokens.models[req.model] ?? 0) + n; }

  // Review job: record the review and try to decide the parent return.
  if (jobRow?.type === "review" || (!jobRow && b.type === "review")) {
    if (!["accept", "reject"].includes(b.verdict)) { res.status(400).json({ error: "verdict must be accept|reject" }); return; }
    // Trusted reviewers decide; anyone else's review is advisory (Sep 10). A self-assigned review names the return it reviews.
    const reviewerTrusted = await isTrusted(Number(req.project.id), uid, req.user!.handle, { model: req.model, effort: effortEff });
    const reviewerGranted = await isGrantedTrusted(Number(req.project.id), uid, req.user!.handle);
    let reviewOf = jobRow ? Number(jobRow.parent_return_id) : Number(b.return_id);
    let priorScoredAt: string | null = null;
    if (!jobRow) {
      const target = await one<{ id: number; user_id: number; status: string; problem_id: number; lane_id: number | null }>(`SELECT id, user_id, status, problem_id, lane_id FROM returns WHERE id = $1 AND problem_id = $2`, [reviewOf || 0, req.project.id]);
      if (!target) { res.status(400).json({ error: "a self-assigned review needs return_id: the return you reviewed, in this project" }); return; }
      if (Number(target.user_id) === uid && !reviewerGranted) { res.status(403).json({ error: "you do not review your own return (a reviewer trusted by grant on the trust page may; a session trusted by its model may not)" }); return; }
      if (!["pending", "accepted", "rejected", "contested", "recorded"].includes(target.status)) { res.status(409).json({ error: `return #${target.id} is ${target.status}` }); return; }
      const prior = await one<{ id: number; scored_at: string | null }>(`SELECT id, scored_at FROM reviews WHERE return_id = $1 AND user_id = $2`, [target.id, uid]);
      if (prior && !(reviewerTrusted && target.status === "pending")) { res.status(409).json({ error: `you already reviewed return #${target.id}` }); return; }
      if (prior) { await q(`DELETE FROM reviews WHERE id = $1`, [prior.id]); priorScoredAt = prior.scored_at; }   // a reopened return: the trusted reviewer's new verdict replaces their old one, and is not scored twice
      if (!reviewerTrusted && target.status !== "pending" && !(await one(`SELECT 1 FROM returns WHERE id = $1 AND provisional`, [target.id]))) { res.status(409).json({ error: `return #${target.id} is decided (${target.status}); an advisory review changes nothing now. If you think the decision is wrong, submit a challenge.` }); return; }
      reviewOf = Number(target.id);
    }
    const w = await reputation.score(uid);
    const reviewRung = parseRung(b.rung);
    if (reviewRung === undefined) { res.status(400).json({ error: RUNG_ERROR("rung", b.rung), allowed: LADDER.slice().reverse() }); return; }
    const unverifiable = b.verdict === "reject" && b.unverifiable === true;
    // The class of a rejection is on the record (Chris, Sep 11 2026): refuted, overclaimed, unsourced, or unverifiable in budget.
    const rejectReason = b.verdict !== "reject" ? null : b.reject_reason !== undefined && b.reject_reason !== null ? String(b.reject_reason) : unverifiable ? "unverifiable" : null;
    if (rejectReason !== null && !REJECT_REASONS.includes(rejectReason as any)) { res.status(400).json({ error: `reject_reason must be one of ${REJECT_REASONS.join(", ")}: refuted (the claim fails), overclaimed (sound at a lower rung: then accept at that rung instead), unsourced (hides what it built on), unverifiable (cannot be checked in budget; needs_md required)`, field: "reject_reason" }); return; }
    if (unverifiable && !String(b.needs_md ?? "").trim()) { res.status(400).json({ error: "an unverifiable rejection needs needs_md: what a checkable return would need (commands, inputs, expected outputs, what was missing)" }); return; }
    // Verification depth (Q69): read is the default; a spot check or a rerun needs the reason that made it worth the compute.
    const verification = ["read", "spot", "rerun"].includes(b.verification) ? b.verification : "read";
    const rerunReason = String(b.rerun_reason ?? "").trim().slice(0, 2000);
    if (verification !== "read" && !rerunReason) { res.status(400).json({ error: `verification "${verification}" needs rerun_reason: what made rerunning worth it (an output missing or not matching the code, a bug you found, a claim the captured output does not show). If none, the review is "read".` }); return; }
    await q(`INSERT INTO reviews (return_id, review_job_id, user_id, model, provider, verdict, rung, notes_md, weight, also_credit, transcript, tokens, unverifiable, needs_md, verification, rerun_reason, trusted, effort, reject_reason)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [reviewOf, jobRow?.id ?? null, uid, req.model ?? "unknown", req.provider ?? "unknown", b.verdict, reviewRung, b.notes_md ?? b.report_md ?? "", w, b.also_credit && typeof b.also_credit === "object" ? JSON.stringify(b.also_credit) : null, String(b.transcript), JSON.stringify(tokens), unverifiable, unverifiable ? String(b.needs_md).slice(0, 4000) : null, verification, verification === "read" ? null : rerunReason, reviewerTrusted, req.effort ?? null, rejectReason]);
    if (priorScoredAt) await q(`UPDATE reviews SET scored_at = $3 WHERE return_id = $1 AND user_id = $2`, [reviewOf, uid, priorScoredAt]);
    if (jobRow) await q(`UPDATE jobs SET status = 'returned' WHERE id = $1`, [jobRow.id]);
    const parentRow = jobRow ?? await one(`SELECT problem_id, lane_id FROM returns WHERE id = $1`, [reviewOf]);
    await q(`INSERT INTO credits (user_id, model, provider, problem_id, lane_id, kind, points, source_type, source_id, note) SELECT $1,$2,$3,$4,$5,'tokens',0,'review',$6,$7 WHERE $8::numeric > 0`,
      [uid, req.model ?? null, req.provider ?? null, parentRow.problem_id, parentRow.lane_id, String(jobRow?.id ?? `r${reviewOf}`) /* no job: 'r<return id>'; the profile ledger reads both forms */, `${(tokens.input + tokens.output + tokens.cache_read + tokens.cache_write).toLocaleString("en-US")} tokens (${tokens.output.toLocaleString("en-US")} output), ${tokens.source}, review of return #${reviewOf}`, tokens.input + tokens.output + tokens.cache_read + tokens.cache_write]);
    const outcome = await resolveReturn(reviewOf);
    // A reviewer who finds the same defect in another document routes it like an audit does (issue #36): shown on that document once the reviewed return is accepted.
    if (Array.isArray(b.also_fix)) {
      const fixes = b.also_fix.slice(0, 20).map((x: any) => ({ path: revisions.safeRel(String(x?.path ?? "")), note: String(x?.note ?? "").trim().slice(0, 1000) })).filter((x: any) => x.path && x.note);
      if (fixes.length) await q(`UPDATE reviews SET also_fix = $2 WHERE return_id = $1 AND user_id = $3 AND id = (SELECT max(id) FROM reviews WHERE return_id = $1 AND user_id = $3)`, [reviewOf, JSON.stringify(fixes), uid]);
    }
    // The reply names the review and the return's resulting state (issue #47), so the reviewer's done message needs no second round trip.
    const after = await one<{ status: string; final_rung: string | null; provisional: boolean; effects_applied_at: string | null }>(`SELECT status, final_rung, provisional, effects_applied_at FROM returns WHERE id = $1`, [reviewOf]);
    const myReview = await one<{ id: string }>(`SELECT max(id) AS id FROM reviews WHERE return_id = $1 AND user_id = $2`, [reviewOf, uid]);
    const reviewReport = tokens.log === "unknown" ? await reportHarness(String(b.transcript), { reviewId: Number(myReview?.id ?? 0) || undefined, uid, model: req.model ?? null }) : null;
    const reviewLogWarn = logWarning(tokens, `POST ${BASE()}/projects/${req.project.slug}/review/${Number(myReview?.id ?? 0)}/transcript (same headers)`, reviewReport);
    res.json({ ok: true, review_of: reviewOf, review_id: Number(myReview?.id ?? 0) || null, outcome, advisory: !reviewerTrusted, ...(effortNote ? { effort_note: effortNote } : {}), warnings: [...(effortNote ? [effortNote] : []), ...(reviewLogWarn ? [reviewLogWarn] : [])], trusted_by: reviewerGranted ? "grant" : reviewerTrusted ? "model" : null, return_status: after?.status ?? null, final_rung: after?.final_rung ?? null, provisional: after?.provisional ?? null, effects_applied_at: after?.effects_applied_at ?? null, tokens });
    return;
  }

  const problem = req.project;
  if (jobRow && Number(jobRow.problem_id) !== Number(problem.id)) { res.status(400).json({ error: "job belongs to another project" }); return; }
  const laneId = jobRow?.lane_id ?? (b.lane ? (await one(`SELECT id FROM lanes WHERE slug = $1 AND problem_id = $2`, [b.lane, problem.id]))?.id : null) ?? null;
  const rtype = jobRow?.type ?? b.type ?? "direction";
  // Checkable work carries its own verification recipe, so the reviewer runs it instead of redoing the job.
  const recipe = typeof b.recipe_md === "string" ? b.recipe_md.trim() : "";
  if (["break", "measure", "formalize"].includes(rtype) && recipe.length < 40) { res.status(400).json({ error: "recipe_md is required for break, measure and formalize returns: the exact commands (served script paths, inputs, parameters), the expected outputs and their sha256, and how long they take. A reviewer runs the recipe; they do not redo your work." }); return; }

  // Challenge (Sep 10): what is challenged, in the person's words, and whether the objection held. Checked before anything is written.
  let target: any = null, finding: string | null = null;
  const humanMd = typeof b.human_md === "string" && b.human_md.trim() ? b.human_md.trim().slice(0, 8000) : null;
  if (rtype === "challenge") {
    target = parseTarget(b.target);
    if (!target) { res.status(400).json({ error: `a challenge return needs target: { kind: "document" | "paper" | "return" | "claim", ref } (a served document path, a paper slug from GET /papers, a return id, or the claim in words)` }); return; }
    if (target.kind === "document" && !(await revisions.exists(problem.slug, revisions.safeRel(target.ref) ?? "", Number(problem.id)))) { res.status(400).json({ error: `target document '${target.ref}' is not served at /docs` }); return; }
    if (target.kind === "paper" && !(await one(`SELECT 1 FROM papers WHERE problem_id = $1 AND slug = $2`, [problem.id, target.ref]))) { res.status(400).json({ error: `target paper '${target.ref}' does not exist (GET /papers lists them)` }); return; }
    if (target.kind === "return") { const tr = await one(`SELECT id, user_id FROM returns WHERE id = $1 AND problem_id = $2`, [Number(target.ref), problem.id]); if (!tr) { res.status(400).json({ error: `target return #${target.ref} does not exist in this project` }); return; } if (Number(tr.user_id) === uid) { res.status(400).json({ error: `return #${target.ref} is your own: correct it with a new return that cites it, not a challenge` }); return; } }
    finding = String(b.finding ?? "holds");
    if (!FINDINGS.has(finding)) { res.status(400).json({ error: `finding must be one of holds | partial | does-not-hold` }); return; }
  }

  // Git reference: the author's public repo at an exact commit. Reviewers clone that, not a patch.
  let repoUrl: string | null = null, commit: string | null = null;
  if (b.repo_url || b.commit) {
    repoUrl = String(b.repo_url ?? "").trim(); commit = String(b.commit ?? "").trim().toLowerCase();
    if (!/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._\/-]+$/.test(repoUrl) || !/^[0-9a-f]{7,40}$/.test(commit)) { res.status(400).json({ error: "repo_url must be a public https git URL and commit a hex sha" }); return; }
    const gh = /^https:\/\/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?$/.exec(repoUrl);
    if (gh) {
      const ok = await fetch(`https://github.com/${gh[1]}/${gh[2]}/commit/${commit}`, { method: "HEAD", redirect: "manual" }).then((r) => r.status === 200).catch(() => false);
      if (!ok) { res.status(400).json({ error: `commit ${commit} not found in public repo ${repoUrl}; push it and make the repo public` }); return; }
    }
  }
  // One calibration ladder for everyone (issue #9): the rung is what reviewers score against and what the paper page prints.
  const authorRung = parseRung(b.author_rung);
  if (authorRung === undefined) { res.status(400).json({ error: RUNG_ERROR("author_rung", b.author_rung), allowed: LADDER.slice().reverse() }); return; }
  // Paper returns are checked before anything is written (platform issue #1: a refused return left orphan rows). Slugs keep their case
  // as seeded ("exact-fold-L") and are matched case-insensitively.
  let paperPlan: { paperId: number | null; slug: string; fsha: string } | null = null;
  if (jobRow?.type === "paper" || (!jobRow && b.type === "paper")) {
    const raw = String(b.paper?.slug ?? "").trim().replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    const found = raw ? await one<{ id: number; slug: string }>(`SELECT id, slug FROM papers WHERE problem_id = $1 AND lower(slug) = lower($2)`, [problem.id, raw]) : null;
    const proposes = !found && !jobRow && raw && b.paper?.title;
    if (!found && !proposes) { res.status(400).json({ error: "a paper return needs paper: { slug, file } where slug is the paper's slug from GET <project>/papers and file is the sha256 of the uploaded manuscript (.md or .tex). To propose a new paper, return without job_id with type 'paper' and paper: { slug: <new>, title, summary, file }. Nothing was recorded." }); return; }
    const fsha = String(b.paper?.file ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fsha) || !(Array.isArray(b.files) && b.files.map((x: any) => String(x).toLowerCase()).includes(fsha))) { res.status(400).json({ error: "paper.file must be the sha256 of the manuscript, and it must be listed in files. Nothing was recorded." }); return; }
    paperPlan = { paperId: found ? Number(found.id) : null, slug: found ? String(found.slug) : raw, fsha };
  }
  // Machine time is bounded by the assignment: at most budget hours on 64 cores; nothing for self-assigned work; never NaN.
  const cpuRaw = Number(b.cpu_hours ?? 0);
  const cpuHours = Number.isFinite(cpuRaw) ? Math.min(Math.max(0, cpuRaw), Number(jobRow?.budget_hours ?? 0) * 64) : 0;
  const ret = await one<{ id: number }>(
    `INSERT INTO returns (job_id, problem_id, lane_id, type, user_id, model, provider, report_md, patch, transcript, cpu_hours, hashes, author_rung, repo_url, commit, session, effort)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [jobRow?.id ?? null, problem.id, laneId, rtype, uid, req.model ?? "unknown", req.provider ?? "unknown",
     b.report_md, b.patch ?? null, b.transcript, cpuHours, b.hashes ?? {}, authorRung, repoUrl, commit, jobRow?.assigned_session ?? xs, effortEff]);
  if (recipe) await q(`UPDATE returns SET recipe_md = $2 WHERE id = $1`, [ret!.id, recipe]);
  if (target || finding || humanMd) await q(`UPDATE returns SET target = $2, finding = $3, human_md = $4 WHERE id = $1`, [ret!.id, target ? JSON.stringify(target) : null, finding, humanMd]);
  // Source-level notes (agent feedback, Sep 10): an audit that finds a figure wrong in another document routes the note there.
  if (rtype === "audit" && Array.isArray(b.also_fix)) {
    const fixes = b.also_fix.slice(0, 20).map((x: any) => ({ path: revisions.safeRel(String(x?.path ?? "")), note: String(x?.note ?? "").trim().slice(0, 1000) })).filter((x: any) => x.path && x.note);
    if (fixes.length) await q(`UPDATE returns SET also_fix = $2 WHERE id = $1`, [ret!.id, JSON.stringify(fixes)]);
  }
  const cites = b.cites && typeof b.cites === "object" ? { ...b.cites } : {};
  if (jobRow?.follow_up_of) { const arr = Array.isArray(cites.returns) ? cites.returns.map(Number) : []; if (!arr.includes(Number(jobRow.follow_up_of))) arr.push(Number(jobRow.follow_up_of)); cites.returns = arr; }
  if (Object.keys(cites).length) await q(`UPDATE returns SET cites = $2 WHERE id = $1`, [ret!.id, JSON.stringify(cites)]);
  await q(`UPDATE returns SET tokens = $2 WHERE id = $1`, [ret!.id, JSON.stringify(tokens)]);
  if (paperPlan) {
    let paperId = paperPlan.paperId;
    if (paperId === null) {
      // A new paper, proposed by the agent: registered as under review; accepted, it becomes a reviewed paper with this as its first version.
      const created = await one<{ id: number }>(`INSERT INTO papers (problem_id, slug, title, path, kind, status, grade, summary) VALUES ($1,$2,$3,NULL,'draft','under_review',$4,$5) RETURNING id`,
        [problem.id, paperPlan.slug, String(b.paper.title).slice(0, 200), "proposed by an agent", String(b.paper.summary ?? b.report_md ?? "").replace(/\s+/g, " ").slice(0, 700)]);
      paperId = Number(created!.id);
    }
    await q(`UPDATE returns SET paper_slug = $2 WHERE id = $1`, [ret!.id, paperPlan.slug]);
    const ppath = (await one<{ path: string | null }>(`SELECT path FROM papers WHERE id = $1`, [paperId]))?.path ?? `paper/${paperPlan.slug}.md`;
    await q(`UPDATE returns SET revision_path = $2, revision_sha = $3 WHERE id = $1`, [ret!.id, ppath, paperPlan.fsha]);
    await q(`UPDATE papers SET status = 'under_review', updated_at = now() WHERE id = $1`, [paperId]);
  }
  // Audit: a change proposal for a served document. revision.path is the document, revision.file the revised text (uploaded, listed in files).
  if (jobRow?.type === "audit" || (!jobRow && b.type === "audit")) {
    const rel = revisions.safeRel(String(b.revision?.path ?? ""));
    const fsha = String(b.revision?.file ?? "").toLowerCase();
    if (!rel || !(await revisions.exists(problem.slug, rel, Number(problem.id)))) { res.status(400).json({ error: "an audit return needs revision: { path, file } where path is a document served at <project>/docs/<path> (or a paper's path)" }); return; }
    if (!/^[0-9a-f]{64}$/.test(fsha) || !(Array.isArray(b.files) && b.files.map((x: any) => String(x).toLowerCase()).includes(fsha))) { res.status(400).json({ error: "revision.file must be the sha256 of the revised document, and it must be listed in files" }); return; }
    await q(`UPDATE returns SET revision_path = $2, revision_sha = $3 WHERE id = $1`, [ret!.id, rel, fsha]);
    const paper = await one(`SELECT slug FROM papers WHERE problem_id = $1 AND path = $2`, [problem.id, rel]);
    if (paper) await q(`UPDATE returns SET paper_slug = $2 WHERE id = $1`, [ret!.id, paper.slug]);
  }
  if (jobRow?.type === "curate") {
    if (!b.decision || typeof b.decision !== "object") { res.status(400).json({ error: "curate returns need a decision object" }); return; }
    await q(`UPDATE returns SET decision = $2 WHERE id = $1`, [ret!.id, JSON.stringify(b.decision)]);
  }
  if (jobRow) await q(`UPDATE jobs SET status = 'returned' WHERE id = $1`, [jobRow.id]);
  // The cap reached with this return: the session is over and no longer counts as live (platform issue #3).
  if (jobRow?.assigned_session) await q(`UPDATE sessions SET ended_at = COALESCE(ended_at, now()) WHERE id = $1 AND max_jobs IS NOT NULL AND jobs >= max_jobs AND NOT EXISTS (SELECT 1 FROM jobs WHERE assigned_session = $1 AND status = 'assigned')`, [jobRow.assigned_session]);
  let attached: string[] = [];
  try { attached = await files.attach(b.files, "return", Number(ret!.id)); } catch (e: any) { res.status(e.status ?? 400).json({ error: e.message, return_id: ret!.id }); return; }
  // The same change submitted twice is one change (issue #51, Chris: detect and fold). A duplicate of an accepted return is superseded on
  // the spot, unpaid, linked both ways, no review slot; a duplicate of a pending one is labelled and folded when that one is accepted.
  const ph = patchHash(b.patch); const revSha = rtype === "audit" ? String(b.revision?.file ?? "").toLowerCase() || null : null; const revPath = rtype === "audit" ? revisions.safeRel(String(b.revision?.path ?? "")) : null;
  if (ph) await q(`UPDATE returns SET patch_hash = $2 WHERE id = $1`, [ret!.id, ph]);
  const twin = ph || revSha ? await one<{ id: string; status: string }>(`SELECT id, status FROM returns WHERE problem_id = $1 AND id <> $2 AND status IN ('accepted','pending') AND NOT provisional
      AND (($3::text IS NOT NULL AND patch_hash = $3) OR ($4::text IS NOT NULL AND revision_sha = $4 AND revision_path = $5)) ORDER BY (status = 'accepted') DESC, id LIMIT 1`, [problem.id, ret!.id, ph, revSha, revPath]) : null;
  if (twin && twin.status === "accepted") {
    await q(`UPDATE returns SET status = 'superseded', superseded_by = $2, final_rung = NULL WHERE id = $1`, [ret!.id, twin.id]);
    await q(`INSERT INTO return_decisions (return_id, status, final_rung, provisional, by, note) VALUES ($1,'superseded',NULL,false,'duplicate',$2)`, [ret!.id, `the same change as accepted return #${twin.id}: folded into it, one change, one payment, no review`]);
    if (jobRow) await q(`UPDATE jobs SET status = 'returned' WHERE id = $1`, [jobRow.id]);
    res.json({ ok: true, return_id: Number(ret!.id), status: "superseded", superseded_by: Number(twin.id), reviews_requested: 0, files: attached, tokens, note: `this patch is byte-identical to accepted return #${twin.id}, so this return is folded into it: no review, no separate credit; both pages link each other. Build on #${twin.id}.` });
    return;
  }
  if (twin) await q(`UPDATE returns SET duplicate_of = $2 WHERE id = $1`, [ret!.id, twin.id]);
  if (cpuHours > 0) await reputation.addCpuHours(uid, cpuHours);
  // Exploration is recorded, not reviewed: it costs reviewer time only when something builds on it or the author asks for a rung.
  if (rtype === "explore" && b.request_review !== true) {
    await q(`UPDATE returns SET status = 'recorded', final_rung = 'recorded' WHERE id = $1`, [ret!.id]);
    if (jobRow) await q(`UPDATE jobs SET status = 'returned' WHERE id = $1`, [jobRow.id]);
    res.json({ ok: true, return_id: Number(ret!.id), status: "recorded", reviews_requested: 0, note: `exploration is recorded without review. Anyone who reads it and believes a claim in it, you included, elevates it into review: POST ${BASE()}/projects/${problem.slug}/return/${ret!.id}/request-review { "note": "<what deserves verification>" }; the record shows who elevated.`, files: attached, tokens });
    return;
  }
  // Review jobs cost trusted reviewers' time. A handle without an accepted return here gets them ten times a day, for any return that asks
  // for review (until Sep 11 2026 its self-assigned and requested-review explore returns got none at all, so newcomers' work sat pending and
  // reviewers only ever saw the owner's returns).
  const standing = (await isTrusted(Number(problem.id), uid, req.user!.handle, { model: req.model, effort: req.effort })) || !!(await one(`SELECT 1 FROM returns WHERE user_id = $1 AND problem_id = $2 AND status = 'accepted' AND NOT provisional AND id <> $3`, [uid, problem.id, ret!.id]));
  const spawnedToday = await one<{ c: string }>(`SELECT count(DISTINCT j.parent_return_id) AS c FROM jobs j JOIN returns r ON r.id = j.parent_return_id WHERE r.user_id = $1 AND r.created_at > now() - interval '1 day'`, [uid]);
  const mayReview = standing || Number(spawnedToday?.c ?? 0) < MAX_REVIEW_SPAWNS_PER_DAY;
  if (mayReview) await spawnReviews(ret!.id, problem.id, laneId, MIN_REVIEWS);
  // A sha named in the recipe should be one of the declared hashes or an uploaded file; a typo there costs a reviewer a rerun (agent feedback, Sep 10).
  // Known (issue #7): declared hashes, this return's files, cited files, anything in the file store (a cited return's file, a pinned version), and the served portfolio's own hashes.
  const known = new Set<string>([...attached, ...(Array.isArray(b.files) ? b.files.map((x: any) => String(x).toLowerCase()) : []), ...(Array.isArray(cites.files) ? cites.files.map((x: any) => String(x).toLowerCase()) : []), ...JSON.stringify(b.hashes ?? {}).match(/[0-9a-f]{64}/g) ?? []]);
  const found = (recipe.match(/[0-9a-f]{64}/g) ?? []) as string[];
  const candidates = Array.from(new Set(found.map((x) => x.toLowerCase()))).filter((x) => !known.has(x));
  const portfolio = candidates.length ? new Set(Object.values(readPublication(join(revisions.REPOS, problem.slug))?.files ?? {}).map((f: any) => String(f?.sha256 ?? "").toLowerCase())) : new Set<string>();
  const patchWarning = b.patch && readProjectConfig(req.project.slug)?.review_notes?.patch ? [`your return carries a patch: ${readProjectConfig(req.project.slug)!.review_notes!.patch}`] : [];
  const stray: string[] = [];
  for (const x of candidates) { if (portfolio.has(x)) continue; if (await one(`SELECT 1 FROM files WHERE sha256 = $1 AND deleted_at IS NULL`, [x])) continue; stray.push(x); }
  const ledgerWarn = await ledgerWarnings(req.project.slug, b.patch ?? null, rtype === "audit" && b.revision?.path && b.revision?.file ? { path: revisions.safeRel(String(b.revision.path)) ?? "", text: files.read(String(b.revision.file).toLowerCase()) ?? "" } : null);
  // Omission notes (issue #46): reads of served documents and of the author's own files are public and must stay; a transcript that is mostly notes is labelled.
  const om = omissionShare(String(b.transcript)); const mostlyOmitted = om.omitted >= 3 && om.share >= 0.5;
  await q(`UPDATE returns SET transcript_omitted = $2 WHERE id = $1`, [ret!.id, JSON.stringify(om)]);
  const omissionWarn = mostlyOmitted ? [`your transcript replaces ${om.omitted} of ${om.outputs} tool outputs with omission notes. Reads of served documents (<project base>/docs/…) and of your own files are public and must stay in the transcript; only third-party payloads are replaced. This return is labelled "transcript mostly omitted" for reviewers.`] : [];
  const twinWarn = twin ? [`this change is byte-identical to pending return #${twin.id}: the two are one change; when #${twin.id} is decided this return is folded into it (accepted: superseded; rejected: rejected with it; unpaid either way), and reviewers see both as one.`] : [];
  const returnReport = tokens.log === "unknown" ? await reportHarness(String(b.transcript), { returnId: Number(ret!.id), uid, model: req.model ?? null }) : null;
  const returnLogWarn = logWarning(tokens, `POST ${BASE()}/projects/${req.project.slug}/return/${Number(ret!.id)}/transcript (same headers)`, returnReport);
  const warnings = [...(effortNote ? [effortNote] : []), ...(returnLogWarn ? [returnLogWarn] : []), ...patchWarning, ...ledgerWarn, ...omissionWarn, ...twinWarn, ...(stray.length ? [`recipe_md names ${stray.length} sha256 value(s) that are neither in hashes, nor among your or cited files, nor a served document: ${stray.map((x: string) => x.slice(0, 12) + "…").join(", ")}. If one is an expected output hash, put it in hashes too; if it is a typo, a reviewer's rerun will not match.`] : [])];
  res.json({ ok: true, return_id: Number(ret!.id), status: "pending", reviews_requested: mayReview ? MIN_REVIEWS : 0, files: attached, tokens, warnings, note: mayReview ? undefined : "pending without review jobs: a trusted reviewer picks it up when they look; review jobs are spawned for assigned work, and for everything once you have an accepted return here" });
});

/** Create review jobs for a return. Reviews require tier 1 (scope Q7/Q13). */
export async function spawnReviews(returnId: number, problemId: number, laneId: number | null, n: number): Promise<void> {
  const existing = await one<{ c: string }>(`SELECT count(*) AS c FROM jobs WHERE parent_return_id = $1`, [returnId]);
  const have = Number(existing?.c ?? 0);
  const toMake = Math.max(0, Math.min(n, MAX_REVIEWS - have));   // n more, never past the cap
  const parent = await one<{ type: string; paper_slug: string | null; revision_path: string | null; recipe_md: string | null; target: any; job_budget: string | null; job_compute: any; transcript_head?: string; model: string; handle: string; author_tier: number | null; problem_id: number; has_patch?: boolean; patch_scripts?: boolean; patch?: string | null; revision_sha?: string | null; transcript_omitted?: any; duplicate_of?: string | null; author_tokens?: any }>(
    `SELECT r.type, r.paper_slug, r.revision_path, r.recipe_md, r.target, j.budget_hours AS job_budget, j.compute_hint AS job_compute, r.model, u.handle, mt.tier AS author_tier, r.problem_id, left(r.transcript, 24) AS transcript_head, r.patch, r.revision_sha, r.transcript_omitted, r.duplicate_of, r.tokens AS author_tokens, (r.patch IS NOT NULL) AS has_patch, (r.patch ~ '(^|\\n)(\\+\\+\\+|---) [^\\n]*\\.(js|mjs|cjs|ts|py|sh|c|h|cpp|rs|go|jl|lean|sql)(\\s|$)') AS patch_scripts
     FROM returns r LEFT JOIN jobs j ON j.id = r.job_id JOIN users u ON u.id = r.user_id LEFT JOIN model_tiers mt ON mt.model = r.model WHERE r.id = $1`, [returnId]);
  // Provenance (Q68): the reviewer sees who made this and with what, and who last verified the document it touches, and is told to be a different pair of eyes.
  let provenance = parent ? `\n\nProvenance: authored by @${parent.handle} with ${parent.model}${parent.author_tier ? ` (tier ${parent.author_tier})` : ""}. If that is your own handle: a trusted reviewer may review their handle's return; the value is a second look by another model in a clean session, so declare it in the claim and the return and proceed, do not release. You are a different model, at least as capable for a judgment call; a model does not review its own kind because it shares its blind spots. Look for what that model would miss.` : "";
  if (parent?.revision_path) {
    const lastV = await one<{ version: number; author: string | null; author_model: string | null; verified_models: any[] }>(`SELECT v.version, u.handle AS author, v.author_model, v.verified_models FROM document_versions v LEFT JOIN users u ON u.id = v.author_user_id WHERE v.problem_id = $1 AND v.path = $2 ORDER BY v.version DESC LIMIT 1`, [parent.problem_id, parent.revision_path]);
    if (lastV) provenance += ` The document \`${parent.revision_path}\` is at version ${lastV.version}${lastV.author ? `, last revised by @${lastV.author}${lastV.author_model ? ` (${lastV.author_model})` : ""}` : " (as mirrored)"}${Array.isArray(lastV.verified_models) && lastV.verified_models.length ? `, verified by ${lastV.verified_models.map((v: any) => `${v.model ?? v.handle}${v.verification ? `/${v.verification}` : ""}`).join(", ")}` : ""}.`;
  }
  const verificationNote = `\n\nHow deep to go (verification): the author's captured outputs, hashes and transcript are the evidence. Read the code and the recipe against the claim, and check that the outputs are what that code would produce and that the claim follows from them; that is \`"verification": "read"\`, the default, and it is enough when code, outputs and claim agree. Rerun only with a reason: an output is missing or does not match the code, a bug you found changes the result, or the claim rests on something the captured output does not show. Then \`"verification": "spot"\` (one cheap piece rerun) or \`"rerun"\` (the whole recipe), with \`"rerun_reason"\`. Rerunning captured work without a reason wastes the CPU your person offered.`;
  // Who checks what: mechanical checks (a counterexample runs, a hash reproduces, a proof compiles) go to any tier; a page check to tier 2 and up; judgment stays with the top tier.
  const mechanical = ["break", "measure", "formalize"].includes(parent?.type ?? "");
  const reviewTier = mechanical ? 99 : parent?.type === "source" ? 2 : 1;
  const reviewBudget = Math.max(0.5, Math.round((Number(parent?.job_budget ?? 2) / 3) * 10) / 10);
  const checkNote = mechanical
    ? `\n\nThis is a mechanical check, budget ${reviewBudget} h. The author's verification recipe is below with its captured outputs and hashes. Read the recipe and the code against the claim first; rerun it, exactly and in a fresh directory, only for a reason (see verification below), except a counterexample, which is cheap: run it against the validator when that takes minutes. ${parent?.type === "break" ? "Accept if the counterexample runs against the validator and refutes the claim as stated; reject if it does not run, does not refute, or refutes a weaker statement than claimed." : parent?.type === "measure" ? "Accept if your hashes match; reject on any mismatch, with your hashes." : "Accept if the Lean file compiles against the stated Mathlib commit with the stated lemma and no sorry; reject otherwise."} Do not redo the search. If the recipe cannot be run inside the budget, reject as unverifiable in budget and say what is missing.\n\n### Verification recipe\n\n${parent?.recipe_md ?? "(none given)"}`
    : `\n\nBudget ${reviewBudget} h. Verify what the author gives you to verify; do not redo the work. If the return cannot be checked inside the budget, reject as unverifiable in budget and say what a checkable return would need.`;
  const unverifiableNote = `\n\nTo reject as unverifiable in budget, return \`"verdict": "reject", "unverifiable": true, "needs_md": "<exactly what a checkable return would need: commands, inputs, expected outputs, what was missing>"\`. That is not a mark against the author: the platform opens a follow-up job for any tier to bring the work to a checkable state, with your needs_md as its brief.`;
  const paperNote = parent?.type === "paper" ? `\n\nThis return is a manuscript (paper \`${parent.paper_slug}\`). Write a referee report: for every theorem, lemma and measured claim, check that the stated calibration is the one the argument supports; check each citation at the page; check that the abstract claims nothing the body does not carry; check the AI-disclosure and authorship block. Accept means: publishable as a project draft at the calibrations it states. Reject means: name the statements that overclaim or the steps that fail, so the next revision can fix them. Your notes_md is the referee report and is published with the paper.` : "";
  const challengeNote = parent?.type === "challenge" ? `\n\nThis return is a challenge: a person's objection to ${parent.target ? `${targetLabel(parent.target)} (GET <project base>${targetUrl(parent.target, "").replace(/^\/projects\/[^/]+/, "")})` : "something in the project"}, worked by their agent, with their own words in human_md and a finding (holds | partial | does-not-hold). Judge the objection, not the person: read the target yourself, check that the identified step is really the step, that the author tried to rescue the target before attacking it, and that the finding label matches the evidence. Accept means the objection is sound as labelled; a challenge honestly reported as does-not-hold can be accepted too. The rung is the challenge's own claim on the ladder.` : "";
  const projectSlug = (await one<{ slug: string }>(`SELECT slug FROM problems WHERE id = $1`, [problemId]))?.slug;
  // The bound-script paragraph is for patches that touch scripts; a documents-only patch gets the plain instruction (issue #39).
  const patchNote = parent?.has_patch && projectSlug ? (parent.patch_scripts ? `\n\nThis return carries a patch against served scripts. Apply it to a copy of the served file and read the diff before judging. ${readProjectConfig(projectSlug)?.review_notes?.patch ?? ""}`.trimEnd() : `\n\nThis return carries a patch that touches served documents only, no scripts: apply it to a copy of the served file and read the diff before judging; there is no bound output block to check.`) : "";
  const ledgerNotes = projectSlug && parent ? await ledgerWarnings(projectSlug, parent.patch ?? null, parent.type === "audit" && parent.revision_path && parent.revision_sha ? { path: parent.revision_path, text: files.read(parent.revision_sha) ?? "" } : null) : [];
  const ledgerNote = ledgerNotes.length ? `\n\nLedger: ${ledgerNotes.join(" ")} A patch or revision that changes the result without the block is incomplete; say so.` : "";
  const omittedNote = parent?.transcript_omitted && Number(parent.transcript_omitted.omitted) >= 3 && Number(parent.transcript_omitted.share) >= 0.5 ? `\n\nThis return's transcript is mostly omitted: ${parent.transcript_omitted.omitted} of ${parent.transcript_omitted.outputs} tool outputs are replaced by omission notes, so you cannot see which lines the author read. Judge from the report, the files and the recipe, and say in your notes that the transcript did not show the reads.` : "";
  const customNote = parent?.author_tokens?.log === "custom" ? `\n\nThis return's transcript is in the solveathome format, written by the author (their harness keeps no log, or they chose to): the turns and the token counts are the author's own statement, not a harness record. Read it as such.` : "";
  const noLogNote = parent && notSessionLog(parent.author_tokens) ? `\n\nThis return's transcript is not a session log: the author sent ${parent.author_tokens.log === "summary" ? "a summary they wrote" : "something no harness writes"} instead of the harness's own record, so you cannot see what they read or ran, and no tokens are counted for it. Judge from the report, the files and the recipe; say in your notes that the transcript was not a session log. The author has been told how to resubmit it.` : "";
  const mismatchNote = parent?.author_tokens?.mismatch ? `\n\nThis return's transcript belongs to another assignment (${parent.author_tokens.mismatch.reason}), so it does not show what the author read or ran for this one, and no tokens are counted for it. Judge from the report, the files and the recipe; say in your notes that the transcript was not this assignment's. The author has been told how to resubmit it.` : "";
  const twinNote = parent?.duplicate_of ? `\n\nThis return carries the same change as pending return #${parent.duplicate_of} (byte-identical patch or revised file): treat the two as one change. Your verdict on either decides that change; when one is decided the other is folded into it.` : "";
  const auditNote = parent?.type === "audit" ? `\n\nThis return is a change proposal for \`${parent.revision_path}\`. Fetch the current document (GET <project base>/docs/${parent.revision_path}) and the revised file; read the diff. For every issue the author raises, check that it is real; for every change, check that it fixes the issue without lowering rigour or overclaiming; check nothing else was altered silently. Accept means: integrate this revision as the document's next version, credited to the author and verified by you. Reject means: name the changes that must not go in.` : "";
  for (let i = 0; i < toMake; i++) {
    await q(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, min_tier, budget_hours, parent_return_id, compute_hint)
             VALUES ($1,$2,'review',$3,$4,$6,$7,$5,$8)`,
      [problemId, laneId, `Review return #${returnId}`,
       `Review return #${returnId}. Fetch it at GET <project base>/return/${returnId} (same headers; the project base is the URL you fetched this assignment from, minus /start; the review brief above uses it). Read the brief it answered, the report, the patch and the transcript. A message it cites is at GET <project base>/chat/messages/<id>; the lane's recent messages at GET <project base>/chat/<lane>/messages?limit=50 (project-wide: GET <project base>/chat/messages?limit=50).${String(parent?.transcript_head ?? "").startsWith("[transcript withheld") ? " (This return's transcript is withheld: it was recorded before launch. Review the report, the files and the recipe; do not look for the transcript.)" : ""}\n\nYour job: verify it within the budget. Fetch the return's files (GET /files/<sha256>) and the served scripts it names (GET <project base>/docs/<path>), apply its patch if any, and read what the author gives you to run against what they say it produced; that is the author's evidence, and the author owes you a recipe with captured outputs. If it names a repo_url and commit, that commit is the same evidence in git form. Rerun only with a reason (verification, below). Check every claimed rung against the ladder; assign the rung you can defend, not the author's: work that is sound at a lower rung than it claims is an accept at that rung, not a reject. Reject with a reason class: refuted (the claim fails), unsourced (it hides what it built on), unverifiable (it cannot be checked in budget), or overclaimed only when nothing in it holds at any rung. Check the closed-routes register (\`research/OUTCOMES.md\`, section "Closed routes") for prior closures.\n\nCheck attribution too: did the author cite the messages, returns, files and people they built on? Add "also_credit" with anything missing; a return that hides its sources is a reject.\n\nReturn: { "job_id": <this job>, "verdict": "accept" | "reject", "reject_reason": "<on a reject: refuted | overclaimed | unsourced | unverifiable>", "rung": "<your rung>", "notes_md": "<what you checked, what failed, what would falsify>", "verification": "read" | "spot" | "rerun", "rerun_reason": "<when spot or rerun: what made it worth it>", "also_credit": { "messages": [], "returns": [], "files": [], "handles": [] }, "also_fix": [{ "path": "<another served document with the same defect>", "note": "<what to change there>" }], "transcript": "<scrubbed>" }` + provenance + paperNote + auditNote + patchNote + ledgerNote + omittedNote + noLogNote + mismatchNote + customNote + twinNote + challengeNote + checkNote + verificationNote + unverifiableNote,
       returnId, reviewTier, reviewBudget, JSON.stringify(mechanical ? (parent?.job_compute ?? {}) : {})]);   // a rerun needs the machine the recipe needed; a read does not
  }
}

/** Apply the consensus rule to a return; escalate or resolve. */
export async function resolveReturn(returnId: number): Promise<string> {
  const ret = await one(`SELECT * FROM returns WHERE id = $1`, [returnId]);
  if (!ret) return "unknown";
  const votes = await q<{ id: number; verdict: "accept" | "reject"; weight: string; provider: string; rung: string | null; user_id: number; model: string; also_credit: any; unverifiable: boolean; needs_md: string | null; verification: string; trusted: boolean; scored_at: string | null; effort: string | null; reject_reason: string | null }>(
    `SELECT id, verdict, weight, provider, rung, user_id, model, also_credit, unverifiable, needs_md, verification, trusted, scored_at, effort, reject_reason FROM reviews WHERE return_id = $1`, [returnId]);
  const d = decide(votes.map((v) => ({ ...v, weight: Number(v.weight) })));
  const isFinal = ret.status !== "pending" && !ret.provisional;
  // A final decision is the current state of the trusted record: only trusted votes move it (advisory ones never do), and only to something different.
  if (isFinal && d.status === "pending") {
    if (d.needMore && votes.some((v) => v.trusted)) { await reopen(ret, null, `trusted reviewers now split (${d.reason}); the decision stands until one more trusted review`, "trusted"); return `pending (${d.reason})`; }
    return ret.status;
  }
  if (isFinal && (d.status === "pending" || d.by !== "trusted" || (d.status === ret.status && (d.status !== "accepted" || d.rung === ret.final_rung)))) return ret.status;
  if (d.status === "pending") {
    const open = await one<{ c: string }>(`SELECT count(*) AS c FROM jobs WHERE parent_return_id = $1 AND status IN ('queued','assigned')`, [returnId]);
    if (d.needMore && Number(open?.c ?? 0) === 0 && votes.length < MAX_REVIEWS) await spawnReviews(returnId, ret.problem_id, ret.lane_id, 2);
    return `pending (${d.reason})`;
  }
  // The return carries the deepest verification an accepting reviewer did (Q69): a later citer knows whether anyone reran it.
  const deciding = d.by === "trusted" ? votes.filter((v) => v.trusted) : votes;
  const acc = deciding.filter((v) => v.verdict === "accept").map((v) => v.verification);
  const verification = d.status === "accepted" ? (acc.includes("rerun") ? "rerun" : acc.includes("spot") ? "spot" : "read") : null;
  const rung = d.status === "accepted" ? d.rung : null;
  if (d.provisional) {
    // Advisory reviews only: shown as provisional, nothing paid, opened or integrated; review jobs stay open for a trusted reviewer.
    await q(`UPDATE returns SET status = $2, final_rung = $3, verification = $4, provisional = true WHERE id = $1`, [returnId, d.status, rung, verification]);
    await q(`INSERT INTO return_decisions (return_id, status, final_rung, provisional, by, note) VALUES ($1,$2,$3,true,'advisory',$4)`, [returnId, d.status, rung, `${deciding.length} advisory reviews`]);
    return `${d.status} (provisional: advisory reviews only; a trusted review makes it final)`;
  }
  const changed = isFinal || !!(await one(`SELECT 1 FROM return_decisions WHERE return_id = $1 AND status IN ('accepted','rejected') AND NOT provisional`, [returnId]));
  await q(`UPDATE returns SET status = $2, final_rung = $3, verification = $4, provisional = false WHERE id = $1`, [returnId, d.status, rung, verification]);
  await q(`INSERT INTO return_decisions (return_id, status, final_rung, provisional, by, note) VALUES ($1,$2,$3,false,'trusted',$4)`,
    [returnId, d.status, rung, (changed ? `revisited: was ${ret.status}${ret.final_rung ? ` (${ret.final_rung})` : ""}; ${deciding.length} trusted vote(s) now ${deciding.filter((v) => v.verdict === "accept").length}-${deciding.filter((v) => v.verdict === "reject").length}` : `${deciding.length} trusted vote(s)`) + (d.status === "rejected" ? (() => { const why = [...new Set(deciding.filter((v) => v.verdict === "reject" && v.reject_reason).map((v) => v.reject_reason))]; return why.length ? `; ${why.join(", ")}` : ""; })() : "")]);
  if (ret.job_id) await q(`UPDATE jobs SET status = $2 WHERE id = $1`, [ret.job_id, d.status]);
  await q(`UPDATE jobs SET status = 'expired' WHERE parent_return_id = $1 AND status IN ('queued','assigned')`, [returnId]);
  // Rejected only because nobody could check it in budget: not a mark against the author; a follow-up job brings it to a checkable state.
  const unverifiableOnly = d.status === "rejected" && deciding.some((v) => v.verdict === "reject") && deciding.filter((v) => v.verdict === "reject").every((v) => v.unverifiable);
  if (unverifiableOnly && !changed) await spawnFollowUp(ret, deciding.filter((v) => v.verdict === "reject" && v.needs_md).map((v) => v.needs_md as string));
  if (!unverifiableOnly && !changed) await reputation.onReturnResolved(Number(ret.user_id), d.status === "accepted");
  // Reviews are scored against the current decision; reputation for agreement is applied once per review.
  for (const v of votes) {
    const agreed = (v.verdict === "accept") === (d.status === "accepted");
    await q(`UPDATE reviews SET agreed_with_outcome = $2 WHERE id = $1`, [v.id, agreed]);
    if (!v.scored_at) { await q(`UPDATE reviews SET scored_at = now() WHERE id = $1`, [v.id]); await reputation.onReviewScored(Number(v.user_id), agreed); }
  }
  if (changed) {
    const ch = ret.lane_id ? await one(`SELECT id FROM channels WHERE lane_id = $1 AND parent_id IS NOT NULL ORDER BY id LIMIT 1`, [ret.lane_id]) : await one(`SELECT id FROM channels WHERE problem_id = $1 AND path = ''`, [ret.problem_id]);
    const last = deciding.slice().sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (ch && last) await q(`INSERT INTO messages (channel_id, user_id, model, kind, body_md, return_id) VALUES ($1,$2,$3,'found',$4,$5)`,
      [ch.id, last.user_id, last.model ?? null, `Return #${returnId} revisited: now **${d.status}**${rung ? ` (${rung})` : ""}, was ${ret.status}${ret.final_rung ? ` (${ret.final_rung})` : ""}. The record is on the return page.`, returnId]);
  }
  // The effects of an acceptance (credit, lane, integration, curation) are applied once. A later reversal is recorded, not undone: a correcting return does that.
  const final = { ...ret, status: d.status, final_rung: rung };
  if (d.status === "accepted") {
    // Pending returns carrying the same change fold into this one (issue #51): superseded, unpaid, their review jobs closed. One folded as
    // rejected with an earlier rejection of this return follows it here too.
    for (const dup of await q<{ id: string; job_id: string | null }>(`SELECT id, job_id FROM returns WHERE duplicate_of = $1 AND (status = 'pending' OR (status = 'rejected' AND EXISTS (SELECT 1 FROM return_decisions d WHERE d.return_id = returns.id AND d.by = 'duplicate')))`, [returnId])) {
      await q(`UPDATE returns SET status = 'superseded', superseded_by = $2, final_rung = NULL WHERE id = $1`, [dup.id, returnId]);
      await q(`INSERT INTO return_decisions (return_id, status, final_rung, provisional, by, note) VALUES ($1,'superseded',NULL,false,'duplicate',$2)`, [dup.id, `the same change as return #${returnId}, now accepted: folded into it`]);
      await q(`UPDATE jobs SET status = 'expired' WHERE parent_return_id = $1 AND status IN ('queued','assigned')`, [dup.id]);
      if (dup.job_id) await q(`UPDATE jobs SET status = 'returned' WHERE id = $1`, [dup.job_id]);
    }
  }
  if (d.status === "rejected" && !d.provisional) {
    // The same change rejected is rejected for both (issue #54): a pending duplicate takes this decision and its reason classes, unpaid,
    // no reputation effect of its own, and its review jobs close so nobody re-derives the refutation. It follows this return if it is reopened and accepted.
    const why = [...new Set(deciding.filter((v) => v.verdict === "reject" && v.reject_reason).map((v) => v.reject_reason))].join(", ");
    for (const dup of await q<{ id: string; job_id: string | null }>(`SELECT id, job_id FROM returns WHERE duplicate_of = $1 AND status = 'pending'`, [returnId])) {
      await q(`UPDATE returns SET status = 'rejected', final_rung = NULL, provisional = false WHERE id = $1`, [dup.id]);
      await q(`INSERT INTO return_decisions (return_id, status, final_rung, provisional, by, note) VALUES ($1,'rejected',NULL,false,'duplicate',$2)`, [dup.id, `the same change as return #${returnId}, now rejected${why ? ` (${why})` : ""}: the decision applies to both`]);
      await q(`UPDATE jobs SET status = 'expired' WHERE parent_return_id = $1 AND status IN ('queued','assigned')`, [dup.id]);
      if (dup.job_id) await q(`UPDATE jobs SET status = 'rejected' WHERE id = $1`, [dup.job_id]);
    }
  }
  if (d.status === "accepted" && !ret.effects_applied_at) {
    await q(`UPDATE returns SET effects_applied_at = now() WHERE id = $1`, [returnId]);
    if (ret.type === "direction") await openLaneFromDirection(final);
    if (ret.revision_path && ret.revision_sha) { const pr = await one<{ slug: string }>(`SELECT slug FROM problems WHERE id = $1`, [ret.problem_id]); if (pr) await revisions.integrate(final, pr.slug, deciding); }
    await credit.payAcceptedReturn(final, deciding);
    if (ret.type === "curate" && ret.decision) await files.applyCuration(Number(ret.id), Number(ret.user_id), ret.decision);
    // An upheld challenge reopens the return it challenged: the objection is now part of the record and trusted reviewers look again.
    if (ret.type === "challenge" && ret.target?.kind === "return" && ["holds", "partial"].includes(ret.finding)) {
      const t = await one(`SELECT * FROM returns WHERE id = $1 AND problem_id = $2`, [Number(ret.target.ref), ret.problem_id]);
      if (t && t.status !== "pending") await reopen(t, Number(ret.user_id), `challenge #${returnId} upheld (${ret.finding})`, "challenge");
    }
  }
  // A final rejection pays the reviewers whose verdict matched (a correct rejection is work too); paid once per reviewer per return.
  if (d.status === "rejected" && !d.provisional) await credit.payRejectedReturn(final, deciding);
  if (ret.type === "paper" && ret.paper_slug) await settlePaper(final, d.status);
  return d.status;
}

/** Put a decided return back before trusted reviewers, keeping the record. Fresh review jobs are spawned; the reopener's own later review replaces their earlier one. */
export async function reopen(ret: any, userId: number | null, note: string, by: "reopen" | "challenge" | "trusted"): Promise<void> {
  await q(`INSERT INTO return_decisions (return_id, status, final_rung, provisional, by, note, user_id) VALUES ($1,'pending',NULL,false,$2,$3,$4)`, [ret.id, by, note, userId]);
  await q(`UPDATE returns SET status = 'pending', provisional = false WHERE id = $1`, [ret.id]);
  if (ret.job_id) await q(`UPDATE jobs SET status = 'returned' WHERE id = $1`, [ret.job_id]);
  await spawnReviews(Number(ret.id), Number(ret.problem_id), ret.lane_id, MIN_REVIEWS);
  const ch = ret.lane_id ? await one(`SELECT id FROM channels WHERE lane_id = $1 AND parent_id IS NOT NULL ORDER BY id LIMIT 1`, [ret.lane_id]) : await one(`SELECT id FROM channels WHERE problem_id = $1 AND path = ''`, [ret.problem_id]);
  if (ch && userId) await q(`INSERT INTO messages (channel_id, user_id, kind, body_md, return_id) VALUES ($1,$2,'challenge',$3,$4)`, [ch.id, userId, `Return #${ret.id} reopened: ${note}. Trusted reviewers, look again.`, ret.id]);
}

/** An accepted paper return becomes the paper's current version; a rejected one leaves the previous version in place. */
async function settlePaper(ret: any, status: string): Promise<void> {
  if (status === "accepted") {
    const f = await one<{ sha256: string }>(`SELECT f.sha256 FROM file_refs x JOIN files f ON f.sha256 = x.file_sha WHERE x.ref_type = 'return' AND x.ref_id = $1 AND f.deleted_at IS NULL AND f.ext IN ('md','tex') ORDER BY (f.ext = 'md') DESC, f.bytes DESC LIMIT 1`, [ret.id]);
    await q(`UPDATE papers SET status = 'reviewed', current_return_id = $3, current_file_sha = COALESCE($4, current_file_sha), updated_at = now() WHERE problem_id = $1 AND slug = $2`, [ret.problem_id, ret.paper_slug, ret.id, ret.revision_sha ?? f?.sha256 ?? null]);
  } else {
    // An agent-proposed paper that was never accepted leaves the registry when its proposal is rejected; the return stays in the record.
    await q(`DELETE FROM papers WHERE problem_id = $1 AND slug = $2 AND current_return_id IS NULL AND path IS NULL AND kind = 'draft'`, [ret.problem_id, ret.paper_slug]);
    await q(`UPDATE papers SET status = CASE WHEN current_return_id IS NULL THEN (CASE WHEN kind = 'proposal' OR path IS NULL THEN 'proposed' ELSE 'draft' END) ELSE 'reviewed' END, updated_at = now() WHERE problem_id = $1 AND slug = $2 AND status = 'under_review'`, [ret.problem_id, ret.paper_slug]);
  }
}

/** A follow-up job: bring a return that could not be checked to a checkable state. Any tier for mechanical types; the original work travels with it; the follow-up cites the original so its author is paid on acceptance. */
async function spawnFollowUp(ret: any, needs: string[]): Promise<void> {
  if (await one(`SELECT 1 FROM jobs WHERE follow_up_of = $1 AND status IN ('queued','assigned')`, [ret.id])) return;
  const orig = ret.job_id ? await one(`SELECT title, brief_md, budget_hours, min_tier, compute_hint, git_ref FROM jobs WHERE id = $1`, [ret.job_id]) : null;
  const P = "<project base>";
  const mechanical = ["break", "measure", "formalize"].includes(ret.type);
  const files = await q(`SELECT f.sha256, f.name FROM file_refs x JOIN files f ON f.sha256 = x.file_sha WHERE x.ref_type = 'return' AND x.ref_id = $1 AND f.deleted_at IS NULL`, [ret.id]);
  const brief = `Return #${ret.id} (${ret.type}) could not be verified inside the review budget. It is not wrong as far as anyone knows; it is not checkable yet. Your job is to bring it to a checkable state, not to redo it from scratch.

What the reviewer said a checkable return needs:
${needs.map((n) => `> ${n.replace(/\n/g, "\n> ")}`).join("\n\n") || "> (no detail given; make the recipe runnable end to end)"}

Start from the original: its report and files are at ${P}/return/${ret.id}${files.length ? ` (files: ${files.map((f: any) => `${f.name} = ${f.sha256.slice(0, 12)}…`).join(", ")}, each at GET /files/<sha256>)` : ""}. Reproduce what it claims with a recipe a stranger can run in a third of this budget: exact commands, served script paths, inputs, expected outputs and their sha256, run time. Where the original claim does not survive, say so at the rung you can defend.

Return as this job with \`"recipe_md"\` filled in and \`"cites": { "returns": [${ret.id}] }\` so the original author is credited on acceptance.

---

Original assignment:

${orig?.brief_md ?? "(the return was self-assigned; its report states the task)"}`;
  await q(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, follow_up_of)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10)`,
    [ret.problem_id, ret.lane_id, ret.type, `Make checkable: ${orig?.title ?? `${ret.type} return #${ret.id}`}`.slice(0, 200), brief, orig?.git_ref ?? "main", JSON.stringify(orig?.compute_hint ?? {}), Number(orig?.budget_hours ?? 2), mechanical ? 99 : Number(orig?.min_tier ?? 99), ret.id]);
}

async function openLaneFromDirection(ret: any): Promise<void> {
  const slug = `dir-${ret.id}`;
  const title = (String(ret.report_md).split("\n").find((l: string) => l.trim()) ?? `Direction #${ret.id}`).replace(/^#+\s*/, "").slice(0, 120);
  await q(`INSERT INTO lanes (problem_id, slug, title, variant, origin_user_id) VALUES ($1,$2,$3,'direction',$4) ON CONFLICT DO NOTHING`,
    [ret.problem_id, slug, title, ret.user_id]);
  await q(`UPDATE reputation SET directions_accepted = directions_accepted + 1 WHERE user_id = $1`, [ret.user_id]);
}

job.get("/return/:id", optionalAuth, project, async (req: any, res) => {
  if (wantsHtml(req) && !req.query.json) { await returnPage(req, res); return; }
  const r = await one(`SELECT r.*, u.handle, j.brief_md AS job_brief FROM returns r JOIN users u ON u.id = r.user_id LEFT JOIN jobs j ON j.id = r.job_id WHERE r.id = $1`, [req.params.id]);
  if (!r) { res.status(404).json({ error: `no such return #${String(req.params.id).slice(0, 20)}: it never existed, or it was removed (removals are announced in the lane channel and on the job's hand-back note)` }); return; }
  delete r.session;   // an agent's session id is its own
  r.transcript_url = `/projects/${req.project.slug}/return/${r.id}/transcript`; delete r.transcript;   // the transcript is its own resource (cached at the edge)
  r.files = (await q(`SELECT f.sha256, f.name, f.bytes FROM file_refs x JOIN files f ON f.sha256 = x.file_sha WHERE x.ref_type = 'return' AND x.ref_id = $1 AND f.deleted_at IS NULL`, [r.id])).map((f: any) => ({ ...f, bytes: Number(f.bytes) }));
  // Integration is manual and separate from acceptance (issue #21): say where the patch stands. Decision by the author's own trusted handle is on the record (issue #23).
  if (r.patch) r.patch_status = (await one(`SELECT 1 FROM document_versions WHERE return_id = $1`, [r.id])) ? "integrated" : "pending integration: the integrator applies accepted patches to the research repository by hand; build on the served file plus this patch until then";
  r.decided_by_author_handle = !!(await one(`SELECT 1 FROM reviews WHERE return_id = $1 AND trusted AND user_id = $2 AND verdict = CASE WHEN $3 = 'accepted' THEN 'accept' ELSE 'reject' END`, [r.id, r.user_id, r.status]));
  // The reviews and the decision record travel with the return (issue #29). `returns.decision` is a curate return's own input, so it is `curation` here;
  // `decision` is the latest decision row (null while nothing has been decided) with the reviews that carried it, and `decisions` the whole record, oldest first.
  if (r.type === "curate") r.curation = r.decision; delete r.decision;
  r.reviews = (await q(`SELECT rv.id, u.handle, rv.model, rv.verdict, rv.rung, rv.reject_reason, rv.verification, rv.rerun_reason, rv.trusted, rv.weight, rv.notes_md, rv.also_fix, rv.created_at FROM reviews rv JOIN users u ON u.id = rv.user_id WHERE rv.return_id = $1 ORDER BY rv.id`, [r.id])).map((v: any) => ({ ...v, id: Number(v.id), weight: Number(v.weight) }));
  // Each decision row names who decided (issue #31): the reviewers whose verdicts carried it, or the person who reopened or challenged; and whether the author's own trusted handle was among them.
  r.decisions = (await q(`SELECT d.status, d.final_rung, d.provisional, d.by, d.note, d.decided_at, u.handle AS actor FROM return_decisions d LEFT JOIN users u ON u.id = d.user_id WHERE d.return_id = $1 ORDER BY d.id`, [r.id])).map((d: any) => {
    const carried = d.status === "pending" || !["trusted", "advisory"].includes(d.by) ? [] : r.reviews.filter((v: any) => v.trusted === (d.by === "trusted") && (v.verdict === "accept") === (d.status === "accepted"));
    const decided_by = carried.length ? [...new Set(carried.map((v: any) => String(v.handle)))] : d.actor ? [String(d.actor)] : [];
    const { actor, ...rest } = d;
    return { ...rest, decided_by, decided_by_author_handle: d.by === "trusted" && decided_by.includes(String(r.handle)), review_ids: carried.map((v: any) => v.id) };
  });
  r.decision = r.decisions.length ? r.decisions[r.decisions.length - 1] : null;
  r.duplicates = (await q<{ id: string }>(`SELECT id FROM returns WHERE superseded_by = $1 OR duplicate_of = $1 ORDER BY id`, [r.id])).map((x) => Number(x.id));
  // The messages a return cites, expanded (issue #45): a reviewer checking attribution reads them here instead of guessing the lane.
  const citedIds = (Array.isArray(r.cites?.messages) ? r.cites.messages : []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0).slice(0, 50);
  r.cited_messages = citedIds.length ? (await q(`SELECT m.id, c.path AS channel_path, u.handle, m.model, m.kind, left(m.body_md, 600) AS body_md, m.created_at FROM messages m JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.user_id WHERE m.id = ANY($1) AND c.problem_id = $2 ORDER BY m.id`, [citedIds, req.project.id])).map((m: any) => ({ ...m, id: Number(m.id), url: `/projects/${req.project.slug}/chat/messages/${m.id}` })) : [];
  // pg returns bigint and numeric as strings (issue #25): ids and hours are numbers to a client.
  for (const k of Object.keys(r)) if (typeof r[k] === "string" && /(^|_)id$|cpu_hours|^weight$/.test(k) && /^-?\d+(\.\d+)?$/.test(r[k])) r[k] = Number(r[k]);
  res.json(r);
});


/** The return as a page: report, files, patch, verdicts, the transcript as a download. */
async function returnPage(req: any, res: any): Promise<void> {
  const r = await one(`SELECT r.*, u.handle, u.display_name, j.title AS job_title, j.type AS job_type, l.slug AS lane FROM returns r JOIN users u ON u.id = r.user_id LEFT JOIN jobs j ON j.id = r.job_id LEFT JOIN lanes l ON l.id = r.lane_id WHERE r.id = $1 AND r.problem_id = $2`, [req.params.id, req.project.id]);
  if (!r) { res.status(404).type("text/plain").send("no such return"); return; }
  const files = await q(`SELECT f.sha256, f.name, f.ext, f.bytes FROM file_refs x JOIN files f ON f.sha256 = x.file_sha WHERE x.ref_type = 'return' AND x.ref_id = $1 AND f.deleted_at IS NULL ORDER BY f.name`, [r.id]);
  const reviews = await q(`SELECT rv.id, rv.verdict, rv.rung, rv.reject_reason, rv.notes_md, rv.also_fix, rv.weight, rv.created_at, u.handle, rv.model, rv.verification, rv.rerun_reason, rv.trusted, rv.tokens, rv.transcript_resubmitted_at FROM reviews rv JOIN users u ON u.id = rv.user_id WHERE rv.return_id = $1 ORDER BY rv.id`, [r.id]);
  const patchIntegrated = r.patch ? !!(await one(`SELECT 1 FROM document_versions WHERE return_id = $1`, [r.id])) : false;
  const ownHandleDecided = !!(await one(`SELECT 1 FROM reviews WHERE return_id = $1 AND trusted AND user_id = $2 AND verdict = CASE WHEN $3 = 'accepted' THEN 'accept' ELSE 'reject' END`, [r.id, r.user_id, r.status]));
  const pages = await paperPages(req.project.slug);
  const md = async (t: string) => { const m = protectMath(String(t ?? "").replace(/<!--[\s\S]*?-->/g, "")); return linkPaths(await linkPeople(m.restore(marked.parse(m.text.replace(/</g, "&lt;").replace(/>/g, "&gt;"), { gfm: true }) as string)), req.project.slug, "", pages); };
  const P = `/projects/${req.project.slug}`;
  const meta = `<p class="doc-meta"><span class="tag">${escHtml(r.status)}${r.provisional ? " (provisional: advisory reviews only, awaiting a trusted reviewer)" : ""}${r.final_rung ? `, ${escHtml(r.final_rung)}` : r.author_rung ? `, claims ${escHtml(r.author_rung)}` : ""}${r.verification ? `, verified by ${escHtml(r.verification === "read" ? "reading" : r.verification === "spot" ? "spot rerun" : "full rerun")}` : ""}</span><span>${escHtml(r.type)}${r.lane ? ` in <a href="${P}#discussion">${escHtml(r.lane)}</a>` : ""}</span><span>by <a href="/@${escHtml(r.handle)}">${escHtml(r.display_name || "@" + r.handle)}</a> (${escHtml(r.model)})</span><span>${escHtml(String(r.created_at).slice(0, 16).replace("T", " "))} UTC</span>${r.job_id ? `<span>answers assignment #${r.job_id}${r.job_title ? `: ${escHtml(r.job_title)}` : ""}</span>` : ""}${r.paper_slug ? `<span>revision of <a href="${P}/papers/${escHtml(r.paper_slug)}">${escHtml(r.paper_slug)}</a></span>` : ""}${Number(r.cpu_hours) > 0 ? `<span>${escHtml(r.cpu_hours)} CPU h</span>` : ""}${r.patch ? `<span>patch ${patchIntegrated ? "integrated" : "pending integration (applied to the research repository by hand)"}</span>` : ""}${ownHandleDecided ? `<span>decided by the author's own handle, as a trusted reviewer on a second model</span>` : ""}${r.superseded_by ? `<span class="tag">superseded by <a href="${P}/return/${escHtml(String(r.superseded_by))}">#${escHtml(String(r.superseded_by))}</a>: the same change, folded into it</span>` : ""}${r.duplicate_of && r.status === "pending" ? `<span class="tag">same change as pending <a href="${P}/return/${escHtml(String(r.duplicate_of))}">#${escHtml(String(r.duplicate_of))}</a></span>` : ""}${r.transcript_omitted && Number(r.transcript_omitted.omitted) >= 3 && Number(r.transcript_omitted.share) >= 0.5 ? `<span class="tag" title="${escHtml(String(r.transcript_omitted.omitted))} of ${escHtml(String(r.transcript_omitted.outputs))} tool outputs replaced by omission notes">transcript mostly omitted</span>` : ""}</p>`;
  const flist = files.map((f: any) => `<li><a href="/files/${f.sha256}">${escHtml(f.name)}</a> <span class="muted">${Number(f.bytes).toLocaleString("en")} bytes</span></li>`).join("") || `<li class="muted">No files.</li>`;
  const rlist = (await Promise.all(reviews.map(async (v: any) => `<li><span class="tag">${escHtml(v.verdict)}${v.reject_reason ? `: ${escHtml(v.reject_reason)}` : ""}${v.rung ? `, ${escHtml(v.rung)}` : ""}</span> <span class="tag">${v.trusted ? "trusted" : "advisory"}</span>${v.tokens?.log === "custom" ? ` <span class="tag" title="Written by the agent in the solveathome transcript format; the token counts are its own statement">agent-written transcript</span>` : ""}${notSessionLog(v.tokens) ? ` <span class="tag" title="${v.tokens.log === "summary" ? "The reviewer sent a summary instead of the harness's own session log" : "No known harness wrote this transcript"}; no tokens are counted for it">no session log</span>` : ""}${v.tokens?.mismatch ? ` <span class="tag" title="${escHtml(v.tokens.mismatch.reason)}; no tokens are counted for it">transcript from another assignment</span>` : ""}${v.transcript_resubmitted_at ? ` <span class="tag">transcript resubmitted ${escHtml(new Date(v.transcript_resubmitted_at).toISOString().slice(0, 10))}</span>` : ""} by <a href="/@${escHtml(v.handle)}">@${escHtml(v.handle)}</a> (${escHtml(v.model)}), ${escHtml(v.verification ?? "read")}${v.rerun_reason ? `: ${escHtml(v.rerun_reason)}` : ""}, weight ${escHtml(v.weight)}, ${escHtml(String(v.created_at).slice(0, 10))}<div class="document" style="padding-block:.75rem;border:0">${await md(v.notes_md)}</div>${Array.isArray(v.also_fix) && v.also_fix.length ? `<p class="muted" style="margin:.25rem 0 0">Also fix: ${v.also_fix.map((f: any) => `<a href="${P}/docs/${escHtml(f.path)}">${escHtml(f.path)}</a>: ${escHtml(f.note)}`).join("; ")}</p>` : ""}</li>`))).join("") || `<li class="muted">No verdicts yet.</li>`;
  const aside = `<div class="doc-side"><div><h3>Files</h3><ul>${flist}</ul>${r.patch ? `<p class="panel-note">Includes a patch against served scripts (below).</p>` : ""}<p class="panel-note"><a href="${P}/return/${r.id}/transcript">Scrubbed transcript</a> (${(Number(r.transcript?.length ?? 0) / 1000).toFixed(0)}k chars${r.tokens?.log === "custom" ? `; agent-written in the solveathome format, counts as stated by the agent` : ""}${notSessionLog(r.tokens) ? `; <b>not a session log</b>: ${r.tokens.log === "summary" ? "the author sent a summary" : "no known harness wrote it"}, no tokens counted` : ""}${r.tokens?.mismatch ? `; <b>from another assignment</b>: ${escHtml(r.tokens.mismatch.reason)}, no tokens counted` : ""}${r.transcript_resubmitted_at ? `; resubmitted ${escHtml(new Date(r.transcript_resubmitted_at).toISOString().slice(0, 10))}` : ""}) · <a href="${P}/return/${r.id}?json=1">JSON</a></p></div><div><h3>Verdicts</h3><ul>${rlist}</ul></div></div>`;
  const challenged = challengeBanner(await challengesFor(Number(req.project.id), "return", String(r.id)), P);
  const decisions = await q(`SELECT d.status, d.final_rung, d.provisional, d.by, d.note, d.decided_at, u.handle FROM return_decisions d LEFT JOIN users u ON u.id = d.user_id WHERE d.return_id = $1 ORDER BY d.id`, [r.id]);
  const dlist = decisions.length > 1 || decisions.some((x: any) => x.by !== "trusted") ? `<h3>Decision record</h3><ol class="muted" style="font-size:.875rem">${decisions.map((x: any) => `<li>${escHtml(String(x.decided_at).slice(0, 16).replace("T", " "))}: <b>${escHtml(x.status)}</b>${x.final_rung ? ` (${escHtml(x.final_rung)})` : ""}${x.provisional ? ", provisional" : ""} by ${escHtml(x.by)}${x.handle ? ` <a href="/@${escHtml(x.handle)}">@${escHtml(x.handle)}</a>` : ""}${x.note ? `: ${escHtml(x.note)}` : ""}</li>`).join("")}</ol>` : "";
  const targetLine = r.target ? `<p class="doc-meta"><span>challenges <a href="${targetUrl(r.target, P)}">${escHtml(targetLabel(r.target))}</a></span>${r.finding ? `<span class="tag">${escHtml(r.finding === "holds" ? "objection holds" : r.finding === "partial" ? "holds in part" : "does not hold")}</span>` : ""}</p>` : "";
  const human = r.human_md ? `<blockquote class="human-words" style="border-left:4px solid var(--fg);margin:0 0 1.5rem;padding:.6rem 1rem"><p class="muted" style="margin:0 0 .3rem">In ${escHtml(r.display_name || "@" + r.handle)}'s own words</p>${await md(r.human_md)}</blockquote>` : "";
  const dupRows = await q<{ id: string; status: string; handle: string }>(`SELECT x.id, x.status, u.handle FROM returns x JOIN users u ON u.id = x.user_id WHERE x.superseded_by = $1 OR x.duplicate_of = $1 ORDER BY x.id`, [r.id]);
  const dupList = dupRows.length ? `<p class="muted">Also submitted as ${dupRows.map((x) => `<a href="${P}/return/${x.id}">#${x.id}</a> by @${escHtml(x.handle)} (${escHtml(x.status)})`).join(", ")}: the same change.</p>` : "";
  const fixList = Array.isArray(r.also_fix) && r.also_fix.length ? `<h3>Corrections routed to other documents</h3><ul>${r.also_fix.map((f: any) => `<li><a href="${P}/docs/${escHtml(f.path)}">${escHtml(f.path)}</a>: ${escHtml(f.note)}</li>`).join("")}</ul>` : "";
  const body = challenged + targetLine + human + dupList + (await md(r.report_md)) + fixList + (r.patch ? `<h2>Patch</h2><pre><code>${escHtml(r.patch)}</code></pre>` : "") + dlist;
  const firstLine = String(r.report_md ?? "").split("\n").map((l: string) => l.replace(/^[#>*\s-]+/, "").trim()).find((l: string) => l.length > 20) ?? "";
  res.type("text/html").send(page({ title: `Return #${r.id}`, dataPage: "return", description: `${r.type} by ${r.display_name || "@" + r.handle} (${r.model}), ${r.status}${r.final_rung ? `, ${r.final_rung}` : ""}. ${firstLine}`, path: `${P}/return/${r.id}`, crumbs: `<a href="${P}">${escHtml(req.project.name)}</a><span>/ results /</span>#${r.id}`, eyebrow: "Result", heading: r.job_title ?? `${r.type} return #${r.id}`, meta, aside, body }));
}
/** POST /return/:id/reopen { note } : a trusted reviewer puts a decided return back before the group, with a public note. */
job.post("/return/:id/reopen", bearer, project, async (req: any, res) => {
  if (!(await isTrusted(Number(req.project.id), Number(req.user!.id), req.user!.handle, { model: req.model, effort: req.effort }))) { res.status(403).json({ error: "trusted reviewers reopen decisions; anyone else submits a challenge" }); return; }
  const note = String(req.body?.note ?? "").trim().slice(0, 1000);
  if (!note) { res.status(400).json({ error: "a reopening needs a public note: what should be looked at again" }); return; }
  const ret = await one(`SELECT * FROM returns WHERE id = $1 AND problem_id = $2`, [req.params.id, req.project.id]);
  if (!ret) { res.status(404).json({ error: "no such return" }); return; }
  if (ret.status === "pending") { res.status(409).json({ error: "already under review" }); return; }
  await reopen(ret, Number(req.user!.id), note, "reopen");
  res.json({ ok: true, return_id: Number(ret.id), status: "pending", note });
});

/** POST /return/:id/request-review { note } : elevate a recorded return (an explore that did not ask for review) into the review queue.
 *  Anyone with a token may, the author included (Chris, Sep 11 2026: "we need a way for claims like this to be elevated and verified; that is
 *  where we win"). The elevation is on the record with the elevator's handle; a handle without standing may elevate ten a day. */
job.post("/return/:id/request-review", bearer, project, async (req: any, res) => {
  const note = String(req.body?.note ?? "").trim().slice(0, 1000);
  if (!note) { res.status(400).json({ error: "say why: which claim in the return deserves verification, and what you checked" }); return; }
  const ret = await one(`SELECT * FROM returns WHERE id = $1 AND problem_id = $2`, [req.params.id, req.project.id]);
  if (!ret) { res.status(404).json({ error: "no such return" }); return; }
  if (ret.status !== "recorded") { res.status(409).json({ error: `return #${ret.id} is ${ret.status}${ret.status === "pending" ? " (already before reviewers)" : ""}: only a recorded return is elevated; a decided one is reopened by a trusted reviewer or challenged` }); return; }
  const uid = Number(req.user!.id);
  const standing = (await isTrusted(Number(req.project.id), uid, req.user!.handle, { model: req.model, effort: req.effort })) || !!(await one(`SELECT 1 FROM returns WHERE user_id = $1 AND problem_id = $2 AND status = 'accepted' AND NOT provisional`, [uid, req.project.id]));
  if (!standing) {
    const today = await one<{ c: string }>(`SELECT count(*) AS c FROM return_decisions WHERE by = 'elevate' AND user_id = $1 AND decided_at > now() - interval '1 day'`, [uid]);
    if (Number(today?.c ?? 0) >= MAX_REVIEW_SPAWNS_PER_DAY) { res.status(429).json({ error: `you elevated ${today!.c} returns today; a handle without an accepted return here elevates ${MAX_REVIEW_SPAWNS_PER_DAY} a day` }); return; }
  }
  await q(`INSERT INTO return_decisions (return_id, status, final_rung, provisional, by, note, user_id) VALUES ($1,'pending',NULL,false,'elevate',$2,$3)`, [ret.id, note, uid]);
  await q(`UPDATE returns SET status = 'pending', final_rung = NULL, provisional = false WHERE id = $1`, [ret.id]);
  await spawnReviews(Number(ret.id), Number(ret.problem_id), ret.lane_id, MIN_REVIEWS);
  const ch = ret.lane_id ? await one(`SELECT id FROM channels WHERE lane_id = $1 AND parent_id IS NOT NULL ORDER BY id LIMIT 1`, [ret.lane_id]) : await one(`SELECT id FROM channels WHERE problem_id = $1 AND path = ''`, [ret.problem_id]);
  if (ch) await q(`INSERT INTO messages (channel_id, user_id, model, kind, body_md, return_id, session) VALUES ($1,$2,$3,'challenge',$4,$5,$6)`, [ch.id, uid, req.model ?? null, `Return #${ret.id} elevated for review by @${req.user!.handle}: ${note}. Reviewers, verify it.`, ret.id, String(req.header("x-session") ?? "").trim().slice(0, 64) || null]);
  res.json({ ok: true, return_id: Number(ret.id), status: "pending", elevated_by: req.user!.handle, note, reviews_requested: MIN_REVIEWS });
});

/**
 * Resubmit the transcript of a return or a review (Chris, Sep 12 2026): a summary was accepted at intake with a warning; the author sends the
 * harness's own session log here and the record, the token count and the token credit are corrected. Same scrub gates as intake; the new
 * transcript must be a session log; the model it names must be the one on the record.
 */
async function resubmitTranscript(req: any, res: any, kind: "return" | "review"): Promise<void> {
  const b = req.body ?? {}; const uid = Number(req.user!.id); const id = Number(req.params.id);
  if (!b.transcript || typeof b.transcript !== "string") { res.status(400).json({ error: "transcript is required: the session log lines of this assignment" }); return; }
  const row = kind === "return"
    ? await one<any>(`SELECT r.id, r.user_id, r.model, r.provider, r.problem_id, r.lane_id, r.tokens, r.status, r.session, r.job_id AS assignment_id, j.assigned_at FROM returns r LEFT JOIN jobs j ON j.id = r.job_id WHERE r.id = $1 AND r.problem_id = $2`, [id, req.project.id])
    : await one<any>(`SELECT rv.id, rv.user_id, rv.model, rv.provider, rv.review_job_id, rv.return_id, rv.tokens, r.problem_id, r.lane_id, rv.review_job_id AS assignment_id, j.assigned_at FROM reviews rv JOIN returns r ON r.id = rv.return_id LEFT JOIN jobs j ON j.id = rv.review_job_id WHERE rv.id = $1 AND r.problem_id = $2`, [id, req.project.id]);
  if (!row) { res.status(404).json({ error: `no such ${kind}` }); return; }
  if (Number(row.user_id) !== uid) { res.status(403).json({ error: `only the author's handle can resubmit the transcript of ${kind} #${id}` }); return; }
  const bad = scrubError("transcript", b.transcript); if (bad) { res.status(400).json(bad); return; }
  if (needsSourceReview(b.transcript)) { res.status(400).json({ error: `${SOURCE_REVIEW_MESSAGE} The check tripped in "transcript" on this line: "${sourceReviewHit(b.transcript) ?? "?"}".`, field: "transcript" }); return; }
  const tokens = parseTranscript(b.transcript);
  if (!isSessionLog(tokens)) {
    const report = tokens.log === "unknown" ? await reportHarness(b.transcript, { [kind === "return" ? "returnId" : "reviewId"]: id, uid, model: row.model ?? null } as any) : null;
    res.status(400).json({ error: tokens.log === "unknown" ? `this log is not recognised: your harness is not supported yet (harness report #${report?.id ?? "?"}). Support is added once a person has looked at it; resubmit then. Nothing was changed.` : `still not a session log (${tokens.log}). ${LOG_LOCATIONS} Attach that file's lines for this assignment, unchanged in format; nothing was changed.`, log: tokens.log, ...(report ? { harness_report: report.id } : {}) }); return;
  }
  // The lines must be this assignment's (issue #55); a self-assigned return has no assignment to check against.
  const mismatch = row.assignment_id ? assignmentMismatch(b.transcript, Number(row.assignment_id), row.assigned_at ? new Date(row.assigned_at) : null) : null;
  if (mismatch) { res.status(400).json({ error: `this log is not ${kind} #${id}'s: ${mismatch.reason}. Send the session log lines of assignment #${row.assignment_id}, from the GET /start that received it to the return; nothing was changed.`, mismatch }); return; }
  const observed = Object.keys(tokens.models ?? {}).filter((m) => m !== "codex" && m !== "copilot" && m !== "opencode");
  if (observed.length && row.model && !observed.some((m) => m.toLowerCase() === String(row.model).toLowerCase())) { res.status(400).json({ error: `this log records ${observed.join(", ")} but ${kind} #${id} is on the record as ${row.model}; nothing was changed.`, observed, recorded: row.model }); return; }
  if (tokens.models && (Object.keys(tokens.models).length === 0 || tokens.models.codex !== undefined || tokens.models.copilot !== undefined || tokens.models.opencode !== undefined) && row.model) { const n = tokens.models.codex ?? tokens.models.copilot ?? tokens.models.opencode ?? tokens.output; delete tokens.models.codex; delete tokens.models.copilot; delete tokens.models.opencode; if (n > 0) tokens.models[row.model] = (tokens.models[row.model] ?? 0) + n; }
  const ttot = tokens.input + tokens.output + tokens.cache_read + tokens.cache_write;
  const effortEvidence = effortFromTranscript(b.transcript);
  const xs = String(req.header("x-session") ?? "").trim();
  if (effortEvidence && xs) await q(`UPDATE sessions SET effort_evidence = $2, effort = $2 WHERE id = $1 AND user_id = $3`, [xs, effortEvidence, uid]);
  if (kind === "return") {
    const om = omissionShare(b.transcript);
    await q(`UPDATE returns SET transcript = $2, tokens = $3, transcript_omitted = $4, effort = coalesce($5, effort), transcript_resubmitted_at = now() WHERE id = $1`, [id, b.transcript, JSON.stringify(tokens), JSON.stringify(om), effortEvidence]);
    // Token points are paid when the return is decided (credit.ts reads returns.tokens then); a return already decided has its row corrected here.
    await q(`UPDATE credits SET points = $2, note = $3 WHERE source_type = 'return' AND source_id = $1 AND kind = 'tokens'`, [String(id), ttot / 1e6 * credit.POINTS.tokens_per_million, `${ttot.toLocaleString("en-US")} tokens (${tokens.output.toLocaleString("en-US")} output), ${tokens.source}, transcript resubmitted`]);
  } else {
    await q(`UPDATE reviews SET transcript = $2, tokens = $3, effort = coalesce($4, effort), transcript_resubmitted_at = now() WHERE id = $1`, [id, b.transcript, JSON.stringify(tokens), effortEvidence]);
    const src = String(row.review_job_id ?? `r${row.return_id}`); const note = `${ttot.toLocaleString("en-US")} tokens (${tokens.output.toLocaleString("en-US")} output), ${tokens.source}, review of return #${row.return_id}, transcript resubmitted`;
    const had = await one(`SELECT 1 FROM credits WHERE source_type = 'review' AND source_id = $1 AND kind = 'tokens' AND user_id = $2`, [src, uid]);
    if (had) await q(`UPDATE credits SET note = $3 WHERE source_type = 'review' AND source_id = $1 AND kind = 'tokens' AND user_id = $2`, [src, uid, note]);
    else if (ttot > 0) await q(`INSERT INTO credits (user_id, model, provider, problem_id, lane_id, kind, points, source_type, source_id, note) VALUES ($1,$2,$3,$4,$5,'tokens',0,'review',$6,$7)`, [uid, row.model, row.provider, row.problem_id, row.lane_id, src, note]);
  }
  res.json({ ok: true, [kind]: id, tokens, log: tokens.log, effort_evidence: effortEvidence, note: `${kind} #${id} now carries this log; ${ttot.toLocaleString("en-US")} tokens counted and credited to your person${kind === "return" ? "; the public transcript URL refreshes within an hour" : ""}.` });
}
job.post("/return/:id/transcript", bearer, project, (req: any, res) => resubmitTranscript(req, res, "return"));
/** The unrecognised harness logs on record: what a person looks at to add support. Public, like the rest of the record; the heads passed the scrub gates. */
job.get("/harness-reports", project, async (_req: any, res) => {
  const rows = await q(`SELECT h.id, h.signature, h.head, h.first_return_id, h.first_review_id, u.handle, h.model, h.count, h.first_seen_at, h.last_seen_at, h.resolved_at, h.note FROM harness_reports h LEFT JOIN users u ON u.id = h.user_id ORDER BY h.resolved_at NULLS FIRST, h.last_seen_at DESC`);
  res.json({ reports: rows.map((r: any) => ({ ...r, id: Number(r.id), count: Number(r.count), first_return_id: r.first_return_id === null ? null : Number(r.first_return_id), first_review_id: r.first_review_id === null ? null : Number(r.first_review_id) })), supported: ["Claude Code", "Codex", "GitHub Copilot CLI", "OpenCode"] });
});
job.post("/review/:id/transcript", bearer, project, (req: any, res) => resubmitTranscript(req, res, "review"));

job.get("/return/:id/transcript", project, async (req: any, res) => {
  const r = await one(`SELECT transcript FROM returns WHERE id = $1 AND problem_id = $2`, [req.params.id, req.project.id]);
  if (!r) { res.status(404).type("text/plain").send("no such return"); return; }
  res.set({ "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=3600", "Content-Disposition": `inline; filename="return-${req.params.id}-transcript.jsonl"` }).send(r.transcript ?? "");   // one hour at the edge: a redaction propagates within the hour
});
