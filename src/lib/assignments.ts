/** Atomic ownership changes. The project lock also serializes its discovery allocation and generated questions. */
import { createHash, randomBytes } from "node:crypto";
import type { RequestHandler } from "express";
import { one, q, projectTransaction } from "../db/index.js";
import { canonicalModel, parseEffort, providerFromModel } from "./model-id.js";

class Refused extends Error {}
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const digest = (v: any) => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");

/** Buffer the response until the transaction commits; a failed submission rolls back all its DB effects. */
export function assignmentMutation(handler: (req: any, res: any) => Promise<void>, options: { completion?: boolean | "release"; commitErrors?: boolean } = {}): RequestHandler {
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
            if (req.model && s.model && canonicalModel(req.model) !== s.model) { res.status(409).json({ error: `session was registered for model ${s.model}`, session_model: s.model }); throw new Refused(); }
            req.model = s.model ?? req.model;
            req.provider = req.model ? (await one(`SELECT provider FROM model_tiers WHERE model = $1`, [req.model]))?.provider ?? providerFromModel(req.model) : undefined;
            req.effort = parseEffort(s.effort_evidence) ?? req.effort ?? parseEffort(s.effort);
            req.agentSession = s;
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
              res.status(409).json({ error: "this assignment is no longer active; fetch /start for current work" }); throw new Refused();
            }
          }
          await handler(req, res);
          if (res.statusCode >= 400 && !options.commitErrors) throw new Refused();
          if (attempt && res.statusCode < 400 && response?.kind === "json") {
            await q(`UPDATE assignment_attempts SET receipt = $2, request_hash = $3 WHERE id = $1`, [attempt.id, JSON.stringify(response.body), hash]);
          }
        });
      } catch (error) { if (!(error instanceof Refused)) throw error; }
      res.json = json; res.send = send;
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
  await q(`INSERT INTO assignment_attempts (id, job_id, problem_id, session_id, user_id, model, tier, purpose, scheduled, budget_hours, reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, row.id, row.problem_id, session.id, userId, session.model, tier, row.purpose ?? "work", scheduled, hours, JSON.stringify(reason)]);
  const updated = await one(`UPDATE sessions SET jobs = jobs + 1, last_seen = now(), last_type = $2,
    review_streak = CASE WHEN $2 IN ('review','audit') THEN review_streak + 1 ELSE 0 END WHERE id = $1 RETURNING jobs`, [session.id, row.type]);
  session.jobs = Number(updated!.jobs);
  return { ...row, ...assigned, assignment_reason: reason };
}

export async function releaseAssignment(j: any, note: string): Promise<void> {
  await q(`UPDATE jobs SET status = 'queued', assigned_to = NULL, assigned_session = NULL, assigned_at = NULL, expires_at = NULL,
    release_count = release_count + 1, last_released_session = assigned_session, last_release_note = $2 WHERE id = $1 AND status = 'assigned'`, [j.id, note.slice(0, 500)]);
}
