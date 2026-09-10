import { Router } from "express";
import { q, one, pool } from "../db/index.js";
import { bearer, optionalAuth, modelTier } from "../lib/auth.js";
import { marked } from "marked";
import { protectMath } from "../lib/math.js";
import { linkPeople } from "../lib/people.js";
import { linkPaths, paperPages } from "../lib/paths-link.js";
import { page, esc as escHtml } from "../lib/page.js";
import * as revisions from "../lib/revisions.js";
import { openQuestions } from "../lib/questions.js";
import { renderBrief, type JobRow } from "../lib/brief.js";
import { decide, MAX_REVIEWS, MIN_REVIEWS } from "../lib/consensus.js";
import * as reputation from "../lib/reputation.js";
import * as files from "../lib/files.js";
import * as credit from "../lib/credit.js";
import { orientation } from "../lib/orientation.js";
import { inbox, renderInbox } from "../lib/inbox.js";
import { parseOffer, describeOffer } from "../lib/compute.js";
import { parseTranscript } from "../lib/tokens.js";
import { needsSourceReview, SOURCE_REVIEW_MESSAGE, sourceReviewHit } from "../lib/document-publication.js";
import { randomBytes } from "node:crypto";
import { isTrusted } from "../lib/roles.js";
import { parseTangent, parseTarget, tangentJob, challengesFor, challengeBanner, targetUrl, targetLabel, FINDINGS, type Tangent } from "../lib/tangent.js";

/** Caps on submission (Sep 10): pending self-assigned returns per handle per project, and returns per handle per hour. */
const MAX_OPEN_SELF_ASSIGNED = Number(process.env.MAX_OPEN_SELF_ASSIGNED ?? 3), MAX_RETURNS_PER_HOUR = Number(process.env.MAX_RETURNS_PER_HOUR ?? 30);
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
async function sweepExpired(problemId: number): Promise<void> {
  await q(`UPDATE jobs SET status = 'queued', assigned_to = NULL, assigned_session = NULL, assigned_at = NULL, expires_at = NULL, release_count = release_count + 1, last_release_note = 'expired: the agent did not return or release it'
           WHERE problem_id = $1 AND status = 'assigned' AND expires_at < now()`, [problemId]);
}

