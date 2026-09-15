import { DEPARTMENT_PROTOCOL } from '../lib/workspace-guidance.js';
import { Router } from 'express';
import { bearer } from '../lib/auth.js';
import { one, q } from '../db/index.js';
import { assignmentMutation } from '../lib/assignments.js';
import { publicId, directionFor, canClaimAsk, LIVE_RUN } from '../lib/departments.js';
import { matchingMetadata } from '../lib/agent-profile.js';
export const departments = Router({mergeParams:true});
departments.use((req,res,next) => /^\/(?:departments(?:\/|$)|run(?:\/|$)|department(?:\/|$)|asks\/[^/]+\/claim$)/.test(req.path) ? next() : next('router'));
departments.use(bearer, async (req:any,res,next) => {
  req.project = await one(`SELECT id,slug FROM problems WHERE slug=$1`,[req.params.slug]);
  if (!req.project) { res.status(404).json({error:'unknown project'}); return; }
  next();
});
departments.post('/departments/bootstrap',assignmentMutation(async(req,res) => {
  if(process.env.DEPARTMENT_MODE==='off') { res.status(503).json({error:'new department launches are temporarily disabled; existing sessions remain usable'}); return; }
  const key = String(req.body?.registration_key ?? '');
  if (!/^[A-Za-z0-9_-]{24,100}$/.test(key)) { res.status(400).json({error:'registration_key must be a persistent random folder key'}); return; }
  const d = await one(`INSERT INTO departments(id,user_id,registration_key) VALUES($1,$2,$3)
    ON CONFLICT(user_id,registration_key) DO UPDATE SET last_seen=now() RETURNING id`,[publicId('dept'),req.user.id,key]);
  res.json({department_id:d!.id,protocol:DEPARTMENT_PROTOCOL});
}));
departments.post('/departments/:department/directions',assignmentMutation(async(req,res) => {
  const did = req.params.department;
  if (!await one(`SELECT 1 FROM departments WHERE id=$1 AND user_id=$2`,[did,req.user.id])) { res.status(403).json({error:'unknown department'}); return; }
  const from = req.body?.continue_direction_id;
  const previous = from ? await one(`SELECT r.words FROM agent_directions d JOIN agent_direction_revisions r ON r.direction_id=d.id AND r.revision=d.revision
    WHERE d.id=$1 AND d.department_id=$2 AND d.problem_id=$3`,[from,did,req.project.id]) : null;
  if (from && (!previous || req.body?.words !== undefined)) { res.status(400).json({error:'explicit continuation must name one saved direction in this department'}); return; }
  const words = previous?.words ?? req.body?.words;
  if (typeof words !== 'string' || !words.trim() || words.length>4000) { res.status(400).json({error:'words must contain the original custom instruction (1–4000 characters)'}); return; }
  const id = publicId('direction');
  await q(`INSERT INTO agent_directions(id,department_id,problem_id,user_id,continued_from) VALUES($1,$2,$3,$4,$5)`,[id,did,req.project.id,req.user.id,from ?? null]);
  await q(`INSERT INTO agent_direction_revisions(direction_id,revision,words) VALUES($1,1,$2)`,[id,words]);
  res.json({direction_id:id,revision:1,words,state:'active'});
}));
departments.get('/departments/:department',assignmentMutation(async(req,res) => {
  if (!await one(`SELECT 1 FROM departments WHERE id=$1 AND user_id=$2`,[req.params.department,req.user.id])) { res.status(403).json({error:'unknown department'}); return; }
  res.json({department_id:req.params.department,runs:await q(`SELECT run_id,model,started_at,ended_at,direction_id FROM sessions WHERE department_id=$1 AND problem_id=$2 ORDER BY started_at DESC LIMIT 100`,[req.params.department,req.project.id])});
}));
async function ownRun(req:any,res:any): Promise<any> {
  const s = req.agentSession;
  if (!s?.department_id || !await one(`SELECT 1 FROM sessions s WHERE s.id=$1 AND ${LIVE_RUN}`,[s.id])) { res.status(403).json({error:'a live folder run is required'}); return null; }
  return s;
}
departments.get('/run/context',assignmentMutation(async(req,res) => {
  const s=req.agentSession;
  if (!s?.department_id) { res.status(403).json({error:'folder run required'}); return; }
  const attempt = await one(`SELECT id,job_id,status,receipt,direction_snapshot,assignment_payload,started_at,budget_hours FROM assignment_attempts WHERE session_id=$1 ORDER BY started_at DESC LIMIT 1`,[s.id]);
  res.json({run_id:s.run_id,department_id:s.department_id,direction:await directionFor(s),ended_at:s.ended_at,ends_at:s.ends_at,max_jobs:s.max_jobs,jobs:s.jobs,execution_active:!!await one(`SELECT 1 FROM sessions s JOIN jobs j ON j.assigned_session=s.id WHERE s.id=$1 AND j.status='assigned' AND (j.expires_at IS NULL OR j.expires_at>now()) AND s.ended_at IS NULL AND s.last_seen>now()-interval '120 minutes'`,[s.id]),attempt:attempt ?? null});
}));
departments.post('/run/direction',assignmentMutation(async(req,res) => {
  const s=await ownRun(req,res); if(!s) return;
  const b=req.body ?? {};
  const d=await directionFor(s);
  if (Number(b.revision) !== Number(d?.revision ?? 0)) { res.status(409).json({error:'direction revision changed; reload your context'}); return; }
  if (b.words !== undefined && (typeof b.words!=='string' || !b.words.trim() || b.words.length>4000 || b.user_instruction !== true)) { res.status(400).json({error:'updated words require an explicit user_instruction:true and 1–4000 original characters'}); return; }
  if (b.mode === 'general') {
    if (b.user_instruction !== true) { res.status(400).json({error:'only an explicit user instruction changes to general mode'}); return; }
    await q(`UPDATE sessions SET direction_id=NULL WHERE id=$1`,[s.id]);
  } else if (!d) {
    if (!b.words) { res.status(400).json({error:'words required to create a direction'}); return; }
    const id=publicId('direction');
    await q(`INSERT INTO agent_directions(id,department_id,problem_id,user_id) VALUES($1,$2,$3,$4)`,[id,s.department_id,req.project.id,req.user.id]);
    await q(`INSERT INTO agent_direction_revisions(direction_id,revision,words) VALUES($1,1,$2)`,[id,b.words]);
    await q(`UPDATE sessions SET direction_id=$2 WHERE id=$1`,[s.id,id]); s.direction_id=id;
  } else {
    const state=b.state ?? (b.words ? 'active':d.state);
    if (!['active','complete','blocked','paused','refuted'].includes(state) || (!b.words && state !== d.state && !String(b.note ?? '').trim())) { res.status(400).json({error:'a valid state and a reason for changing it are required'}); return; }
    if (state==='active' && d.state!=='active' && b.user_instruction!==true) { res.status(400).json({error:'reactivation requires an explicit user instruction'}); return; }
    if (b.words) await q(`INSERT INTO agent_direction_revisions(direction_id,revision,words) VALUES($1,$2,$3)`,[d.id,d.revision+1,b.words]);
    await q(`UPDATE agent_directions SET revision=$2,state=$3,note=$4 WHERE id=$1`,[d.id,d.revision+(b.words?1:0),state,String(b.note ?? '').slice(0,4000)]);
  }
  if(d) await q(`UPDATE jobs SET status='expired' WHERE agent_direction_id=$1 AND status='queued'`,[d.id]);
  if(b.mode==='general') s.direction_id=null;
  res.json({direction:await directionFor(s),held_scope:'An in-flight attempt keeps its issued direction; release it if the new instruction changes the work.'});
}));
departments.post('/run/next-step',assignmentMutation(async(req,res) => {
  const s=await ownRun(req,res); if(!s) return;
  const d=await directionFor(s),b=req.body ?? {};
  if (!d || d.state!=='active' || b.revision!==d.revision) { res.status(409).json({error:'an active current direction revision is required'}); return; }
  if (await one(`SELECT 1 FROM jobs WHERE agent_direction_id=$1 AND status IN ('queued','assigned')`,[d.id])) { res.status(409).json({error:'finish or release the current step before proposing another'}); return; }
  const type=b.type ?? 'explore';
  if(!['explore','source','break','measure','formalize','direction'].includes(type)) { res.status(400).json({error:'proposed steps must be research; link an existing review or verification job for those obligations'}); return; }
  const title=String(b.title ?? '').trim(),question=String(b.question ?? '').trim(),why=String(b.why ?? '').trim(),stop=String(b.stop_when ?? '').trim(),hours=Number(b.budget_hours);
  if(!title || title.length>200 || !question || question.length>6000 || !why || why.length>2000 || !stop || stop.length>2000 || !Number.isFinite(hours) || hours<.25 || hours>Number(s.ai.max_hours_per_assignment)) { res.status(400).json({error:'provide title, question, why this serves the direction, stop_when, and a budget_hours within your assignment cap'}); return; }
  let match; try { match=matchingMetadata({...b,type}); } catch(e:any) { res.status(400).json({error:e.message}); return; }
  const text=`${question}\n\nWhy this step: ${why}\n\nStop when: ${stop}`;
  // The declaration establishes relevance; the ordinary scheduler still checks capabilities and limits.
  const j=await one(`INSERT INTO jobs(problem_id,type,title,brief_md,git_ref,budget_hours,min_tier,agent_direction_id,agent_direction_revision,required_tools,required_sources)
    VALUES($1,$9,$2,$3,'main',$4,99,$5,$6,$7,$8) RETURNING id`,[req.project.id,title,text,hours,d.id,d.revision,match.required_tools,match.required_sources,type]);
  res.json({job_id:j!.id,direction_id:d.id,revision:d.revision});
}));
departments.post('/run/link-step',assignmentMutation(async(req,res) => {
  const s=await ownRun(req,res); if(!s) return;
  const d=await directionFor(s),b=req.body ?? {};
  if(!d || d.state!=='active' || b.revision!==d.revision) { res.status(409).json({error:'current active direction required'}); return; }
  const reason=String(b.why ?? '').trim();
  if(!reason || reason.length>2000 || !await one(`SELECT 1 FROM jobs WHERE id=$1 AND problem_id=$2 AND agent_direction_id IS NULL AND status='queued'`,[b.job_id,req.project.id])) { res.status(400).json({error:'name an available public job and why it serves this direction'}); return; }
  await q(`INSERT INTO agent_direction_links(direction_id,revision,job_id,reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[d.id,d.revision,b.job_id,reason]);
  res.json({ok:true,job_id:b.job_id,eligibility:'The normal capability, trust, independence and resource checks still apply at assignment.'});
}));
// Request recovery; /start performs the ordinary scheduling checks and issues a
// fresh attempt. A saved checkpoint can never authenticate the old attempt.
departments.post('/run/recover',assignmentMutation(async(req,res) => {
  const s=await ownRun(req,res); if(!s) return;
  if(await one(`SELECT 1 FROM jobs WHERE assigned_session=$1 AND status='assigned'`,[s.id])) { res.status(409).json({error:'release or complete your current assignment before recovering another'}); return; }
  const a=await one(`SELECT a.*,j.status AS job_status FROM assignment_attempts a JOIN jobs j ON j.id=a.job_id WHERE a.id=$1 AND a.problem_id=$2 AND a.user_id=$3 AND a.department_id=$4`,[req.body?.attempt_id,req.project.id,req.user.id,s.department_id]);
  if(!a || !['released','cancelled'].includes(a.status) || !['queued','expired'].includes(a.job_status) || await one(`SELECT 1 FROM assignment_recoveries WHERE old_attempt_id=$1`,[a.id])) { res.status(409).json({error:'that attempt is not available for recovery in this department'}); return; }
  if(s.direction_id && await one(`SELECT 1 FROM jobs WHERE agent_direction_id=$1 AND status='queued' AND id<>$2`,[s.direction_id,a.job_id])) { res.status(409).json({error:'complete your already proposed step before recovering a different one'}); return; }
  if(a.direction_snapshot) {
    const d=await one(`SELECT id,continued_from,revision,state FROM agent_directions WHERE id=$1`,[s.direction_id]);
    if(!d || d.state!=='active' || ![d.id,d.continued_from].includes(a.direction_snapshot.id)) { res.status(409).json({error:'explicitly continue the original direction before recovering its work'}); return; }
  }
  await q(`UPDATE sessions SET recovery_attempt_id=$2 WHERE id=$1`,[s.id,a.id]);
  res.json({ok:true,next:'/start',note:'A fresh attempt is issued only if the job remains available and fits your current consent, capabilities and direction.'});
}));
departments.get('/department/inbox',assignmentMutation(async(req,res) => {
  const s=await ownRun(req,res); if(!s) return;
  const candidates=await q(`SELECT a.*,u.handle AS from_handle FROM asks a JOIN users u ON u.id=a.from_user_id WHERE a.problem_id=$1 AND a.status='open'
    AND (a.to_user_id IS NULL OR a.to_user_id=$2) AND (a.to_department IS NULL OR a.to_department=$3)
    AND (a.routing IS NOT NULL OR a.to_contact IS NOT NULL) ORDER BY a.id LIMIT 200`,[req.project.id,req.user.id,s.department_id]);
  const questions=[];
  for(const a of candidates) if(await canClaimAsk(a,s)) {
    const {from_session,claimed_session,...pub}=a;
    questions.push({...pub,claimable:!claimed_session || claimed_session===s.id || !a.claim_until || new Date(a.claim_until).getTime()<=Date.now() || !await one(`SELECT 1 FROM sessions s WHERE s.id=$1 AND ${LIVE_RUN}`,[claimed_session])});
  }
  const deliveries=await q(`SELECT d.id,m.id AS message_id,m.department_id,m.run_id,u.handle,m.model,m.body_md,m.reply_to,m.job_id,m.return_id FROM department_deliveries d
    JOIN messages m ON m.id=d.message_id JOIN users u ON u.id=m.user_id WHERE d.department_id=$1 AND d.problem_id=$2 AND d.acknowledged_at IS NULL ORDER BY d.created_at,d.id LIMIT 100`,[s.department_id,req.project.id]);
  const human_questions=candidates.filter(a=>a.to_human && Number(a.to_user_id)===req.user.id).map(({from_session,claimed_session,...a})=>a);
  res.json({questions,human_questions,deliveries});
}));
departments.post('/department/inbox/ack',assignmentMutation(async(req,res) => {
  const s=await ownRun(req,res); if(!s) return;
  const ids=req.body?.delivery_ids;
  if(!Array.isArray(ids) || ids.length>100 || ids.some(x=>typeof x!=='string')) { res.status(400).json({error:'delivery_ids must be up to 100 persisted event IDs'}); return; }
  await q(`UPDATE department_deliveries SET acknowledged_at=coalesce(acknowledged_at,now()) WHERE department_id=$1 AND problem_id=$2 AND id=ANY($3::text[])`,[s.department_id,req.project.id,ids]);
  res.json({ok:true});
}));
departments.post('/asks/:id/claim',assignmentMutation(async(req,res) => {
  const s=await ownRun(req,res); if(!s) return;
  const a=await one(`SELECT * FROM asks WHERE id=$1 AND problem_id=$2 FOR UPDATE`,[req.params.id,req.project.id]);
  if(!a || !await canClaimAsk(a,s)) { res.status(403).json({error:'this run cannot claim the question'}); return; }
  const current=a.claimed_session && a.claim_until && new Date(a.claim_until).getTime()>Date.now()
    && await one(`SELECT 1 FROM sessions s WHERE s.id=$1 AND ${LIVE_RUN}`,[a.claimed_session]);
  if(current && a.claimed_session!==s.id) { res.status(409).json({error:'another run is answering this question'}); return; }
  const claim=await one(`UPDATE asks SET claimed_session=$2,claim_generation=claim_generation+$3,claim_until=now()+interval '10 minutes',
    to_department=coalesce(to_department,$4) WHERE id=$1 RETURNING claim_generation,claim_until`,[a.id,s.id,current?0:1,s.department_id]);
  res.json({ask_id:a.id,...claim});
}));
