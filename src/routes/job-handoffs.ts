import {Router} from 'express';
import {one, q} from '../db/index.js';
import {bearer, optionalAuth} from '../lib/auth.js';
import {assignmentMutation} from '../lib/assignments.js';
import {isGrantedTrusted, isOwner} from '../lib/roles.js';
import {CONTACT_LIVE} from '../lib/agent-profile.js';
import {handoffText, handoffHistory} from '../lib/job-handoffs.js';

export const jobHandoffs = Router({mergeParams:true});
async function project(req:any,res:any,next:any) {
  req.project=await one('SELECT id,slug FROM problems WHERE slug=$1',[req.params.slug]);
  if (!req.project) {res.status(404).json({error:'unknown project'});return;}
  next();
}

jobHandoffs.get('/job-handoffs',optionalAuth,project,async(req:any,res:any)=>{
  const rows=await q(`SELECT h.job_id,h.id FROM job_handoffs h JOIN jobs j ON j.id=h.job_id
    WHERE j.problem_id=$1 AND h.status='waiting' AND ($2::bigint IS NULL OR h.recipient_user_id=$2)
    ORDER BY h.id DESC LIMIT 100`,[req.project.id,req.query.to==='me' ? req.user?.id??-1 : null]);
  const items=[];
  for(const row of rows) items.push({job_id:Number(row.job_id),...(await handoffHistory(Number(row.job_id))).find(h=>h.id===row.id)});
  res.json({handoffs:items,how:'These jobs need a named person or agent. Read the requirements on the job; human-directed revisits preserve trust, tier and consent. Closing a handoff does not resolve scientific findings.'});
});

/** Record a prerequisite for a named person or available research contact. No message or new assignment is sent. */
jobHandoffs.post('/job/:id/handoff',bearer,project,assignmentMutation(async(req:any,res:any)=>{
  if (!await isGrantedTrusted(req.project.id,req.user.id,req.user.handle)) {
    res.status(403).json({error:'a project owner or granted trusted member must authorize a named handoff'});return;
  }
  const j=await one('SELECT id,status FROM jobs WHERE id=$1 AND problem_id=$2',[req.params.id,req.project.id]);
  if (!j) {res.status(404).json({error:'no such job'});return;}
  if (j.status!=='queued') {res.status(409).json({error:'only a queued job can be handed off; do not transfer or release another attempt'});return;}
  if (await one("SELECT id FROM job_handoffs WHERE job_id=$1 AND status='waiting'",[j.id])) {
    res.status(409).json({error:'this job already has a waiting handoff; close it before changing the recipient'});return;
  }
  const b=req.body??{};
  let reason,access,resume;
  try {reason=handoffText(b.reason_md,'reason_md');access=handoffText(b.required_access_md,'required_access_md');resume=handoffText(b.resume_when,'resume_when');}
  catch(error:any) {res.status(400).json({error:error.message});return;}
  if (!['person','agent'].includes(b.recipient?.kind)) {res.status(400).json({error:'recipient.kind must be person or agent'});return;}
  const person=b.recipient.kind==='person';
  if ((person && b.recipient.contact_id) || (!person && b.recipient.handle)) {res.status(400).json({error:'use a handle for a person or a contact_id for an agent'});return;}
  const target=person
    ? await one('SELECT id AS user_id FROM users WHERE lower(handle)=lower($1)',[String(b.recipient.handle??'').replace(/^@/,'')])
    : await one(`SELECT s.user_id,s.contact_id FROM sessions s WHERE s.problem_id=$1 AND s.contact_id=$2 AND ${CONTACT_LIVE}`,[req.project.id,String(b.recipient.contact_id??'')]);
  if (!target) {res.status(404).json({error:'no such person or available research contact; choose a real recipient'});return;}
  const h=await one(`INSERT INTO job_handoffs(job_id,recipient_kind,recipient_user_id,recipient_contact,reason_md,required_access_md,resume_when,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[j.id,b.recipient.kind,target.user_id,target.contact_id??null,reason,access,resume,req.user.id]);
  res.json({ok:true,handoff_id:Number(h.id),job_id:Number(j.id),handoffs:await handoffHistory(Number(j.id)),notification_sent:false});
}));

/** Close an operational handoff; scientific findings still require their normal repair and review. */
jobHandoffs.post('/job/:id/handoff/:handoffId/close',bearer,project,assignmentMutation(async(req:any,res:any)=>{
  const h=await one(`SELECT h.* FROM job_handoffs h JOIN jobs j ON j.id=h.job_id WHERE h.id=$1 AND h.job_id=$2 AND j.problem_id=$3`,[req.params.handoffId,req.params.id,req.project.id]);
  if (!h) {res.status(404).json({error:'no such handoff'});return;}
  const liveContact=h.recipient_kind==='agent' && req.agentSession?.contact_id===h.recipient_contact
    ? await one(`SELECT s.id FROM sessions s WHERE s.id=$1 AND s.user_id=$2 AND s.problem_id=$3 AND ${CONTACT_LIVE}`,[req.agentSession.id,req.user.id,req.project.id]) : null;
  const recipient=Number(h.recipient_user_id)===req.user.id && (h.recipient_kind==='person' || !!liveContact);
  if (Number(h.created_by)!==req.user.id && !recipient && !await isOwner(req.project.id,req.user.id,req.user.handle)) {
    res.status(403).json({error:'only the creator, named recipient or project owner can close this handoff'});return;
  }
  const b=req.body??{};
  if (!['resolved','cancelled'].includes(b.status)) {res.status(400).json({error:'status must be resolved or cancelled'});return;}
  let note;try {note=handoffText(b.resolution_md,'resolution_md');}catch(error:any){res.status(400).json({error:error.message});return;}
  if (h.status!=='waiting') {
    if (h.status!==b.status || h.resolution_md!==note) {res.status(409).json({error:'this handoff already closed; its history is retained'});return;}
  } else await q(`UPDATE job_handoffs SET status=$2,resolution_md=$3,closed_by=$4,closed_at=now() WHERE id=$1`,[h.id,b.status,note,req.user.id]);
  res.json({ok:true,job_id:Number(h.job_id),handoffs:await handoffHistory(Number(h.job_id)),scientific_findings_unchanged:true});
}));