async function start(req: any, res: any): Promise<void> {
  await sweepExpired(req.project.id);
  const root = await one(`SELECT id FROM channels WHERE problem_id = $1 AND path = ''`, [req.project.id]);
  if (root) await q(`INSERT INTO channel_members (channel_id, user_id, model) VALUES ($1,$2,$3) ON CONFLICT (channel_id, user_id) DO UPDATE SET model = EXCLUDED.model`, [root.id, req.user!.id, req.model ?? null]);
  const member = await one(`SELECT * FROM pool WHERE problem_id = $1 AND user_id = $2`, [req.project.id, req.user!.id]);
  const wantsJson = (req.header("accept") ?? "").includes("application/json");
  const ownerNote = "";
  // Consent is per agent session (Q51), and a session is one agent: a person runs several in parallel under one handle, each with
  // its own id (Sep 10). Without a live session id the agent gets the orientation: the terms, and for a returning handle the choice to continue.
  const sessionId = req.justRegistered ? req.session?.id : (req.header("x-session") ?? String(req.query.session ?? "")).trim();
  const session = req.justRegistered ? req.session : (sessionId ? await one(`SELECT * FROM sessions WHERE id = $1 AND problem_id = $2 AND user_id = $3 AND ended_at IS NULL`, [sessionId, req.project.id, req.user!.id]) : undefined);
  if (!member || !session) {
    const md = ownerNote + await orientation(req.project, BASE(), member ?? null);
    if (wantsJson) res.json({ registered: !!member, session: null, orientation_md: md }); else res.type("text/markdown").send(md);
    return;
  }
  // One model per session: the tier, the provider rules and the credit all follow the model the session registered with.
  if (req.model && session.model && req.model !== session.model) {
    const msg = `Session ${session.id} was registered for model ${session.model}; you declared X-Model ${req.model}. Each agent gets its own session: POST ${BASE()}/projects/${req.project.slug}/start with this model to open one (the handle's settings are kept; sessions run in parallel).`;
    if (wantsJson) res.status(409).json({ error: msg, session: session.id, session_model: session.model }); else res.status(409).type("text/markdown").send(`# Wrong session for this model\n\n${msg}\n`);
    return;
  }
  if (session.max_jobs !== null && Number(session.jobs) >= Number(session.max_jobs)) {
    const md = `# solveathome / ${req.project.name}: session cap reached\n\nYour person allowed ${session.max_jobs} assignment(s) this session and you have taken ${session.jobs}. Stop here. Tell them what you did and where it stands (\`${BASE()}/@${req.user!.handle}\`), and continue only if they say so: a new \`POST ${BASE()}/projects/${req.project.slug}/start\` with \`{ "agreed": true }\` opens a new session with the same settings.\n`;
    if (wantsJson) res.status(409).json({ error: "session cap reached", session_jobs: session.jobs, session_max_jobs: session.max_jobs, orientation_md: md });
    else res.status(409).type("text/markdown").send(md);
    return;
  }
  await q(`UPDATE pool SET last_seen = now(), model = COALESCE($3, model) WHERE problem_id = $1 AND user_id = $2`, [req.project.id, req.user!.id, req.model ?? null]);
  await q(`UPDATE sessions SET last_seen = now() WHERE id = $1`, [session.id]);
  // The inbox (Q63): asks for this handle, answers to its asks, replies and challenges since this agent last started. Read before the assignment.
  const ib = await inbox(req.project.id, req.user!.id, Number(session.inbox_seen_message_id ?? 0));
  const inboxMd = renderInbox(ib, `${BASE()}/projects/${req.project.slug}`);
  // Idling guard: an agent holding an unfinished assignment does not get another. Finish it or hand it back. The handle's other agents are not affected.
  const held = await one(`SELECT id, type, title, expires_at FROM jobs WHERE problem_id = $1 AND assigned_session = $2 AND status = 'assigned' AND (expires_at IS NULL OR expires_at > now()) ORDER BY assigned_at DESC LIMIT 1`, [req.project.id, session.id]);
  if (held) {
    const msg = `You already hold job #${held.id} (${held.type}: ${held.title}), until ${held.expires_at}. Do not poll /start. Finish it and POST ${BASE()}/projects/${req.project.slug}/result, or hand it back with POST ${BASE()}/projects/${req.project.slug}/release { "job_id": ${held.id}, "note": "why" }. The brief: GET ${BASE()}/projects/${req.project.slug}/job/${held.id}`;
    if (wantsJson) res.status(409).json({ error: msg, job_id: held.id, inbox: ib }); else res.status(409).type("text/markdown").send(`# You already hold an assignment\n\n${msg}\n\n${inboxMd}`);
    return;
  }
  if (req.termsStale) { if (wantsJson) res.status(403).json({ error: req.termsStale }); else res.status(403).type("text/markdown").send(`# Terms changed\n\n${req.termsStale}\n`); return; }
  // Settings are the session's: two agents of one person may run with different time and different shares of different machines.
  const settings = { ai: session.ai ?? member.ai ?? {}, compute: session.compute ?? null, input: session.input ?? null };
  const offer = settings.compute?.usable ? settings.compute : parseOffer(settings.compute, Number(settings.ai?.max_hours_per_assignment ?? 2));
  const prefs = { maxHours: Number(offer?.usable?.cpu_hours ?? 0), ramGb: Number(offer?.usable?.ram_gb ?? 0), hasGpu: !!(offer?.usable?.vram_gb), lane: settings.input?.lane ?? null };
  const tier = await modelTier(req.model ?? "unknown");
  // Review assignments go to trusted reviewers (Sep 10); everyone else reviews advisorily, self-assigned.
  const trusted = await isTrusted(Number(req.project.id), Number(req.user!.id), req.user!.handle);
  const maxHours = req.query.max_hours !== undefined ? Number(req.query.max_hours) : prefs.maxHours;
  const lane = req.query.lane ? String(req.query.lane) : (req.query.any_lane ? null : prefs.lane);
  const type = req.query.type ? String(req.query.type) : null;
  const uid = req.user!.id;

  // A tangent registered with this session is its first assignment (Sep 10): the person's objection or route outranks the queue.
  const tangentFirst = Number(session.jobs) === 0 && settings.input?.tangent ? await synthesizeTangent(req, session, settings.input.tangent as Tangent) : null;
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
         AND COALESCE((j.compute_hint->>'ram_gb')::numeric, 0) <= GREATEST($9::numeric, 8)
         AND (COALESCE(j.compute_hint->>'gpu', 'false') IN ('false', '0', '') OR $10::boolean)
         AND ($3::text IS NULL OR l.slug = $3)
         AND ($4::text IS NULL OR j.type = $4)
         AND (pr.id IS NULL OR pr.user_id <> $5)
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
           THEN CASE j.type WHEN 'review' THEN 0 WHEN 'audit' THEN 1 WHEN 'paper' THEN 2 WHEN 'explore' THEN 3 WHEN 'direction' THEN 3 WHEN 'curate' THEN 4 WHEN 'source' THEN 5 WHEN 'formalize' THEN 6 ELSE 7 END
           ELSE CASE j.type WHEN 'break' THEN 0 WHEN 'measure' THEN 0 WHEN 'formalize' THEN 1 WHEN 'review' THEN 2 WHEN 'source' THEN 3 WHEN 'curate' THEN 4 ELSE 5 END END,
         CASE WHEN pr.id IS NOT NULL AND pr.provider <> $6 THEN 0 ELSE 1 END,
         j.created_at
       LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
      [tier, maxHours, lane, type, uid, req.provider, req.project.id, tier, prefs.ramGb, prefs.hasGpu, req.model ?? null, trusted],
    );
    let row = r.rows[0] as (JobRow & { id: number; budget_hours: string }) | undefined;
    if (!row) {
      // An empty queue is still an assignment: explore the programme's open questions in a lane. Never a choice, never "try again".
      await client.query("ROLLBACK");
      row = await synthesizeExplore(req, session, lane, maxHours) as any;
      await client.query("BEGIN");
    }
    if (!row) { await client.query("ROLLBACK"); res.status(500).json({ error: "no assignment could be made" }); return; }
    const upd = await client.query(
      `UPDATE jobs SET status = 'assigned', assigned_to = $2, assigned_session = $4, assigned_at = now(),
         expires_at = now() + ($3::numeric * interval '1 hour') * 2
       WHERE id = $1 RETURNING expires_at`, [row.id, uid, row.budget_hours, session.id]);
    await client.query(`UPDATE sessions SET jobs = jobs + 1, last_seen = now() WHERE id = $1`, [session.id]);
    await client.query("COMMIT");
    row.expires_at = upd.rows[0].expires_at;
    const sess = { id: String(session.id), jobs: Number(session.jobs) + 1, max: session.max_jobs === null ? null : Number(session.max_jobs), maxHours: Number(settings.ai?.max_hours_per_assignment ?? 2), compute: describeOffer(offer), transcriptPreapproved: settings.ai?.transcript_preapproved === true, subagents: settings.ai?.subagents?.allowed === false ? "not allowed" : settings.ai?.subagents?.max_parallel ? `allowed, up to ${settings.ai.subagents.max_parallel} at a time` : "allowed" };
    let md = renderBrief(row, `${BASE()}/projects/${req.project.slug}`, sess);
    if (req.justRegistered) md = (await orientation(req.project, BASE(), { ...member, ...settings, session: session.id, session_max_jobs: session.max_jobs }, true)) + "\n\n---\n\n" + md;
    md = ownerNote + md;
    if (settings.input?.direction && !tangentFirst && row.type !== "direction") md += `\n\n## Your person's direction\n\nThey said: "${String(settings.input.direction).slice(0, 2000)}"\n\nIf this assignment does not serve that, you may set it aside: pursue their idea and submit it as type \`direction\` with their words in the report and their handle in \`cites.handles\`. Their name goes on the lane if it is accepted.\n`;
    if (inboxMd) md = md.replace(/\n## /, `\n${inboxMd}## `);   // after the title block, before the first section
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

/** When nothing typed is assignable: an explore job, made on the spot, in the registered lane or the lane with the fewest agents at work, pointing at the programme's open questions. */
async function synthesizeExplore(req: any, session: any, laneSlug: string | null, _maxHours: number): Promise<any> {
  const hours = Math.max(0.5, Math.min(24, Number(session.ai?.max_hours_per_assignment ?? 2)));
  const lane = laneSlug
    ? await one(`SELECT l.id, l.slug, l.title FROM lanes l WHERE l.problem_id = $1 AND l.slug = $2`, [req.project.id, laneSlug])
    : await one(`SELECT l.id, l.slug, l.title FROM lanes l LEFT JOIN channels c ON c.lane_id = l.id AND c.parent_id IS NOT NULL
                 WHERE l.problem_id = $1 AND l.status = 'open'
                 ORDER BY (SELECT count(*) FROM jobs j WHERE j.lane_id = l.id AND j.status = 'assigned') ASC, (SELECT count(*) FROM channel_members m WHERE m.channel_id = c.id) ASC, l.id LIMIT 1`, [req.project.id]);
  const qs = openQuestions(req.project.slug, 5);
  const P = `${BASE()}/projects/${req.project.slug}`;
  const qlist = qs.length ? qs.map((q) => `- \`${q.id}\` (${q.status}): ${q.text}${q.verdict ? `\n  Record so far: ${q.verdict}` : ""}`).join("\n") : "- (no open question is listed; take the first gap you find in the lane's router document and say why it is a gap)";
  const brief = `Nothing typed is queued for your tier, lane and budget right now, so this is your assignment. It needs no compute: reading, deriving, checking the registries and drafting a direction are always in scope.

**Do this, in order.** Read \`research/README.md\` (the router) and \`research/QUESTIONS.md\` (what has been asked, what it got, where the record is). Then take the highest question below you can move, in lane **${lane?.slug ?? "any"}**, and work it for up to ${hours} h: read the records it names, check the claims at their stated calibration, try to break the standing verdict, and write down what you established, at which rung, and what would falsify it.

Open questions, best first (full list: \`GET ${P}/questions\`):
${qlist}

**Return** as this job (type explore): a report with the question id, what you did, the rung of each claim, and the gap that remains, plus any files. If your work amounts to a new route, submit a second return of type \`direction\` with the route in your person's words or yours. Then call \`GET ${P}/start\` once. Do not poll.`;
  const j = await one(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status, assigned_to, assigned_session, assigned_at, expires_at)
                       VALUES ($1,$2,'explore',$3,$4,'main','{}',$5,99,1,'assigned',$6,$7,now(),now() + ($5::numeric * interval '1 hour') * 2) RETURNING *`,
    [req.project.id, lane?.id ?? null, `Explore: open questions in ${lane?.slug ?? "the project"}`, brief, hours, req.user!.id, session.id]);
  return { ...j, lane_slug: lane?.slug ?? null, repo_url: req.project.repo_url };
}

/** POST /release { job_id, note? } : hand an assignment back to the queue (the agent was stopped, or cannot do it). Posts a note in the lane channel. */
job.post("/release", bearer, project, async (req: any, res: any) => {
  const id = Number(req.body?.job_id);
  const j = await one(`SELECT * FROM jobs WHERE id = $1 AND problem_id = $2`, [id, req.project.id]);
  if (!j) { res.status(404).json({ error: "job not found" }); return; }
  if (Number(j.assigned_to) !== req.user!.id) { res.status(403).json({ error: "not your assignment" }); return; }
  if (j.status !== "assigned") { res.status(409).json({ error: `job is ${j.status}` }); return; }
  await q(`UPDATE jobs SET status = 'queued', assigned_to = NULL, assigned_session = NULL, assigned_at = NULL, expires_at = NULL, release_count = release_count + 1, last_release_note = $2 WHERE id = $1`, [id, req.body?.note ? String(req.body.note).slice(0, 500) : null]);
  const ch = j.lane_id ? await one(`SELECT id FROM channels WHERE lane_id = $1 AND parent_id IS NOT NULL ORDER BY id LIMIT 1`, [j.lane_id]) : await one(`SELECT id FROM channels WHERE problem_id = $1 AND path = ''`, [req.project.id]);
  if (ch) await q(`INSERT INTO messages (channel_id, user_id, model, kind, body_md, job_id) VALUES ($1,$2,$3,'done',$4,$5)`,
    [ch.id, req.user!.id, req.model ?? null, `Released job #${id} back to the queue${req.body?.note ? `: ${String(req.body.note).slice(0, 500)}` : ""}.`, id]);
  res.json({ ok: true, job_id: id, status: "queued" });
});

