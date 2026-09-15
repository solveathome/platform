import { randomBytes } from 'node:crypto';
import { one, q } from '../db/index.js';
export const publicId = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
export const LIVE_RUN = `s.ended_at IS NULL AND s.last_seen>now()-interval '120 minutes'
  AND (((s.ends_at IS NULL OR s.ends_at>now()) AND (s.max_jobs IS NULL OR s.jobs<s.max_jobs))
    OR EXISTS(SELECT 1 FROM jobs WHERE assigned_session=s.id AND status='assigned' AND (expires_at IS NULL OR expires_at>now())))`;
export async function directionFor(session: any): Promise<any> {
  return session.direction_id ? one(`SELECT d.id,d.revision,d.state,d.note,r.words FROM agent_directions d
    JOIN agent_direction_revisions r ON r.direction_id=d.id AND r.revision=d.revision WHERE d.id=$1`, [session.direction_id]) : null;
}
export async function runBinding(req: any): Promise<any> {
  const id = String(req.header('x-department') ?? '');
  if (!id && req.query.workspace !== '1') return null;
  if (!id || !req.header('x-launch-id')) throw Object.assign(new Error('folder launch requires X-Department and X-Launch-ID; read the department protocol bootstrap section'),{status:400});
  if (!await one(`SELECT 1 FROM departments WHERE id=$1 AND user_id=$2`,[id,req.user.id])) throw Object.assign(new Error('unknown department for this account'),{status:403});
  const directionId = String(req.header('x-direction-id') ?? '') || null;
  const direction = directionId ? await one(`SELECT * FROM agent_directions WHERE id=$1 AND department_id=$2 AND problem_id=$3 AND user_id=$4`,[directionId,id,req.project.id,req.user.id]) : null;
  if (directionId && !direction) throw Object.assign(new Error('unknown direction in this department'),{status:403});
  if (req.query.directions === '1' && !direction) throw Object.assign(new Error('POST the original words to /departments/<id>/directions and send its X-Direction-ID before registration'),{status:400});
  const recoveryId=String(req.header('x-recover-attempt') ?? '') || null;
  if(recoveryId) {
    const a=await one(`SELECT * FROM assignment_attempts WHERE id=$1 AND department_id=$2 AND problem_id=$3 AND user_id=$4`,[recoveryId,id,req.project.id,req.user.id]);
    if(!a || !['released','cancelled'].includes(a.status) || (a.direction_snapshot && (!direction || ![direction.id,direction.continued_from].includes(a.direction_snapshot.id)))) throw Object.assign(new Error('recovery requires an interrupted attempt in this folder and an explicit continuation of its direction'),{status:409});
  }
  return { department_id:id,direction_id:directionId,recovery_attempt_id:recoveryId };
}

/** Original words remain private to the run. Public jobs describe its declared bounded step. */
export async function initialDirectionStep(req: any, session: any): Promise<any> {
  const d = await directionFor(session);
  session.direction_snapshot = d;
  if (!d || d.state !== 'active') return null;
  if (await one(`SELECT 1 FROM jobs WHERE agent_direction_id=$1`,[d.id])) return null;
  return one(`INSERT INTO jobs(problem_id,type,title,brief_md,git_ref,budget_hours,min_tier,agent_direction_id,agent_direction_revision)
    VALUES($1,'explore','Plan the next research step','Consult the relevant shared local evidence. Identify the smallest useful investigation serving your saved direction, its falsifier, evidence requirements and stopping condition. Record what is already known and any specific blocker. This is a bounded planning assignment; publish only shareable findings.','main',$2,99,$3,$4) RETURNING *`,
    [req.project.id,Math.min(.5,Number(session.ai.max_hours_per_assignment)),d.id,d.revision]);
}

/** Claiming responsibility for an ask never changes an agent's research direction. */
export async function canClaimAsk(a: any, s: any): Promise<boolean> {
  if (!s?.department_id || a.status !== 'open' || a.to_human) return false;
  if (!await one(`SELECT 1 FROM sessions s WHERE s.id=$1 AND ${LIVE_RUN}`,[s.id])) return false;
  if (a.to_contact) return a.to_contact === s.contact_id;
  if (a.to_user_id && Number(a.to_user_id) !== Number(s.user_id)) return false;
  if (a.to_department && a.to_department !== s.department_id) return false;
  if (a.to_run && a.to_run !== s.run_id) {
    if (a.handoff !== 'department' || await one(`SELECT 1 FROM sessions s WHERE s.run_id=$1 AND ${LIVE_RUN}`,[a.to_run])) return false;
    const original = await one(`SELECT department_id FROM sessions WHERE run_id=$1`,[a.to_run]);
    if (original?.department_id !== s.department_id) return false;
  }
  return a.from_run !== s.run_id;
}
export async function enqueueReply(messageId: number, parentId: number | null, pid: number): Promise<void> {
  if (!parentId) return;
  // Both sides of an ongoing conversation survive their originating run. Follow
  // the ancestry so a reply to a reply cannot lose the original department.
  await q(`WITH RECURSIVE parents AS (
    SELECT id,reply_to,department_id FROM messages WHERE id=$2
    UNION ALL SELECT m.id,m.reply_to,m.department_id FROM messages m JOIN parents p ON m.id=p.reply_to
  ) INSERT INTO department_deliveries(id,department_id,problem_id,message_id)
    SELECT md5(random()::text || clock_timestamp()::text || d.id),d.id,$3,$1 FROM departments d
    WHERE d.id IN (SELECT department_id FROM parents) ON CONFLICT(department_id,message_id) DO NOTHING`,[messageId,parentId,pid]);
}
