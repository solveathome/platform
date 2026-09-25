import { shareMeta } from "../lib/share.js";
import { wantsHtml } from "../lib/negotiate.js";
import { Router } from "express";
import { q, one } from "../db/index.js";
import { bearer, optionalAuth, cookieToken, issueToken, recoverToken, invalidateToken, issueBrowserSession, TokenRecoveryRequired } from "../lib/auth.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_DIR } from "../lib/paths.js";
import { projectPartial, readProjectConfig, featuredProject } from "../lib/projects.js";
import { leaderboard, type Window } from "../lib/credit.js";
import { projectActivity, runningWork } from "../lib/project-activity.js";
import { standings, PENDING_POINTS_SQL } from "../lib/standings.js";
import { researchSummary } from '../lib/research.js';
import { jobLabel, JOB_LABEL_SQL } from '../lib/research-format.js';
import { researchPolicy, researchAllocation, workConcentration } from '../lib/scheduler.js';

const page = (name: string) => readFileSync(join(PUBLIC_DIR, name), "utf8");

export const board = Router({ mergeParams: true });
export const root = Router();

/** GET /projects/:slug : project introduction, agent activity, and research workspace. */
board.get("/", async (req: any, res) => {
  const p = await one(`SELECT slug, name, summary FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).type("text/plain").send("unknown project"); return; }
  if (!wantsHtml(req)) { res.redirect(`/projects/${p.slug}/board`); return; }
  const escape = (text: unknown) => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const intro = projectPartial(p.slug, "intro") ?? `<h2>About this project</h2><p class="lead">${escape(p.summary)}</p>`;
  const prior = projectPartial(p.slug, "prior-work") ?? '<h2>The research behind this project</h2><p class="muted">Explore the research, its origins, and the evidence available to build on.</p>';
  const readings = projectPartial(p.slug, "prior-readings") ?? "";
  const share = readProjectConfig(p.slug)?.share ?? {};
  res.type("text/html").send(page("project.html").replace("__SHARE__", shareMeta({ title: share.title ?? `${p.name} · solveathome`, description: share.description ?? (p.summary || undefined), path: `/projects/${p.slug}`, image: share.image })).replaceAll("__SLUG__", p.slug).replaceAll("__NAME__", escape(p.name)).replace("__PROJECT_INTRO__", intro).replace("__PROJECT_PRIOR_WORK__", prior).replace("__PROJECT_PRIOR_READINGS__", readings));
});

/** GET /me : who the cookie or bearer token belongs to (for the browser UI). */
const OWNER_SET = new Set((process.env.OWNER_HANDLES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
root.get("/me", optionalAuth, async (req: any, res) => {
  if (!req.user) { res.json({ signed_in: false }); return; }
  res.json({ signed_in: true, account_id: (await one(`SELECT agent_account_id FROM users WHERE id=$1`, [req.user.id]))?.agent_account_id, handle: req.user.handle, owner: OWNER_SET.has(String(req.user.handle).toLowerCase()) });
});

/** POST /me/token : the signed-in person's token for the start field. Cookie only, same-origin only, never on GET: a page script that can read /me cannot walk off with it by accident. */
root.post("/me/token", optionalAuth, async (req: any, res) => {
  const viaCookie = !(req.header("authorization") ?? "").startsWith("Bearer ");
  const site = req.header("sec-fetch-site");
  if (!req.user || !viaCookie || (site && site !== "same-origin")) { res.status(403).json({ error: "sign in on the site first" }); return; }
  res.setHeader("Cache-Control", "no-store");
  try { res.json({ handle: req.user.handle, token: await issueToken(req.user.id) }); }
  catch (error) { if (error instanceof TokenRecoveryRequired) { res.status(409).json({ error: error.message, code: "token_recovery_required" }); return; } throw error; }
});

// These actions require a signed-in browser and an explicit same-origin POST.
for (const action of ["recover", "invalidate"] as const) root.post(`/me/token/${action}`, optionalAuth, async (req: any, res) => {
  const site = req.header("sec-fetch-site");
  if (!req.user || req.header("authorization") || !cookieToken(req) || (site && site !== "same-origin")) { res.status(403).json({ error: "sign in on the site first" }); return; }
  res.setHeader("Cache-Control", "no-store");
  if (action === "recover") {
    if (typeof req.body?.token !== 'string' || req.body.token.length > 200 || !await recoverToken(req.body.token,req.user.id)) { res.status(400).json({ error: "that is not an active token for this account" }); return; }
  } else {
    if (req.body?.invalidate !== true) { res.status(400).json({ error: "explicit invalidate:true is required" }); return; }
    // Upgrade a legacy agent-token cookie before explicit invalidation, so the
    // person stays signed in and can retrieve the replacement afterwards.
    if(!cookieToken(req).startsWith('sahweb_')) {
      const browser=await issueBrowserSession(req.user.id);
      res.setHeader('Set-Cookie',`sah_session=${browser}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${(process.env.BASE_URL ?? '').startsWith('https')?'; Secure':''}`);
    }
    await invalidateToken(req.user.id);
  }
  res.json({ ok: true });
});

/** GET /projects/:slug/board : project-scoped activity and research records. */
board.get("/board", async (req, res) => {
  const problem = await one(`SELECT id, slug, name, repo_url, status_md, researcher_role,
    (SELECT handle FROM users WHERE id = problems.researcher_user_id) AS researcher,
    (SELECT display_name FROM users WHERE id = problems.researcher_user_id) AS researcher_name
    FROM problems WHERE slug = $1`, [(req.params as any).slug]);
  if (!problem) { res.status(404).json({ error: "unknown project" }); return; }
  const pid = problem.id;
  const rungs = await q(`SELECT final_rung AS rung, count(*) AS n FROM returns WHERE problem_id = $1 AND status = 'accepted' AND NOT provisional GROUP BY final_rung`, [pid]);
  const lanes = await q(`SELECT l.slug, l.title, l.variant, l.status,
    (SELECT count(*) FROM jobs j WHERE j.lane_id = l.id AND j.status = 'queued') AS queued,
    (SELECT count(*) FROM returns r WHERE r.lane_id = l.id AND r.status = 'accepted' AND NOT r.provisional) AS accepted
    FROM lanes l WHERE l.problem_id = $1 ORDER BY l.id`, [pid]);
  const queue = await q(`SELECT type, status, count(*) AS n FROM jobs WHERE problem_id = $1 GROUP BY type, status ORDER BY type, status`, [pid]);
  const recent = await q(`SELECT r.id, r.type, ${JOB_LABEL_SQL} AS label, r.status, r.final_rung, u.handle, r.created_at FROM returns r JOIN users u ON u.id = r.user_id LEFT JOIN jobs j ON j.id = r.job_id WHERE r.problem_id = $1 ORDER BY r.id DESC LIMIT 50`, [pid]);
  const health = await one(`
    SELECT
      (SELECT count(*) FROM returns WHERE problem_id = $1 AND status IN ('accepted','rejected')) AS decided,
      (SELECT count(*) FROM returns WHERE problem_id = $1 AND status = 'contested') AS contested,
      (SELECT count(*) FROM returns WHERE problem_id = $1 AND status = 'pending') AS pending,
      (SELECT count(*) FROM jobs WHERE problem_id = $1 AND status = 'queued') AS queued,
      (SELECT round(avg(CASE WHEN rv.agreed_with_outcome THEN 1 ELSE 0 END)::numeric, 3) FROM reviews rv JOIN returns r ON r.id = rv.return_id WHERE r.problem_id = $1 AND rv.agreed_with_outcome IS NOT NULL) AS reviewer_agreement`, [pid]);
  const contributors = await q(`
    SELECT u.handle, count(*) FILTER (WHERE r.status = 'accepted' AND NOT r.provisional) AS accepted, sum(r.cpu_hours) AS cpu_hours,
           count(*) FILTER (WHERE r.type = 'direction' AND r.status = 'accepted' AND NOT r.provisional) AS directions_accepted
    FROM returns r JOIN users u ON u.id = r.user_id WHERE r.problem_id = $1 GROUP BY u.handle ORDER BY accepted DESC, cpu_hours DESC LIMIT 200`, [pid]);
  const activity = await projectActivity(Number(pid));
  const { id: _omit, ...pub } = problem;
  // Recorded returns are unverified until someone elevates them (Sep 11 2026): listed so they are found.
  const recorded = (await q(`SELECT r.id, u.handle, r.model, r.type, r.created_at, l.slug AS lane, left(regexp_replace(r.report_md, E'\\n[\\s\\S]*$', ''), 160) AS head FROM returns r JOIN users u ON u.id = r.user_id LEFT JOIN lanes l ON l.id = r.lane_id WHERE r.problem_id = $1 AND r.status = 'recorded' ORDER BY r.id DESC LIMIT 20`, [problem.id])).map((r: any) => ({ ...r, id: Number(r.id), url: `/projects/${(req.params as any).slug}/return/${r.id}`, elevate: `POST /projects/${(req.params as any).slug}/return/${r.id}/request-review { note }` }));
  const recordedTotal = Number((await one<{ c: string }>(`SELECT count(*) AS c FROM returns WHERE problem_id = $1 AND status = 'recorded'`, [problem.id]))?.c ?? 0);
  const policyRow = await one(`SELECT research_allocation FROM problems WHERE id=$1`, [pid]);
  const research = { ...await researchSummary(Number(pid)), allocation: researchPolicy(problem.slug, policyRow?.research_allocation), hours: await researchAllocation(Number(pid)), concentration: await workConcentration(Number(pid)) };
  res.json({ project: pub, activity, rungs, lanes, queue, health, recent, contributors, recorded, recorded_total: recordedTotal, research });
});

/** GET /projects/:slug/activity : current assignments, with the agents and people doing them. */
board.get("/activity", async (req: any, res) => {
  const problem = await one(`SELECT id FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!problem) { res.status(404).json({ error: "unknown project" }); return; }
  res.json(await runningWork(Number(problem.id)));
});

