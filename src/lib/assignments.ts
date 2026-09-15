/** Atomic ownership changes. The project lock also serializes its discovery allocation and generated questions. */
import { createHash, randomBytes } from "node:crypto";
import type { RequestHandler } from "express";
import { one, q, projectTransaction } from "../db/index.js";
import { canonicalModel, parseEffort, providerFromModel, isHarnessModel, modelIdentityError } from "./model-id.js";
import { stageOf } from './research-format.js';

class Refused extends Error {}
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const digest = (v: any) => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");

/** Buffer the response until the transaction commits; a failed submission rolls back all its DB effects. */
/**
 * Why a completion was refused, in terms of the request that was sent (platform issue #88). Every fact is already in it: the
 * attempt the header names, the job the body names, and what this run currently holds. The old text said only "fetch /start
 * for current work", which is the one thing an agent must not do while it still holds an unsubmitted assignment: following it
 * takes a second live assignment and leaves the first untracked. A failed /result also re-uploads the whole transcript, so a
 * message that turns the diagnosis into the fix is worth the two queries it costs.
 */
async function staleAttemptError(aid: string, job: any, sessionId: string, userId: number): Promise<string> {
  const short = (id: unknown) => String(id ?? "").slice(0, 8);
  const named = aid ? await one<{ id: string; job_id: string; status: string; receipt: any }>(`SELECT id, job_id, status, receipt FROM assignment_attempts WHERE id = $1`, [aid]) : null;
  const live = job.attempt_id ? await one<{ id: string; status: string; session_id: string }>(`SELECT id, status, session_id FROM assignment_attempts WHERE id = $1`, [job.attempt_id]) : null;
  const held = await q<{ id: string }>(`SELECT id FROM jobs WHERE problem_id = $1 AND assigned_session = $2 AND status = 'assigned' ORDER BY id`, [job.problem_id, sessionId]);
  const holding = held.map((h) => `#${h.id}`).join(", ");
  // The header and the body name different assignments: almost always a client that built X-Attempt from run state, not from this request.
  if (named && String(named.job_id) !== String(job.id)) {
    const was = named.receipt?.return_id ? `, submitted as return #${named.receipt.return_id}` : named.status ? `, ${named.status}` : "";
    const use = live && live.session_id === sessionId && live.status === "assigned"
      ? ` Job #${job.id}'s current attempt is ${live.id}: resend this result unchanged with X-Attempt: ${live.id}.`
      : ` Job #${job.id} is ${job.status}${job.status === "assigned" ? " but its attempt is not this run's" : ""}.`;
    return `X-Attempt names attempt ${short(named.id)}… of job #${named.job_id}${was}, and the body's job_id is ${job.id}: the two name different assignments, so nothing was submitted.${use}${holding ? ` Do not fetch /start while this run still holds ${holding}: that would take another assignment and leave this one unaccounted for.` : ""}`;
  }
  if (aid && !named) return `X-Attempt names ${short(aid)}…, which is not an attempt of job #${job.id}${live ? `; its current attempt is ${live.id}` : ""}. Nothing was submitted. Use the attempt id from this assignment's brief${holding ? `, and do not fetch /start while this run still holds ${holding}` : ""}.`;
  if (aid && named && live && live.id !== aid) return `attempt ${short(aid)}… of job #${job.id} was replaced by ${live.id}${live.session_id === sessionId ? ", which this run holds: resend with that X-Attempt" : ", which another of your sessions holds: send that agent's X-Session"}. Nothing was submitted.`;
  const expired = job.expires_at && new Date(job.expires_at).getTime() <= Date.now();
  return `job #${job.id} is ${expired ? "past its deadline" : `no longer assigned (${job.status})`}, so this result was not recorded.${holding ? ` This run still holds ${holding}: finish or release ${held.length === 1 ? "it" : "them"} first.` : " Fetch /start for current work."}`;
}