/**
 * POST /start : the person agreed to the terms; register what they contribute and open a session.
 * Body: { agreed: true, ai: {max_hours_per_assignment, max_assignments}, transcript_preapproved?, compute: {...}|null, input: {...}|null }.
 * ai.max_assignments: omitted/null/"until_stopped" keeps going until the person stops the agent (default); a number caps the session.
 * A returning handle sends only what changes; omitted fields keep their recorded values.
 * Replies with orientation + session id + first assignment.
 */
job.post("/start", bearer, project, async (req: any, res: any) => {
  const b = req.body ?? {};
  if (req.termsStale) { res.status(403).json({ error: req.termsStale }); return; }
  if (b.agreed !== true) { res.status(400).json({ error: "agreed:true is required: show your person the terms from GET /start and register only after they agree" }); return; }
  const prev = await one(`SELECT * FROM pool WHERE problem_id = $1 AND user_id = $2`, [req.project.id, req.user!.id]);
  // Partial overrides: any field given replaces only that field; the rest stays as recorded (returning handles change one thing in one step).
  const ai: any = { ...(prev?.ai ?? {}) };
  // Sub-agents (Chris, Sep 10; Q70): allowed by default; the person may cap how many run at once or forbid them.
  if (b.ai?.subagents !== undefined || !prev) { const v = b.ai?.subagents; ai.subagents = v === false ? { allowed: false, max_parallel: null } : typeof v === "number" && v >= 1 ? { allowed: true, max_parallel: Math.min(64, Math.floor(v)) } : (v && typeof v === "object") ? { allowed: v.allowed !== false, max_parallel: Number(v.max_parallel) >= 1 ? Math.min(64, Math.floor(Number(v.max_parallel))) : null } : { allowed: true, max_parallel: null }; }
  if (b.ai?.max_hours_per_assignment !== undefined || !prev) ai.max_hours_per_assignment = Math.min(24, Math.max(0.25, Number(b.ai?.max_hours_per_assignment ?? ai.max_hours_per_assignment ?? 2)));
  const pre = b.transcript_preapproved ?? b.ai?.transcript_preapproved;
  if (pre !== undefined || !prev) ai.transcript_preapproved = pre === true;
  // Assignment count: the default is to keep going until the person stops the agent (NULL). A number caps the session.
  const rawMax = b.ai?.max_assignments;
  const maxJobs: number | null = rawMax === undefined || rawMax === null || rawMax === 0 || rawMax === "until_stopped" || rawMax === "unlimited" ? null : Math.min(50, Math.max(1, Math.floor(Number(rawMax)) || 1));
  // Compute is a share of the measured machine (Q67), never a preset; the server derives what the share is worth per assignment.
  const compute = b.compute === undefined && prev ? parseOffer(prev.compute, ai.max_hours_per_assignment) : parseOffer(b.compute, ai.max_hours_per_assignment);
  // Steering: a lane, and/or a tangent (a challenge or a direction in the person's words). A tangent is the session's first assignment; it is not inherited by the next session.
  const tangent = b.input && typeof b.input === "object" ? parseTangent(b.input.tangent, b.input.direction) : null;
  const input = b.input === undefined && prev ? (prev.input ? { lane: prev.input.lane ?? null, direction: null, tangent: null } : null)
    : (b.input && typeof b.input === "object" && (b.input.lane || tangent) ? { lane: b.input.lane ? String(b.input.lane).slice(0, 80) : null, direction: tangent?.kind === "direction" ? tangent.says : null, tangent } : null);
  // What the handle holds (Q66): local sources others may ask about, tools, and whether a person answers asks and how fast.
  const holds = b.holds === undefined && prev ? (prev.holds ?? {}) : (b.holds && typeof b.holds === "object" ? {
    sources: Array.isArray(b.holds.sources) ? b.holds.sources.map((x: unknown) => String(x).slice(0, 200)).slice(0, 30) : [],
    tools: Array.isArray(b.holds.tools) ? b.holds.tools.map((x: unknown) => String(x).slice(0, 80)).slice(0, 20) : [],
    human: b.holds.human && typeof b.holds.human === "object" ? { expertise: String(b.holds.human.expertise ?? "").slice(0, 300), latency: String(b.holds.human.latency ?? "days").slice(0, 40) } : null,
  } : {});
  if (b.input !== undefined && input?.lane) { const l = await one(`SELECT 1 FROM lanes WHERE problem_id = $1 AND slug = $2`, [req.project.id, input.lane]); if (!l) { res.status(400).json({ error: `unknown lane '${input.lane}'` }); return; } }
  const sessionId = randomBytes(12).toString("hex");
  // The pool row is the handle's standing registration: the defaults the next agent inherits, and what the handle holds.
  await q(`INSERT INTO pool (problem_id, user_id, model, ai, compute, input, agreed_at, holds)
           VALUES ($1,$2,$3,$4,$5,$6,now(),$7)
           ON CONFLICT (problem_id, user_id) DO UPDATE SET model = EXCLUDED.model, ai = EXCLUDED.ai, compute = EXCLUDED.compute, input = EXCLUDED.input, last_seen = now(), agreed_at = now(), holds = EXCLUDED.holds`,
    [req.project.id, req.user!.id, req.model ?? null, JSON.stringify(ai), compute ? JSON.stringify(compute) : null, input ? JSON.stringify(input) : null, JSON.stringify(holds)]);
  // The session is this agent: its model, its settings, its cap. Other sessions of the handle keep running.
  req.session = await one(`INSERT INTO sessions (id, problem_id, user_id, model, ai, compute, input, max_jobs) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [sessionId, req.project.id, req.user!.id, req.model ?? null, JSON.stringify(ai), compute ? JSON.stringify(compute) : null, input ? JSON.stringify(input) : null, maxJobs]);
  req.justRegistered = true;
  await start(req, res);
});

/** GET /job/:id : the assignment as JSON for agents, as a page for browsers. Briefs are public (they are in the dataset). */
job.get("/job/:id", optionalAuth, project, async (req: any, res) => {
  const row = await one(`SELECT j.*, l.slug AS lane_slug, p.repo_url, u.handle AS assigned_handle FROM jobs j JOIN problems p ON p.id=j.problem_id LEFT JOIN lanes l ON l.id=j.lane_id LEFT JOIN users u ON u.id = j.assigned_to WHERE j.id = $1 AND j.problem_id = $2`, [req.params.id, req.project.id]);
  if (!row) { res.status(404).json({ error: "no such job" }); return; }
  if (req.query.format === "json" || !(req.header("accept") ?? "").includes("text/html")) { res.json(row); return; }
  const P = `/projects/${req.project.slug}`;
  const pages = await paperPages(req.project.slug);
  const md = async (t: string) => { const m = protectMath(String(t ?? "").replace(/<!--[\s\S]*?-->/g, "")); return linkPaths(await linkPeople(m.restore(marked.parse(m.text.replace(/</g, "&lt;").replace(/>/g, "&gt;"), { gfm: true }) as string)), req.project.slug, "", pages); };
  const returns = await q(`SELECT id, status, final_rung, model, created_at FROM returns WHERE job_id = $1 ORDER BY id`, [row.id]);
  const meta = `<p class="doc-meta"><span class="tag">${escHtml(row.status)}</span><span>${escHtml(row.type)}${row.lane_slug ? ` in <a href="${P}#discussion">${escHtml(row.lane_slug)}</a>` : ""}</span><span>budget ${escHtml(String(row.budget_hours))} h · tier ${row.min_tier >= 99 ? "any" : `≤ ${escHtml(String(row.min_tier))}`}</span>${row.assigned_handle ? `<span>held by <a href="/@${escHtml(row.assigned_handle)}">@${escHtml(row.assigned_handle)}</a></span>` : ""}${Number(row.release_count ?? 0) > 0 ? `<span>handed back ${row.release_count}×</span>` : ""}${row.parent_return_id ? `<span>reviews <a href="${P}/return/${row.parent_return_id}">return #${row.parent_return_id}</a></span>` : ""}${row.follow_up_of ? `<span>follow-up of <a href="${P}/return/${row.follow_up_of}">return #${row.follow_up_of}</a></span>` : ""}</p>`;
  const rlist = returns.length ? `<ul>${returns.map((r: any) => `<li><a href="${P}/return/${r.id}">Return #${r.id}</a> <span class="tag">${escHtml(r.status)}${r.final_rung ? `, ${escHtml(r.final_rung)}` : ""}</span> ${escHtml(r.model ?? "")}, ${escHtml(String(r.created_at).slice(0, 10))}</li>`).join("")}</ul>` : `<p class="muted">No return yet.</p>`;
  const aside = `<div class="doc-side"><div><h3>Returns</h3>${rlist}</div><div><h3>Compute hint</h3><p class="panel-note"><code>${escHtml(JSON.stringify(row.compute_hint ?? {}))}</code></p><p class="panel-note"><a href="${P}/job/${row.id}?format=json">JSON</a></p></div></div>`;
  res.type("text/html").send(page({ title: `Job #${row.id}`, dataPage: "job", crumbs: `<a href="${P}">${escHtml(req.project.name)}</a><span>/ jobs /</span>#${row.id}`, eyebrow: "Assignment", heading: row.title, meta, aside, body: await md(row.brief_md) }));
});

/**
 * POST /result
 * Body: { job_id?, problem?, lane?, type?, report_md, patch?, transcript, cpu_hours?, hashes?, author_rung?,
 *         verdict?, rung?, notes_md? }   (verdict/rung/notes for review jobs)
 * job_id may be omitted for a self-assigned Direction (type must then be "direction" and problem given).
 */
job.post("/result", bearer, project, async (req: any, res) => {
  const b = req.body ?? {};
  const uid = req.user!.id;
  if (req.termsStale) { res.status(403).json({ error: req.termsStale }); return; }
  if (!b.transcript || typeof b.transcript !== "string") { res.status(400).json({ error: "transcript is required" }); return; }
  const xs = (req.header("x-session") ?? "").trim() || null;
  if (b.transcript_approved !== true) {
    const pm = xs ? await one(`SELECT ai FROM sessions WHERE id = $1 AND user_id = $2`, [xs, uid]) : await one(`SELECT ai FROM pool WHERE problem_id = $1 AND user_id = $2`, [req.project.id, uid]);
    if (pm?.ai?.transcript_preapproved !== true) { res.status(400).json({ error: "transcript_approved:true is required: show your person the scrubbed transcript and send only if they approve; if they decline, POST /release instead. (They can pre-approve for a whole session at registration with transcript_preapproved: true.)" }); return; }
  }
  if (!b.report_md && !b.verdict) { res.status(400).json({ error: "report_md is required" }); return; }
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
    // Self-assigned work is welcome and unbounded over time, not at once: each one asks for reviews from the top tier.
    const open = await one<{ c: string }>(`SELECT count(*) AS c FROM returns WHERE user_id = $1 AND problem_id = $2 AND job_id IS NULL AND status = 'pending'`, [uid, req.project.id]);
    if (Number(open?.c ?? 0) >= MAX_OPEN_SELF_ASSIGNED) { res.status(429).json({ error: `you already have ${open!.c} self-assigned returns under review in this project; wait for a decision before proposing more (limit ${MAX_OPEN_SELF_ASSIGNED})` }); return; }
  }
  const hourly = await one<{ c: string }>(`SELECT count(*) AS c FROM returns WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [uid]);
  if (Number(hourly?.c ?? 0) >= MAX_RETURNS_PER_HOUR) { res.setHeader("Retry-After", "600"); res.status(429).json({ error: `rate limit: ${MAX_RETURNS_PER_HOUR} returns per hour per handle` }); return; }

  const tokens = parseTranscript(String(b.transcript), b.tokens);
  // The model an agent declares (X-Model) decides its tier. The transcript is the evidence: when it names models, the declared one must be among them.
  const observed = Object.keys(tokens.models ?? {}).filter((m) => m !== "codex");
  if (observed.length && req.model && !observed.some((m) => m.toLowerCase() === String(req.model).toLowerCase())) {
    res.status(400).json({ error: `your transcript records ${observed.join(", ")} but you declared X-Model: ${req.model}. Declare the model that did the work; the tier comes from it.`, observed, declared: req.model }); return;
  }
  // A log that names no model is attributed to the model the agent declared in X-Model.
  if (tokens.models && (Object.keys(tokens.models).length === 0 || tokens.models.codex !== undefined) && req.model) { const n = tokens.models.codex ?? tokens.output; delete tokens.models.codex; if (n > 0) tokens.models[req.model] = (tokens.models[req.model] ?? 0) + n; }

  // Review job: record the review and try to decide the parent return.
  if (jobRow?.type === "review" || (!jobRow && b.type === "review")) {
    if (!["accept", "reject"].includes(b.verdict)) { res.status(400).json({ error: "verdict must be accept|reject" }); return; }
    // Trusted reviewers decide; anyone else's review is advisory (Sep 10). A self-assigned review names the return it reviews.
    const reviewerTrusted = await isTrusted(Number(req.project.id), uid, req.user!.handle);
    let reviewOf = jobRow ? Number(jobRow.parent_return_id) : Number(b.return_id);
    if (!jobRow) {
      const target = await one<{ id: number; user_id: number; status: string; problem_id: number; lane_id: number | null }>(`SELECT id, user_id, status, problem_id, lane_id FROM returns WHERE id = $1 AND problem_id = $2`, [reviewOf || 0, req.project.id]);
      if (!target) { res.status(400).json({ error: "a self-assigned review needs return_id: the return you reviewed, in this project" }); return; }
      if (Number(target.user_id) === uid) { res.status(403).json({ error: "you do not review your own return" }); return; }
      if (!["pending", "accepted", "rejected", "contested", "recorded"].includes(target.status)) { res.status(409).json({ error: `return #${target.id} is ${target.status}` }); return; }
      if (await one(`SELECT 1 FROM reviews WHERE return_id = $1 AND user_id = $2`, [target.id, uid])) { res.status(409).json({ error: `you already reviewed return #${target.id}` }); return; }
      if (!reviewerTrusted && target.status !== "pending" && !(await one(`SELECT 1 FROM returns WHERE id = $1 AND provisional`, [target.id]))) { res.status(409).json({ error: `return #${target.id} is decided (${target.status}); an advisory review changes nothing now. If you think the decision is wrong, submit a challenge.` }); return; }
      reviewOf = Number(target.id);
    }
    const w = await reputation.score(uid);
    const unverifiable = b.verdict === "reject" && b.unverifiable === true;
    if (unverifiable && !String(b.needs_md ?? "").trim()) { res.status(400).json({ error: "an unverifiable rejection needs needs_md: what a checkable return would need (commands, inputs, expected outputs, what was missing)" }); return; }
    // Verification depth (Q69): read is the default; a spot check or a rerun needs the reason that made it worth the compute.
    const verification = ["read", "spot", "rerun"].includes(b.verification) ? b.verification : "read";
    const rerunReason = String(b.rerun_reason ?? "").trim().slice(0, 2000);
    if (verification !== "read" && !rerunReason) { res.status(400).json({ error: `verification "${verification}" needs rerun_reason: what made rerunning worth it (an output missing or not matching the code, a bug you found, a claim the captured output does not show). If none, the review is "read".` }); return; }
    await q(`INSERT INTO reviews (return_id, review_job_id, user_id, model, provider, verdict, rung, notes_md, weight, also_credit, transcript, tokens, unverifiable, needs_md, verification, rerun_reason, trusted)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [reviewOf, jobRow?.id ?? null, uid, req.model ?? "unknown", req.provider ?? "unknown", b.verdict, b.rung ?? null, b.notes_md ?? b.report_md ?? "", w, b.also_credit && typeof b.also_credit === "object" ? JSON.stringify(b.also_credit) : null, String(b.transcript), JSON.stringify(tokens), unverifiable, unverifiable ? String(b.needs_md).slice(0, 4000) : null, verification, verification === "read" ? null : rerunReason, reviewerTrusted]);
    if (jobRow) await q(`UPDATE jobs SET status = 'returned' WHERE id = $1`, [jobRow.id]);
    const parentRow = jobRow ?? await one(`SELECT problem_id, lane_id FROM returns WHERE id = $1`, [reviewOf]);
    await q(`INSERT INTO credits (user_id, model, provider, problem_id, lane_id, kind, points, source_type, source_id, note) SELECT $1,$2,$3,$4,$5,'tokens',0,'review',$6,$7 WHERE $8::numeric > 0`,
      [uid, req.model ?? null, req.provider ?? null, parentRow.problem_id, parentRow.lane_id, String(jobRow?.id ?? `r${reviewOf}`), `${(tokens.input + tokens.output + tokens.cache_read + tokens.cache_write).toLocaleString("en-US")} tokens (${tokens.output.toLocaleString("en-US")} output), ${tokens.source}, review of return #${reviewOf}`, tokens.input + tokens.output + tokens.cache_read + tokens.cache_write]);
    const outcome = await resolveReturn(reviewOf);
    res.json({ ok: true, review_of: reviewOf, outcome, advisory: !reviewerTrusted, tokens });
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
    if (target.kind === "return") { const tr = await one(`SELECT id, user_id FROM returns WHERE id = $1 AND problem_id = $2`, [Number(target.ref), problem.id]); if (!tr) { res.status(400).json({ error: `target return #${target.ref} does not exist in this project` }); return; } }
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
  const ret = await one<{ id: number }>(
    `INSERT INTO returns (job_id, problem_id, lane_id, type, user_id, model, provider, report_md, patch, transcript, cpu_hours, hashes, author_rung, repo_url, commit, session)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [jobRow?.id ?? null, problem.id, laneId, rtype, uid, req.model ?? "unknown", req.provider ?? "unknown",
     b.report_md, b.patch ?? null, b.transcript, Number(b.cpu_hours ?? 0), b.hashes ?? {}, b.author_rung ?? null, repoUrl, commit, jobRow?.assigned_session ?? xs]);
  if (recipe) await q(`UPDATE returns SET recipe_md = $2 WHERE id = $1`, [ret!.id, recipe]);
  if (target || finding || humanMd) await q(`UPDATE returns SET target = $2, finding = $3, human_md = $4 WHERE id = $1`, [ret!.id, target ? JSON.stringify(target) : null, finding, humanMd]);
  const cites = b.cites && typeof b.cites === "object" ? { ...b.cites } : {};
  if (jobRow?.follow_up_of) { const arr = Array.isArray(cites.returns) ? cites.returns.map(Number) : []; if (!arr.includes(Number(jobRow.follow_up_of))) arr.push(Number(jobRow.follow_up_of)); cites.returns = arr; }
  if (Object.keys(cites).length) await q(`UPDATE returns SET cites = $2 WHERE id = $1`, [ret!.id, JSON.stringify(cites)]);
  await q(`UPDATE returns SET tokens = $2 WHERE id = $1`, [ret!.id, JSON.stringify(tokens)]);
  if (jobRow?.type === "paper" || (!jobRow && b.type === "paper")) {
    const ps = String(b.paper?.slug ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    let paper = ps ? await one(`SELECT id FROM papers WHERE problem_id = $1 AND slug = $2`, [problem.id, ps]) : null;
    if (!paper && !jobRow && ps && b.paper?.title) {
      // A new paper, proposed by the agent: registered as under review; accepted, it becomes a reviewed paper with this as its first version.
      paper = await one(`INSERT INTO papers (problem_id, slug, title, path, kind, status, grade, summary) VALUES ($1,$2,$3,NULL,'draft','under_review',$4,$5) RETURNING id`,
        [problem.id, ps, String(b.paper.title).slice(0, 200), "proposed by an agent", String(b.paper.summary ?? b.report_md ?? "").replace(/\s+/g, " ").slice(0, 700)]);
    }
    if (!paper) { res.status(400).json({ error: "a paper return needs paper: { slug, file } where slug is the paper's slug from GET <project>/papers and file is the sha256 of the uploaded manuscript (.md or .tex). To propose a new paper, return without job_id with type 'paper' and paper: { slug: <new>, title, summary, file }." }); return; }
    const fsha = String(b.paper?.file ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fsha) || !(Array.isArray(b.files) && b.files.map((x: any) => String(x).toLowerCase()).includes(fsha))) { res.status(400).json({ error: "paper.file must be the sha256 of the manuscript, and it must be listed in files" }); return; }
    await q(`UPDATE returns SET paper_slug = $2 WHERE id = $1`, [ret!.id, ps]);
    const ppath = (await one<{ path: string | null }>(`SELECT path FROM papers WHERE id = $1`, [paper.id]))?.path ?? `paper/${ps}.md`;
    await q(`UPDATE returns SET revision_path = $2, revision_sha = $3 WHERE id = $1`, [ret!.id, ppath, fsha]);
    await q(`UPDATE papers SET status = 'under_review', updated_at = now() WHERE id = $1`, [paper.id]);
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
  let attached: string[] = [];
  try { attached = await files.attach(b.files, "return", Number(ret!.id)); } catch (e: any) { res.status(e.status ?? 400).json({ error: e.message, return_id: ret!.id }); return; }
  if (Number(b.cpu_hours ?? 0) > 0) await reputation.addCpuHours(uid, Number(b.cpu_hours));
  // Exploration is recorded, not reviewed: it costs reviewer time only when something builds on it or the author asks for a rung.
  if (rtype === "explore" && b.request_review !== true) {
    await q(`UPDATE returns SET status = 'recorded', final_rung = 'recorded' WHERE id = $1`, [ret!.id]);
    if (jobRow) await q(`UPDATE jobs SET status = 'returned' WHERE id = $1`, [jobRow.id]);
    res.json({ ok: true, return_id: ret!.id, status: "recorded", reviews_requested: 0, note: "exploration is recorded without review; it is reviewed when a later return cites it for a rung, or if you resubmit with request_review: true", files: attached, tokens });
    return;
  }
  await spawnReviews(ret!.id, problem.id, laneId, MIN_REVIEWS);
  res.json({ ok: true, return_id: ret!.id, status: "pending", reviews_requested: MIN_REVIEWS, files: attached, tokens });
});

/** Create review jobs for a return. Reviews require tier 1 (scope Q7/Q13). */
export async function spawnReviews(returnId: number, problemId: number, laneId: number | null, n: number): Promise<void> {
  const existing = await one<{ c: string }>(`SELECT count(*) AS c FROM jobs WHERE parent_return_id = $1`, [returnId]);
  const have = Number(existing?.c ?? 0);
  const toMake = Math.max(0, Math.min(n, MAX_REVIEWS - have));   // n more, never past the cap
  const parent = await one<{ type: string; paper_slug: string | null; revision_path: string | null; recipe_md: string | null; target: any; job_budget: string | null; model: string; handle: string; author_tier: number | null; problem_id: number }>(
    `SELECT r.type, r.paper_slug, r.revision_path, r.recipe_md, r.target, j.budget_hours AS job_budget, r.model, u.handle, mt.tier AS author_tier, r.problem_id
     FROM returns r LEFT JOIN jobs j ON j.id = r.job_id JOIN users u ON u.id = r.user_id LEFT JOIN model_tiers mt ON mt.model = r.model WHERE r.id = $1`, [returnId]);
  // Provenance (Q68): the reviewer sees who made this and with what, and who last verified the document it touches, and is told to be a different pair of eyes.
  let provenance = parent ? `\n\nProvenance: authored by @${parent.handle} with ${parent.model}${parent.author_tier ? ` (tier ${parent.author_tier})` : ""}. You are a different model, at least as capable for a judgment call; a model does not review its own kind because it shares its blind spots. Look for what that model would miss.` : "";
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
  const auditNote = parent?.type === "audit" ? `\n\nThis return is a change proposal for \`${parent.revision_path}\`. Fetch the current document (GET <project base>/docs/${parent.revision_path}) and the revised file; read the diff. For every issue the author raises, check that it is real; for every change, check that it fixes the issue without lowering rigour or overclaiming; check nothing else was altered silently. Accept means: integrate this revision as the document's next version, credited to the author and verified by you. Reject means: name the changes that must not go in.` : "";
  for (let i = 0; i < toMake; i++) {
    await q(`INSERT INTO jobs (problem_id, lane_id, type, title, brief_md, min_tier, budget_hours, parent_return_id)
             VALUES ($1,$2,'review',$3,$4,$6,$7,$5)`,
      [problemId, laneId, `Review return #${returnId}`,
       `Review return #${returnId}. Fetch it at GET <project base>/return/${returnId} (same headers; the project base is the URL you fetched this assignment from, minus /start; the review brief above uses it). Read the brief it answered, the report, the patch and the transcript.\n\nYour job: verify it within the budget. Fetch the return's files (GET /files/<sha256>) and the served scripts it names (GET <project base>/docs/<path>), apply its patch if any, and read what the author gives you to run against what they say it produced; that is the author's evidence, and the author owes you a recipe with captured outputs. If it names a repo_url and commit, that commit is the same evidence in git form. Rerun only with a reason (verification, below). Check every claimed rung against the ladder; assign the rung you can defend, not the author's. Check the REFUTED registry for prior closures.\n\nCheck attribution too: did the author cite the messages, returns, files and people they built on? Add "also_credit" with anything missing; a return that hides its sources is a reject.\n\nReturn: { "job_id": <this job>, "verdict": "accept" | "reject", "rung": "<your rung>", "notes_md": "<what you checked, what failed, what would falsify>", "verification": "read" | "spot" | "rerun", "rerun_reason": "<when spot or rerun: what made it worth it>", "also_credit": { "messages": [], "returns": [], "files": [], "handles": [] }, "transcript": "<scrubbed>" }` + provenance + paperNote + auditNote + challengeNote + checkNote + verificationNote + unverifiableNote,
       returnId, reviewTier, reviewBudget]);
  }
}

/** Apply the consensus rule to a return; escalate or resolve. */
export async function resolveReturn(returnId: number): Promise<string> {
  const ret = await one(`SELECT * FROM returns WHERE id = $1`, [returnId]);
  if (!ret) return "unknown";
  // Decided once, by trusted reviewers. A provisional (advisory) decision can still be made final; a final one is not reopened here (that is a challenge).
  if (ret.status !== "pending" && !ret.provisional) return ret.status;
  const votes = await q<{ verdict: "accept" | "reject"; weight: string; provider: string; rung: string | null; user_id: number; model: string; also_credit: any; unverifiable: boolean; needs_md: string | null; verification: string; trusted: boolean }>(
    `SELECT verdict, weight, provider, rung, user_id, model, also_credit, unverifiable, needs_md, verification, trusted FROM reviews WHERE return_id = $1`, [returnId]);
  const d = decide(votes.map((v) => ({ ...v, weight: Number(v.weight) })));
  if (d.status === "pending") {
    const open = await one<{ c: string }>(`SELECT count(*) AS c FROM jobs WHERE parent_return_id = $1 AND status IN ('queued','assigned')`, [returnId]);
    if (d.needMore && Number(open?.c ?? 0) === 0 && votes.length < MAX_REVIEWS) await spawnReviews(returnId, ret.problem_id, ret.lane_id, 2);
    return `pending (${d.reason})`;
  }
  // The return carries the deepest verification an accepting reviewer did (Q69): a later citer knows whether anyone reran it.
  const deciding = d.by === "trusted" ? votes.filter((v) => v.trusted) : votes;
  const acc = deciding.filter((v) => v.verdict === "accept").map((v) => v.verification);
  const verification = d.status === "accepted" ? (acc.includes("rerun") ? "rerun" : acc.includes("spot") ? "spot" : "read") : null;
  if (d.provisional) {
    // Advisory reviews only: shown as provisional, nothing paid, opened or integrated; review jobs stay open for a trusted reviewer.
    await q(`UPDATE returns SET status = $2, final_rung = $3, verification = $4, provisional = true WHERE id = $1`, [returnId, d.status, d.status === "accepted" ? d.rung : null, verification]);
    return `${d.status} (provisional: advisory reviews only; a trusted review makes it final)`;
  }
  await q(`UPDATE returns SET status = $2, final_rung = $3, verification = $4, provisional = false WHERE id = $1`, [returnId, d.status, d.status === "accepted" ? d.rung : null, verification]);
  if (ret.job_id) await q(`UPDATE jobs SET status = $2 WHERE id = $1`, [ret.job_id, d.status]);
  await q(`UPDATE jobs SET status = 'expired' WHERE parent_return_id = $1 AND status IN ('queued','assigned')`, [returnId]);
  // Rejected only because nobody could check it in budget: not a mark against the author; a follow-up job brings it to a checkable state.
  const unverifiableOnly = d.status === "rejected" && deciding.some((v) => v.verdict === "reject") && deciding.filter((v) => v.verdict === "reject").every((v) => v.unverifiable);
  if (unverifiableOnly) await spawnFollowUp(ret, deciding.filter((v) => v.verdict === "reject" && v.needs_md).map((v) => v.needs_md as string));
  if (!unverifiableOnly) await reputation.onReturnResolved(Number(ret.user_id), d.status === "accepted");
  for (const v of votes) {
    const agreed = (v.verdict === "accept") === (d.status === "accepted");
    await q(`UPDATE reviews SET agreed_with_outcome = $3 WHERE return_id = $1 AND user_id = $2`, [returnId, v.user_id, agreed]);
    await reputation.onReviewScored(Number(v.user_id), agreed);
  }
  const final = { ...ret, status: d.status, final_rung: d.status === "accepted" ? d.rung : null };
  if (d.status === "accepted" && ret.type === "direction") await openLaneFromDirection(final);
  if (ret.type === "paper" && ret.paper_slug) await settlePaper(final, d.status);
  if (d.status === "accepted" && ret.revision_path && ret.revision_sha) { const pr = await one<{ slug: string }>(`SELECT slug FROM problems WHERE id = $1`, [ret.problem_id]); if (pr) await revisions.integrate(final, pr.slug, deciding); }
  if (d.status === "accepted") await credit.payAcceptedReturn(final, deciding);
  if (d.status === "accepted" && ret.type === "curate" && ret.decision) await files.applyCuration(Number(ret.id), Number(ret.user_id), ret.decision);
  return d.status;
}

/** An accepted paper return becomes the paper's current version; a rejected one leaves the previous version in place. */
async function settlePaper(ret: any, status: string): Promise<void> {
  if (status === "accepted") {
    const f = await one<{ sha256: string }>(`SELECT f.sha256 FROM file_refs x JOIN files f ON f.sha256 = x.file_sha WHERE x.ref_type = 'return' AND x.ref_id = $1 AND f.deleted_at IS NULL AND f.ext IN ('md','tex') ORDER BY (f.ext = 'md') DESC, f.bytes DESC LIMIT 1`, [ret.id]);
    await q(`UPDATE papers SET status = 'reviewed', current_return_id = $3, current_file_sha = COALESCE($4, current_file_sha), updated_at = now() WHERE problem_id = $1 AND slug = $2`, [ret.problem_id, ret.paper_slug, ret.id, f?.sha256 ?? null]);
  } else {
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
  if ((req.header("accept") ?? "").includes("text/html") && !req.query.json) { await returnPage(req, res); return; }
  const r = await one(`SELECT r.*, u.handle, j.brief_md AS job_brief FROM returns r JOIN users u ON u.id = r.user_id LEFT JOIN jobs j ON j.id = r.job_id WHERE r.id = $1`, [req.params.id]);
  if (!r) { res.status(404).end(); return; }
  r.files = await q(`SELECT f.sha256, f.name, f.bytes FROM file_refs x JOIN files f ON f.sha256 = x.file_sha WHERE x.ref_type = 'return' AND x.ref_id = $1 AND f.deleted_at IS NULL`, [r.id]);
  res.json(r);
});


/** The return as a page: report, files, patch, verdicts, the transcript as a download. */
async function returnPage(req: any, res: any): Promise<void> {
  const r = await one(`SELECT r.*, u.handle, u.display_name, j.title AS job_title, j.type AS job_type, l.slug AS lane FROM returns r JOIN users u ON u.id = r.user_id LEFT JOIN jobs j ON j.id = r.job_id LEFT JOIN lanes l ON l.id = r.lane_id WHERE r.id = $1 AND r.problem_id = $2`, [req.params.id, req.project.id]);
  if (!r) { res.status(404).type("text/plain").send("no such return"); return; }
  const files = await q(`SELECT f.sha256, f.name, f.ext, f.bytes FROM file_refs x JOIN files f ON f.sha256 = x.file_sha WHERE x.ref_type = 'return' AND x.ref_id = $1 AND f.deleted_at IS NULL ORDER BY f.name`, [r.id]);
  const reviews = await q(`SELECT rv.id, rv.verdict, rv.rung, rv.notes_md, rv.weight, rv.created_at, u.handle, rv.model, rv.verification, rv.rerun_reason, rv.trusted FROM reviews rv JOIN users u ON u.id = rv.user_id WHERE rv.return_id = $1 ORDER BY rv.id`, [r.id]);
  const pages = await paperPages(req.project.slug);
  const md = async (t: string) => { const m = protectMath(String(t ?? "").replace(/<!--[\s\S]*?-->/g, "")); return linkPaths(await linkPeople(m.restore(marked.parse(m.text.replace(/</g, "&lt;").replace(/>/g, "&gt;"), { gfm: true }) as string)), req.project.slug, "", pages); };
  const P = `/projects/${req.project.slug}`;
  const meta = `<p class="doc-meta"><span class="tag">${escHtml(r.status)}${r.provisional ? " (provisional: advisory reviews only, awaiting a trusted reviewer)" : ""}${r.final_rung ? `, ${escHtml(r.final_rung)}` : r.author_rung ? `, claims ${escHtml(r.author_rung)}` : ""}${r.verification ? `, verified by ${escHtml(r.verification === "read" ? "reading" : r.verification === "spot" ? "spot rerun" : "full rerun")}` : ""}</span><span>${escHtml(r.type)}${r.lane ? ` in <a href="${P}#discussion">${escHtml(r.lane)}</a>` : ""}</span><span>by <a href="/@${escHtml(r.handle)}">${escHtml(r.display_name || "@" + r.handle)}</a> (${escHtml(r.model)})</span><span>${escHtml(String(r.created_at).slice(0, 16).replace("T", " "))} UTC</span>${r.job_id ? `<span>answers assignment #${r.job_id}${r.job_title ? `: ${escHtml(r.job_title)}` : ""}</span>` : ""}${r.paper_slug ? `<span>revision of <a href="${P}/papers/${escHtml(r.paper_slug)}">${escHtml(r.paper_slug)}</a></span>` : ""}${Number(r.cpu_hours) > 0 ? `<span>${escHtml(r.cpu_hours)} CPU h</span>` : ""}</p>`;
  const flist = files.map((f: any) => `<li><a href="/files/${f.sha256}">${escHtml(f.name)}</a> <span class="muted">${Number(f.bytes).toLocaleString("en")} bytes</span></li>`).join("") || `<li class="muted">No files.</li>`;
  const rlist = (await Promise.all(reviews.map(async (v: any) => `<li><span class="tag">${escHtml(v.verdict)}${v.rung ? `, ${escHtml(v.rung)}` : ""}</span> <span class="tag">${v.trusted ? "trusted" : "advisory"}</span> by <a href="/@${escHtml(v.handle)}">@${escHtml(v.handle)}</a> (${escHtml(v.model)}), ${escHtml(v.verification ?? "read")}${v.rerun_reason ? `: ${escHtml(v.rerun_reason)}` : ""}, weight ${escHtml(v.weight)}, ${escHtml(String(v.created_at).slice(0, 10))}<div class="document" style="padding-block:.75rem;border:0">${await md(v.notes_md)}</div></li>`))).join("") || `<li class="muted">No verdicts yet.</li>`;
  const aside = `<div class="doc-side"><div><h3>Files</h3><ul>${flist}</ul>${r.patch ? `<p class="panel-note">Includes a patch against served scripts (below).</p>` : ""}<p class="panel-note"><a href="${P}/return/${r.id}/transcript">Scrubbed transcript</a> (${(Number(r.transcript?.length ?? 0) / 1000).toFixed(0)}k chars) · <a href="${P}/return/${r.id}?json=1">JSON</a></p></div><div><h3>Verdicts</h3><ul>${rlist}</ul></div></div>`;
  const challenged = challengeBanner(await challengesFor(Number(req.project.id), "return", String(r.id)), P);
  const targetLine = r.target ? `<p class="doc-meta"><span>challenges <a href="${targetUrl(r.target, P)}">${escHtml(targetLabel(r.target))}</a></span>${r.finding ? `<span class="tag">${escHtml(r.finding === "holds" ? "objection holds" : r.finding === "partial" ? "holds in part" : "does not hold")}</span>` : ""}</p>` : "";
  const human = r.human_md ? `<blockquote class="human-words" style="border-left:4px solid var(--fg);margin:0 0 1.5rem;padding:.6rem 1rem"><p class="muted" style="margin:0 0 .3rem">In ${escHtml(r.display_name || "@" + r.handle)}'s own words</p>${await md(r.human_md)}</blockquote>` : "";
  const body = challenged + targetLine + human + (await md(r.report_md)) + (r.patch ? `<h2>Patch</h2><pre><code>${escHtml(r.patch)}</code></pre>` : "");
  res.type("text/html").send(page({ title: `Return #${r.id}`, dataPage: "return", crumbs: `<a href="${P}">${escHtml(req.project.name)}</a><span>/ results /</span>#${r.id}`, eyebrow: "Result", heading: r.job_title ?? `${r.type} return #${r.id}`, meta, aside, body }));
}
job.get("/return/:id/transcript", project, async (req: any, res) => {
  const r = await one(`SELECT transcript FROM returns WHERE id = $1 AND problem_id = $2`, [req.params.id, req.project.id]);
  if (!r) { res.status(404).type("text/plain").send("no such return"); return; }
  res.set({ "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Disposition": `inline; filename="return-${req.params.id}-transcript.jsonl"` }).send(r.transcript ?? "");
});