/** POST /projects/:slug/claims (owner): upsert provenance claims. Never touches the credit ledger. */
const OWNERS = new Set((process.env.OWNER_HANDLES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
board.post("/claims", bearer, async (req: any, res) => {
  if (!OWNERS.has(String(req.user.handle).toLowerCase())) { res.status(403).json({ error: "owner only" }); return; }
  const p = await one(`SELECT id FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  const b = req.body ?? {}; const list = Array.isArray(b.claims) ? b.claims : [];
  let n = 0;
  for (const c of list) {
    if (!c?.path || !c?.ledger_id) continue;
    await q(`INSERT INTO claims (problem_id, ledger_id, path, kind, status, question, verdict, origin_handle, origin_role, origin_model, origin_model_role, origin_note, first_commit, last_commit, commits, corpus, session_commits, model_commits)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
             ON CONFLICT (problem_id, path) DO UPDATE SET ledger_id = EXCLUDED.ledger_id, kind = EXCLUDED.kind, status = EXCLUDED.status, question = EXCLUDED.question, verdict = EXCLUDED.verdict,
               origin_handle = EXCLUDED.origin_handle, origin_role = EXCLUDED.origin_role, origin_model = EXCLUDED.origin_model, origin_model_role = EXCLUDED.origin_model_role, origin_note = EXCLUDED.origin_note,
               first_commit = EXCLUDED.first_commit, last_commit = EXCLUDED.last_commit, commits = EXCLUDED.commits, corpus = EXCLUDED.corpus, session_commits = EXCLUDED.session_commits, model_commits = EXCLUDED.model_commits, updated_at = now()`,
      [p.id, String(c.ledger_id), String(c.path), String(c.kind ?? "note"), String(c.status ?? "UNKNOWN"), String(c.question ?? ""), String(c.verdict ?? ""), String(b.origin_handle ?? "unknown"), String(b.origin_role ?? ""), b.origin_model ?? null, String(b.origin_model_role ?? ""), String(b.origin_note ?? ""), c.first ?? null, c.last ?? null, Number(c.commits ?? 0), !!c.corpus, Number(c.session_commits ?? 0), c.model_commits ? JSON.stringify(c.model_commits) : null]);
    n++;
  }
  res.json({ ok: true, upserted: n });
});

/** GET /projects/:slug/claims : provenance list. */
board.get("/claims", async (req: any, res) => {
  const p = await one(`SELECT id FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  const rows = await q(`SELECT ledger_id, path, kind, status, question, verdict, origin_handle, origin_role, origin_model, origin_model_role, first_commit, last_commit, commits, corpus, session_commits, model_commits, scored FROM claims WHERE problem_id = $1 ORDER BY kind, path`, [p.id]);
  const by_status = await q(`SELECT status, count(*) AS n FROM claims WHERE problem_id = $1 GROUP BY status ORDER BY n DESC`, [p.id]);
  const by_origin = await q(`SELECT origin_handle, origin_role, origin_model, origin_model_role, max(origin_note) AS origin_note, count(*) AS n, count(*) FILTER (WHERE corpus) AS corpus_claims, min(first_commit) AS first, max(last_commit) AS last, sum(commits) AS commits, sum(session_commits) AS session_commits,
      sum((model_commits->>'claude')::int) AS claude_commits, sum((model_commits->>'claude-marked')::int) AS claude_marked_commits, sum((model_commits->>'gpt-6-astra')::int) AS astra_commits, sum((model_commits->>'claude-dispatched')::int) AS dispatched_commits
    FROM claims WHERE problem_id = $1 GROUP BY origin_handle, origin_role, origin_model, origin_model_role ORDER BY n DESC`, [p.id]);
  res.json({ by_status, by_origin, claims: rows });
});

/** GET /projects/:slug/leaderboard?window=all|30d|7d */
board.get("/leaderboard", async (req: any, res) => {
  const p = await one(`SELECT id FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  // A person lands on the rendered ladders inside the project page (Chris, Sep 11); agents keep the JSON.
  if (wantsHtml(req)) { res.redirect(302, `/projects/${req.params.slug}#contributors`); return; }
  const w = (["all", "30d", "7d"].includes(String(req.query.window)) ? String(req.query.window) : "all") as Window;
  res.json(await leaderboard(Number(p.id), w));
});
/** GET /projects/:slug/standings?window=all|30d|7d&sort=points|accepted|reviews|all_tokens|cpu_hours */
board.get("/standings", async (req: any, res) => {
  if (wantsHtml(req)) { res.redirect(302, `/projects/${req.params.slug}#contributors`); return; }
  const p = await one(`SELECT id FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  const w = (["all", "30d", "7d"].includes(String(req.query.window)) ? String(req.query.window) : "all") as Window;
  const me = req.query.me ? String(req.query.me).slice(0, 80) : null;
  res.json(await standings(Number(p.id), w, Math.min(500, Math.max(5, Number(req.query.limit ?? 100) || 100)), me, String(req.query.sort ?? "points")));
});
/** GET /leaderboard?window= : across all projects. */
root.get("/leaderboard", async (req, res) => {
  if (wantsHtml(req)) { const f = await featuredProject(); res.redirect(302, f ? `/projects/${f.slug}#contributors` : "/projects"); return; }
  const w = (["all", "30d", "7d"].includes(String(req.query.window)) ? String(req.query.window) : "all") as Window;
  res.json(await leaderboard(null, w));
});
/** GET /credit : the points table. */
root.get("/credit", async (_req, res) => { res.json((await leaderboard(null, "all", 1)).points); });

/** GET /@handle : a contributor. Three columns: agent time, compute, research input (scope 5b). */
root.get("/@:handle", async (req, res) => {
  if (wantsHtml(req)) { const h = String(req.params.handle).replace(/[^A-Za-z0-9-]/g, ""); res.type("text/html").send(page("contributor.html").replace("__SHARE__", shareMeta({ title: `@${h} on solveathome`, description: `Returns, reviews and credit of @${h}: what their agents contributed to open problems, and how it was checked.`, path: `/@${h}`, type: "profile" })).replaceAll("__HANDLE__", h)); return; }
  const u = await one(`SELECT u.id, u.handle, u.display_name, u.website, u.created_at, rp.score, rp.accepted, rp.rejected, rp.review_agree, rp.review_disagree, rp.cpu_hours, rp.directions_accepted
    FROM users u LEFT JOIN reputation rp ON rp.user_id = u.id WHERE lower(u.handle) = lower($1)`, [req.params.handle]);
  if (!u) { res.status(404).json({ error: "no such contributor" }); return; }
  const recent = await q(`SELECT r.id, p.slug AS project, r.type, r.status, r.provisional, r.final_rung, r.tokens, r.created_at FROM returns r JOIN problems p ON p.id = r.problem_id WHERE r.user_id = $1 ORDER BY r.id DESC LIMIT 50`, [u.id]);
  const work = await one(`SELECT count(*)::int AS submitted,
      count(*) FILTER (WHERE status IN ('pending','contested') OR provisional)::int AS awaiting_review,
      count(*) FILTER (WHERE status = 'recorded')::int AS recorded,
      count(*) FILTER (WHERE tokens->>'log' IN ('antigravity','custom') AND tokens->>'source' = 'none' AND tokens->'already_counted' IS NULL AND tokens->'mismatch' IS NULL)::int AS usage_missing
    FROM returns WHERE user_id = $1`, [u.id]);
  const released = await q(`SELECT DISTINCT ON (m.job_id) m.job_id, j.title, j.type, j.research_stage, j.status, j.follow_up_of, p.slug AS project, m.body_md AS note, m.created_at
    FROM messages m JOIN jobs j ON j.id = m.job_id JOIN problems p ON p.id = j.problem_id
    WHERE m.user_id = $1 AND m.kind = 'done' AND m.body_md LIKE 'Released job #%'
      AND NOT EXISTS (SELECT 1 FROM returns r WHERE r.job_id = m.job_id AND r.user_id = $1)
    ORDER BY m.job_id DESC, m.id DESC LIMIT 20`, [u.id]);
  const lanes = await q(`SELECT p.slug AS project, l.slug, l.title FROM lanes l JOIN problems p ON p.id = l.problem_id WHERE l.origin_user_id = $1 ORDER BY l.id`, [u.id]);
  const ledger = await q(`SELECT c.kind, c.points, c.model, c.source_type, c.source_id, c.note, c.created_at, p.slug AS project,
      -- A review credit's source is the review job's id, or 'r<return id>' when the review was self-assigned (no job): never cast blind (a 500 on every profile with one such row, Sep 11).
      CASE WHEN c.source_type = 'review' AND c.source_id ~ '^[0-9]+$' THEN (SELECT j.parent_return_id FROM jobs j WHERE j.id = c.source_id::bigint)
           WHEN c.source_type = 'review' AND c.source_id ~ '^r[0-9]+$' THEN substring(c.source_id from 2)::bigint END AS review_of
    FROM credits c LEFT JOIN problems p ON p.id = c.problem_id WHERE c.user_id = $1 ORDER BY c.id DESC LIMIT 100`, [u.id]);
  const provenance = await q(`SELECT p.slug AS project, max(c.origin_role) AS role, max(c.origin_model) AS model, max(c.origin_model_role) AS model_role, count(*) AS claims, count(*) FILTER (WHERE c.kind = 'note') AS notes, count(*) FILTER (WHERE c.kind = 'script') AS scripts, count(*) FILTER (WHERE c.corpus) AS corpus_claims, min(c.first_commit) AS first, max(c.last_commit) AS last, sum(c.commits) AS commits
    FROM claims c JOIN problems p ON p.id = c.problem_id WHERE lower(c.origin_handle) = lower($1) GROUP BY p.slug`, [u.handle]);
  const totals = await q(`SELECT kind, sum(points) AS points, count(*)::int AS n FROM credits WHERE user_id = $1 GROUP BY kind`, [u.id]);
  const researcher_of = await q(`SELECT slug, name, researcher_role FROM problems WHERE researcher_user_id = $1`, [u.id]);
  // Roles as the trust page defines them: project_roles rows, plus the implicit owners (a project's researcher and OWNER_HANDLES).
  const roleRows = await q(`SELECT p.slug, p.name, pr.role FROM project_roles pr JOIN problems p ON p.id = pr.problem_id WHERE pr.user_id = $1 AND pr.revoked_at IS NULL ORDER BY pr.role, p.slug`, [u.id]);
  const roles = [...roleRows, ...researcher_of.filter((r: any) => !roleRows.some((x: any) => x.slug === r.slug && x.role === "owner")).map((r: any) => ({ slug: r.slug, name: r.name, role: "owner" }))];
  if (OWNER_SET.has(String(u.handle).toLowerCase()) && !roles.some((r: any) => r.role === "owner")) roles.push({ slug: null, name: null, role: "owner" });
  const departments=await q(`SELECT d.id AS department_id,d.created_at,
    coalesce(json_agg(json_build_object('run_id',s.run_id,'project',p.slug,'model',s.model,'ended_at',s.ended_at,'last_seen',s.last_seen)) FILTER(WHERE s.id IS NOT NULL),'[]') AS runs
    FROM departments d LEFT JOIN sessions s ON s.department_id=d.id LEFT JOIN problems p ON p.id=s.problem_id WHERE d.user_id=$1 GROUP BY d.id ORDER BY d.created_at`,[u.id]);
  // The record as a person reads it (Sep 15 2026): standing among contributors, credit per day, the calibration rung of every
  // accepted result, work by kind, reviews given, the breakthroughs with their titles, and what each computer's agents are doing.
  // What the work awaiting review is worth if it gets in, by the same definition the board uses: base result points only,
  // no bonuses, nothing paid until a trusted verdict. Shown beside the total because a contributor whose returns are queued
  // has earned nothing yet and is not idle, and the difference between those two is the whole story of a slow review queue.
  const pending = await one<{ pending_points: string }>(`SELECT ${PENDING_POINTS_SQL} FROM returns WHERE user_id = $1`, [u.id]);
  const standing = await one(`WITH lifetime AS (SELECT user_id, sum(points) AS points FROM credits GROUP BY user_id)
    SELECT (SELECT count(*) FROM lifetime)::int AS contributors,
           (SELECT count(*) + 1 FROM lifetime WHERE points > coalesce((SELECT points FROM lifetime WHERE user_id = $1), 0))::int AS rank,
           coalesce((SELECT points FROM lifetime WHERE user_id = $1), 0) AS points`, [u.id]);
  const by_day = await q(`SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, sum(points) AS points, sum(sum(points)) OVER (ORDER BY created_at::date) AS cumulative
    FROM credits WHERE user_id = $1 GROUP BY created_at::date ORDER BY created_at::date`, [u.id]);
  const rungRows = await q(`SELECT final_rung AS rung, count(*)::int AS n FROM returns WHERE user_id = $1 AND status = 'accepted' AND final_rung IS NOT NULL GROUP BY final_rung`, [u.id]);
  const reachedRows = await q(`SELECT final_rung AS rung, count(DISTINCT user_id)::int AS n FROM returns WHERE status = 'accepted' AND final_rung IS NOT NULL GROUP BY final_rung`);
  const kinds = await q(`SELECT type, count(*)::int AS submitted, count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
      count(*) FILTER (WHERE status = 'rejected')::int AS rejected, count(*) FILTER (WHERE status = 'recorded')::int AS recorded,
      coalesce(json_object_agg(final_rung, n) FILTER (WHERE final_rung IS NOT NULL), '{}') AS rungs,
      coalesce(json_object_agg(verification, v) FILTER (WHERE verification IS NOT NULL), '{}') AS verification
    FROM (SELECT type, status, final_rung, verification,
            count(*) FILTER (WHERE status = 'accepted') OVER (PARTITION BY type, final_rung) AS n,
            count(*) FILTER (WHERE status = 'accepted') OVER (PARTITION BY type, verification) AS v
          FROM returns WHERE user_id = $1) x
    GROUP BY type ORDER BY accepted DESC, submitted DESC`, [u.id]);
  const reviews_given = await one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE verdict = 'accept')::int AS accept, count(*) FILTER (WHERE verdict = 'reject')::int AS reject,
      count(*) FILTER (WHERE agreed_with_outcome = false)::int AS disagreed, count(*) FILTER (WHERE agreed_with_outcome)::int AS agreed,
      count(*) FILTER (WHERE coalesce(verification, 'read') = 'rerun')::int AS rerun, count(*) FILTER (WHERE verification = 'spot')::int AS spot, count(*) FILTER (WHERE coalesce(verification, 'read') = 'read')::int AS read
    FROM reviews WHERE user_id = $1`, [u.id]);
  const models = await q(`SELECT model, count(*)::int AS submitted, count(*) FILTER (WHERE status = 'accepted')::int AS accepted FROM returns WHERE user_id = $1 GROUP BY model ORDER BY submitted DESC, model`, [u.id]);
  const days = await q(`SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, count(*)::int AS submitted, count(*) FILTER (WHERE status = 'accepted')::int AS accepted
    FROM returns WHERE user_id = $1 GROUP BY created_at::date ORDER BY created_at::date`, [u.id]);
  const titleOf = (r: any) => r.job_title ?? String(r.report_md ?? "").split("\n").find((l: string) => l.trim())?.replace(/^#+\s*/, "").trim() ?? `${r.type} #${r.id}`;
  const summaryOf = (md: string) => { const blocks = String(md ?? "").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean); const body = blocks.find((b) => !b.startsWith("#") && !/^calibration ladder/i.test(b)) ?? ""; const t = body.replace(/^[-*]\s+/gm, "").replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " "); return t.length > 320 ? t.slice(0, 317).replace(/\s+\S*$/, "") + "…" : t; };
  // A route job's title is its stage and the route it worked on; what it produced is the outcome it reported (#sah-route-triage-title).
  // The title says what the work was about; the label what kind of work it was (#sah-route-triage-title: no "<type>: " in a title).
  const labelOf = (r: any) => jobLabel({ type: r.job_type ?? r.type, research_stage: r.research_stage, follow_up_of: r.follow_up_of });
  const routeOf = (r: any) => r.research_route_id ? { id: Number(r.research_route_id), stage: r.research_stage === 'triage' ? 'first_look' : r.research_stage, outcome: r.research_outcome ?? null } : null;
  const hlRows = await q(`SELECT r.id, p.slug AS project, r.type, r.model, r.verification, r.final_rung, r.created_at, r.revision_path, j.title AS job_title, j.type AS job_type, j.follow_up_of, j.research_stage, r.research_route_id, r.research->>'outcome' AS research_outcome, left(r.report_md, 4000) AS report_md, c.points, c.note,
      (SELECT count(*) FROM credits i WHERE i.kind = 'insight' AND i.source_type = 'return' AND i.source_id = r.id::text)::int AS cited
    FROM credits c JOIN returns r ON r.id = c.source_id::bigint JOIN problems p ON p.id = r.problem_id LEFT JOIN jobs j ON j.id = r.job_id
    WHERE c.user_id = $1 AND c.kind = 'breakthrough' AND c.source_type = 'return' AND c.source_id ~ '^[0-9]+$' ORDER BY c.points DESC, r.id LIMIT 6`, [u.id]);
  const highlights = hlRows.map((r: any) => ({ id: r.id, project: r.project, type: r.type, model: r.model, verification: r.verification, final_rung: r.final_rung, created_at: r.created_at, path: r.revision_path, points: Number(r.points), reason: r.note, cited: r.cited, title: titleOf(r), label: labelOf(r), summary: summaryOf(r.report_md), route: routeOf(r) }));
  const strongest = highlights.length ? [] : (await q(`SELECT r.id, p.slug AS project, r.type, r.model, r.verification, r.final_rung, r.created_at, r.revision_path, j.title AS job_title, j.type AS job_type, j.follow_up_of, j.research_stage, r.research_route_id, r.research->>'outcome' AS research_outcome, left(r.report_md, 4000) AS report_md,
      (SELECT count(*) FROM credits i WHERE i.kind = 'insight' AND i.source_type = 'return' AND i.source_id = r.id::text)::int AS cited
    FROM returns r JOIN problems p ON p.id = r.problem_id LEFT JOIN jobs j ON j.id = r.job_id WHERE r.user_id = $1 AND r.status = 'accepted' AND NOT r.provisional
    ORDER BY array_position(ARRAY['proven','verified','measured','heuristic','conjectured','refuted'], r.final_rung), array_position(ARRAY['rerun','spot','read'], coalesce(r.verification, 'read')), r.id DESC LIMIT 3`, [u.id]))
    .map((r: any) => ({ id: r.id, project: r.project, type: r.type, model: r.model, verification: r.verification, final_rung: r.final_rung, created_at: r.created_at, path: r.revision_path, points: 0, reason: null, cited: r.cited, title: titleOf(r), label: labelOf(r), summary: summaryOf(r.report_md), route: routeOf(r) }));
  const integratedPaths = await q(`SELECT DISTINCT r.revision_path AS path FROM credits c JOIN returns r ON r.id = c.source_id::bigint WHERE c.user_id = $1 AND c.kind = 'integrated' AND c.source_type = 'return' AND c.source_id ~ '^[0-9]+$' AND r.revision_path IS NOT NULL ORDER BY 1`, [u.id]);
  const cited = await one(`SELECT count(*)::int AS n, (SELECT source_id FROM credits WHERE user_id = $1 AND kind = 'insight' AND source_type = 'return' GROUP BY source_id ORDER BY count(*) DESC, source_id LIMIT 1) AS most FROM credits WHERE user_id = $1 AND kind = 'insight'`, [u.id]);
  const recentTitled = await q(`SELECT r.id, j.title AS job_title, j.type AS job_type, j.research_stage, j.follow_up_of, left(r.report_md, 600) AS report_md, r.type, r.model FROM returns r LEFT JOIN jobs j ON j.id = r.job_id WHERE r.user_id = $1 ORDER BY r.id DESC LIMIT 50`, [u.id]);
  const titles = new Map(recentTitled.map((r: any) => [String(r.id), { title: titleOf(r), label: labelOf(r), model: r.model }]));
  const recentOut = recent.map((r: any) => ({ ...r, ...(titles.get(String(r.id)) ?? {}) }));
  const deptOut = await Promise.all(departments.map(async (d: any) => {
    const runs = d.runs ?? [];
    const live = runs.filter((r: any) => !r.ended_at && r.last_seen && Date.now() - new Date(r.last_seen).getTime() < 3600_000);
    const job = await one(`SELECT j.title, p.slug AS project FROM jobs j JOIN sessions s ON s.id = j.assigned_session JOIN problems p ON p.id = j.problem_id WHERE s.department_id = $1 AND j.status = 'assigned' ORDER BY j.assigned_at DESC NULLS LAST LIMIT 1`, [d.department_id]);
    return { ...d, runs_count: runs.length, models: [...new Set(runs.map((r: any) => r.model).filter(Boolean))], last_seen: runs.reduce((m: string | null, r: any) => (!m || (r.last_seen && r.last_seen > m)) ? r.last_seen : m, null), live: live.length, current_job: job ?? null };
  }));
  const { id: _omit, ...pub } = u;
  res.json({ departments: deptOut, contributor: pub, researcher_of, roles, provenance,
             credit: { total: totals.reduce((s: number, t: any) => s + Number(t.points), 0), by_kind: Object.fromEntries(totals.map((t: any) => [t.kind, Number(t.points)])), count_by_kind: Object.fromEntries(totals.map((t: any) => [t.kind, Number(t.n)])), by_day, ledger },
             standing: { rank: standing?.rank ?? null, contributors: standing?.contributors ?? 0, points: Number(standing?.points ?? 0), pending_points: Number(pending?.pending_points ?? 0) },
             rungs: { accepted: Object.fromEntries(rungRows.map((r: any) => [r.rung, r.n])), contributors_reached: Object.fromEntries(reachedRows.map((r: any) => [r.rung, r.n])) },
             kinds, reviews_given, days, models, highlights: highlights.length ? highlights : strongest, highlights_kind: highlights.length ? "breakthrough" : "strongest",
             integrated_paths: integratedPaths.map((r: any) => r.path), cited: { count: cited?.n ?? 0, most: cited?.most ?? null },
             agent_time: { accepted: u.accepted, rejected: u.rejected, review_agree: u.review_agree, review_disagree: u.review_disagree },
             compute: { cpu_hours: u.cpu_hours }, research_input: { directions_accepted: u.directions_accepted, lanes }, work, released: released.map((r: any) => ({ ...r, label: jobLabel(r) })), recent: recentOut });
});

root.get("/my/jobs", bearer, async (req, res) => {
  res.json(await q(`SELECT j.id, p.slug AS project, j.type, j.title, j.status, j.assigned_at, j.expires_at FROM jobs j JOIN problems p ON p.id = j.problem_id WHERE j.assigned_to = $1 ORDER BY j.assigned_at DESC LIMIT 50`, [req.user!.id]));
});

root.get("/healthz", async (_req, res) => { await q("SELECT 1"); res.json({ ok: true }); });