export function assignmentMutation(handler: (req: any, res: any) => Promise<void>, options: { completion?: boolean | "release"; historicalEvidence?: boolean; commitErrors?: boolean } = {}): RequestHandler {
  return async (req: any, res, next) => {
    const json = res.json, send = res.send;
    let response: { kind: "json" | "send"; body: any } | undefined;
    res.json = ((body: any) => { response = { kind: "json", body }; return res; }) as any;
    res.send = ((body: any) => { response = { kind: "send", body }; return res; }) as any;
    try {
      try {
        await projectTransaction(req.project.id, async () => {
          const xs = String(req.header("x-session") ?? "").trim();
          if (xs) {
            const s = await one(`SELECT * FROM sessions WHERE id = $1 AND user_id = $2 AND problem_id = $3`, [xs, req.user.id, req.project.id]);
            if (!s) { res.status(403).json({ error: "unknown session for this owner and project" }); throw new Refused(); }
            // Repair only an old app/persona label or unknown, never switch a real model's session.
            // The existing assignment, limits and sibling sessions keep their ownership.
            if ((isHarnessModel(s.model) || s.model === "unknown") && req.model && req.model !== s.model && !isHarnessModel(req.model) && !s.ended_at) {
              const from = s.model;
              req.modelCorrection = { from, to: req.model, note: "Corrected this session's model declaration. Keep this X-Model on subsequent requests; earlier returns are unchanged." };
              await q(`UPDATE sessions SET model = $2 WHERE id = $1`, [xs, req.model]);
              await q(`UPDATE assignment_attempts SET model = $2, reason = reason || jsonb_build_object('model_correction', $3::jsonb) WHERE session_id = $1 AND status = 'assigned'`, [xs, req.model, JSON.stringify(req.modelCorrection)]);
              s.model = req.model;
            }
            if (req.model && s.model && canonicalModel(req.model) !== s.model) { res.status(409).json({ error: `session was registered for model ${s.model}`, session_model: s.model }); throw new Refused(); }
            req.model = s.model ?? req.model;
            const identityError = modelIdentityError(req.model);
            const ending = options.completion === "release" || (req.method === "POST" && /\/sessions\/[^/]+\/end$/.test(req.path));
            if (identityError && !ending) { res.status(400).json({ error: identityError, code: "model_identity_required" }); throw new Refused(); }
            req.provider = req.model ? (await one(`SELECT provider FROM model_tiers WHERE model = $1`, [req.model]))?.provider ?? providerFromModel(req.model) : undefined;
            req.effort = parseEffort(s.effort_evidence) ?? req.effort ?? parseEffort(s.effort);
            req.agentSession = s;
            await q(`SELECT set_config('solveathome.session',$1,true)`,[s.id]);
          }
          const department = String(req.header("x-department") ?? "");
          if (department && (!await one(`SELECT 1 FROM departments WHERE id=$1 AND user_id=$2`, [department,req.user.id]) || (req.agentSession && req.agentSession.department_id !== department))) {
            res.status(403).json({ error: "department does not belong to this account and session" }); throw new Refused();
          }
          if (req.agentSession?.department_id && department !== req.agentSession.department_id) {
            res.status(403).json({ error: "send this run's X-Department" }); throw new Refused();
          }
          const requestId = req.method === 'POST' ? String(req.header('x-request-id') ?? '') : '';
          const receiptScope = `${req.project.id}:${xs || req.header('x-launch-id') || 'account'}`;
          const requestHash = digest({ method:req.method,path:req.originalUrl,body:req.body ?? {} });
          if (requestId) {
            if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) { res.status(400).json({ error:'invalid X-Request-ID' }); throw new Refused(); }
            const previous = await one(`SELECT * FROM mutation_receipts WHERE user_id=$1 AND session_id=$2 AND request_id=$3`, [req.user.id,receiptScope,requestId]);
            if (previous) {
              if (previous.request_hash !== requestHash) { res.status(409).json({ error:'request ID already used with different content' }); throw new Refused(); }
              res.status(previous.status).json(previous.receipt); return;
            }
          }
          // Receipts remain readable after a run ends; new work does not.
          if (req.agentSession?.department_id && req.method === 'POST' && !options.completion && !options.historicalEvidence && !/\/end$/.test(req.path)
              && (req.agentSession.ended_at || (req.agentSession.ends_at && new Date(req.agentSession.ends_at).getTime() <= Date.now() && !await one(`SELECT 1 FROM jobs WHERE assigned_session=$1 AND status='assigned' AND (expires_at IS NULL OR expires_at>now())`,[xs])))) {
            res.status(409).json({ error:'run ended; a fresh instruction is required for new work' }); throw new Refused();
          }
          let attempt: any;
          const hash = options.completion ? digest({ operation: options.completion === "release" ? "release" : "result", body: req.body ?? {} }) : null;
          if (options.completion && req.body?.job_id) {
            const j = await one(`SELECT * FROM jobs WHERE id = $1 AND problem_id = $2 FOR UPDATE`, [req.body.job_id, req.project.id]);
            if (!j) { res.status(404).json({ error: "job not found in this project" }); throw new Refused(); }
            // During a rolling deployment the old slot can still claim a job without rotating its attempt ID.
            // Adopt only a legacy request from the current holder; never let an explicit old attempt claim new ownership.
            if (j.status === "assigned" && !req.body.attempt_id && !req.header("x-attempt") && !req.agentSession?.launch_key
                && Number(j.assigned_to) === req.user.id && j.assigned_session === xs) {
              const current = j.attempt_id ? await one(`SELECT status, session_id FROM assignment_attempts WHERE id = $1`, [j.attempt_id]) : null;
              if (!current || current.status !== "assigned" || current.session_id !== xs) {
                j.attempt_id = randomBytes(16).toString("hex");
                await q(`INSERT INTO assignment_attempts (id,job_id,problem_id,session_id,user_id,model,budget_hours,started_at,scheduled,reason)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,'{"policy":"legacy assignment adopted during rollout"}')`,
                  [j.attempt_id,j.id,j.problem_id,xs,req.user.id,req.model ?? null,Math.min(Number(j.budget_hours),Number(req.agentSession?.ai?.max_hours_per_assignment ?? 2)),j.assigned_at ?? new Date()]);
                await q(`UPDATE jobs SET attempt_id = $2 WHERE id = $1`, [j.id,j.attempt_id]);
              }
            }
            const aid = String(req.body.attempt_id ?? req.header("x-attempt") ?? j.attempt_id ?? "");
            attempt = aid ? await one(`SELECT * FROM assignment_attempts WHERE id = $1 AND job_id = $2`, [aid, j.id]) : null;
            if (Number(attempt?.user_id ?? j.assigned_to) !== req.user.id || ((attempt?.session_id ?? j.assigned_session) && xs !== (attempt?.session_id ?? j.assigned_session))) {
              res.status(403).json({ error: "this assignment is held by another of your sessions or another owner; send the holding agent's X-Session" }); throw new Refused();
            }
            if (req.agentSession?.launch_key && !req.body.attempt_id && !req.header("x-attempt")) {
              res.status(400).json({ error: "attempt_id is required; use the value in your assignment brief" }); throw new Refused();
            }
            if (attempt?.receipt) {
              if (attempt.request_hash !== hash) { res.status(409).json({ error: "this attempt already finished; retry the original request unchanged or use the existing revision endpoints for corrections" }); throw new Refused(); }
              res.json(attempt.receipt); return;
            }
            if ((aid && (!attempt || j.attempt_id !== aid)) || j.status !== "assigned" || (j.expires_at && new Date(j.expires_at).getTime() <= Date.now())) {
              res.status(409).json({ error: await staleAttemptError(aid, j, xs, req.user.id) }); throw new Refused();
            }
          }
          await handler(req, res);
          if (res.statusCode >= 400 && !options.commitErrors) throw new Refused();
          if (requestId && res.statusCode < 400 && response?.kind === 'json') await q(
            `INSERT INTO mutation_receipts(user_id,session_id,request_id,request_hash,status,receipt) VALUES($1,$2,$3,$4,$5,$6)`,
            [req.user.id,receiptScope,requestId,requestHash,res.statusCode,JSON.stringify(response.body)]);
          if (attempt && res.statusCode < 400 && response?.kind === "json") {
            if (req.modelCorrection) response.body = { ...response.body, model_correction: req.modelCorrection };
            await q(`UPDATE assignment_attempts SET receipt = $2, request_hash = $3 WHERE id = $1`, [attempt.id, JSON.stringify(response.body), hash]);
          }
        });
      } catch (error) { if (!(error instanceof Refused)) throw error; delete req.modelCorrection; }
      res.json = json; res.send = send;
      if (req.modelCorrection && response?.kind === "json") response.body = { ...response.body, model_correction: req.modelCorrection };
      if (req.modelCorrection && response?.kind === "send") response.body += `\n\nModel declaration corrected from ${req.modelCorrection.from} to ${req.modelCorrection.to}. Keep the corrected X-Model on subsequent requests.\n`;
      if (response) { if (response.kind === "json") res.json(response.body); else res.send(response.body); }
      else next();
    } catch (error) { res.json = json; res.send = send; next(error); }
  };
}

export async function claimAssignment(row: any, session: any, userId: number, tier: number, reason: any, scheduled = true): Promise<any> {
  const id = randomBytes(16).toString("hex");
  const hours = Math.min(Number(row.budget_hours), Number(session.ai?.max_hours_per_assignment ?? 2));
  const assigned = await one(`UPDATE jobs SET status = 'assigned', assigned_to = $2, assigned_session = $3, assigned_at = now(),
    expires_at = now() + ($4::numeric * interval '2 hours'), attempt_id = $5 WHERE id = $1 AND status = 'queued' RETURNING *`,
    [row.id, userId, session.id, Math.max(0.25, hours), id]);
  if (!assigned) throw new Error("assignment candidate was no longer queued");
  await q(`INSERT INTO assignment_attempts (id, job_id, problem_id, session_id, user_id, model, tier, purpose, scheduled, budget_hours, reason,research_stage,department_id,run_id,direction_snapshot)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, row.id, row.problem_id, session.id, userId, session.model, tier, row.purpose ?? "work", scheduled, hours, JSON.stringify(reason), stageOf(row),session.department_id ?? null,session.run_id ?? null,session.direction_snapshot ? JSON.stringify(session.direction_snapshot) : null]);
  const updated = await one(`UPDATE sessions SET jobs = jobs + 1, last_seen = now(), last_type = $2,
    review_streak = CASE WHEN $2 IN ('review','audit') THEN review_streak + 1 ELSE 0 END WHERE id = $1 RETURNING jobs`, [session.id, row.type]);
  session.jobs = Number(updated!.jobs);
  return { ...row, ...assigned, assignment_reason: reason };
}

export async function releaseAssignment(j: any, note: string): Promise<void> {
  await q(`UPDATE jobs SET status = CASE WHEN agent_direction_id IS NULL THEN 'queued' ELSE 'expired' END, assigned_to = NULL, assigned_session = NULL, assigned_at = NULL, expires_at = NULL,
    release_count = release_count + 1, last_released_session = assigned_session, last_release_note = $2 WHERE id = $1 AND status = 'assigned'`, [j.id, note.slice(0, 500)]);
}
