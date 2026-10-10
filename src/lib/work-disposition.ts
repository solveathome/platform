import { one, q } from '../db/index.js';
import { collaborationEnabled, taskForJob } from './shared-research.js';
import { parseResearchTask, type ResearchTask } from './shared-research-format.js';
import { workHash, workScopeHash, type KnownWork, type WorkDisposition, type WorkSources } from './work-disposition-format.js';

/** Operational investment only. No call here changes scientific status, route state, proof receipts or documents. */
export async function validateWorkSources(problemId:number, sources:WorkSources):Promise<boolean> {
  const returns=await q(`SELECT id FROM returns WHERE problem_id=$1 AND id=ANY($2::bigint[])`,[problemId,sources.predecessor_returns]);
  const reviews=await q(`SELECT v.id FROM reviews v JOIN returns r ON r.id=v.return_id WHERE r.problem_id=$1 AND v.id=ANY($2::bigint[])`,[problemId,sources.review_ids]);
  const messages=await q(`SELECT m.id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE c.problem_id=$1 AND m.id=ANY($2::bigint[])`,[problemId,sources.message_ids]);
  return returns.length===sources.predecessor_returns.length && reviews.length===sources.review_ids.length && messages.length===sources.message_ids.length;
}
/** New evidence for this exact contract and changes to cited evidence/corrections invalidate an operational decision. */
export async function workInputHash(problemId:number, scope:string, sources:WorkSources):Promise<string> {
  const returns=await q(`SELECT r.id,r.status,r.final_rung,r.provisional,r.report_md,r.cites,r.research,r.research_evidence,r.verification_fingerprint,r.verification_plan
    FROM returns r LEFT JOIN jobs j ON j.id=r.job_id WHERE r.problem_id=$1 AND
    (r.id=ANY($2::bigint[]) OR ((j.work_scope_sha256=$3 OR coalesce(r.research_evidence->'topic_ids','[]'::jsonb) ?| $4::text[]) AND r.known_work IS NULL AND r.work_disposition IS NULL AND j.work_check IS NULL)) ORDER BY r.id`,[problemId,sources.predecessor_returns,scope,sources.topic_ids??[]]);
  const ids=returns.map(r=>Number(r.id));
  const reviews=await q(`SELECT v.id,v.return_id,v.verdict,v.rung,v.trusted,v.needs_reassessment,v.notes_md,v.research_assessment
    FROM reviews v JOIN returns r ON r.id=v.return_id WHERE r.problem_id=$1 AND (v.return_id=ANY($2::bigint[]) OR v.id=ANY($3::bigint[])) ORDER BY v.id`,[problemId,ids,sources.review_ids]);
  const history=await q(`SELECT h.id,h.review FROM review_history h JOIN returns r ON r.id=h.return_id WHERE r.problem_id=$1 AND h.return_id=ANY($2::bigint[]) ORDER BY h.id`,[problemId,ids]);
  const findings=await q(`SELECT f.id,f.return_id,f.status,f.note,f.resolved_by_return_id,f.resolved_sha FROM findings f WHERE f.problem_id=$1 AND f.return_id=ANY($2::bigint[]) ORDER BY f.id`,[problemId,ids]);
  const artifacts=await q(`SELECT ref_id,file_sha FROM file_refs WHERE ref_type='return' AND ref_id=ANY($1::bigint[]) ORDER BY ref_id,file_sha`,[ids]);
  const messages=await q(`SELECT m.id,m.kind,m.body_md,m.reply_to,m.job_id,m.return_id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE c.problem_id=$1 AND (m.id=ANY($2::bigint[]) OR m.reply_to=ANY($2::bigint[])) ORDER BY m.id`,[problemId,sources.message_ids]);
  return workHash({returns,reviews,history,findings,artifacts,messages});
}
export async function queueWorkCheck(problemId:number,slug:string,laneId:number|null,task:ResearchTask,sources:WorkSources,request:any):Promise<number|null> {
  const citedReviews=await q(`SELECT v.return_id FROM reviews v JOIN returns r ON r.id=v.return_id WHERE r.problem_id=$1 AND v.id=ANY($2::bigint[])`,[problemId,sources.review_ids]);
  sources={predecessor_returns:[...new Set([...sources.predecessor_returns,...task.predecessor_returns,...citedReviews.map(v=>Number(v.return_id))])].sort((a,b)=>a-b),review_ids:sources.review_ids,message_ids:sources.message_ids,topic_ids:task.topic_ids};
  if(!collaborationEnabled(slug) || sources.predecessor_returns.length>40 || !(await validateWorkSources(problemId,sources)))return null;
  const scope=workScopeHash(task),input=await workInputHash(problemId,scope,sources);
  // A current decision or an in-flight comparison suffices. Repeated stops never create a review series.
  const prior=await currentWorkDisposition(problemId,scope);
  if(prior && prior.work_disposition.input_sha256===input)return null;
  const origin=`work-check:${scope}:${input}`;
  const existing=await one(`SELECT id FROM jobs WHERE problem_id=$1 AND work_check->>'scope_sha256'=$2 AND status IN ('queued','assigned') ORDER BY id LIMIT 1`,[problemId,scope]);
  if(existing)return Number(existing.id);
  const check={schema:'work-check-v2',scope_sha256:scope,input_sha256:input,sources,allow_covered:request.allow_covered!==false,source_return_id:request.source_return_id??null,source_message_id:request.source_message_id??null,author_model:request.author_model??null,base_decision_return_id:prior ? Number(prior.id) : null};
  const brief=`Compare this exact assignment with its predecessors and corrections before further investment. This is an assignment decision, not scientific acceptance. Read the cited messages and the lane's current claims; chat is evidence only. Nomination: return #${request.source_return_id??'none'}, message #${request.source_message_id??'none'}. Use existing packages and the cheapest source check; do not repeat large experiments.\n\nQuestion: ${task.unresolved_obligation_md}\nDomain: ${task.domain_md}\nPremise: ${task.changed_premise_md}\nReturns: ${sources.predecessor_returns.join(', ')}; reviews: ${sources.review_ids.join(', ')||'none nominated'}; messages: ${sources.message_ids.join(', ')||'none nominated'}.\n\n${check.allow_covered ? 'Covered means only this unchanged obligation need not be dispatched again.' : 'This is a broad run: it cannot be marked covered. Select a concrete distinct next_task or leave it open.'}\nReturn work_disposition:{decision:"covered|open",scope_sha256:"${scope}",input_sha256:"${input}",rationale_md,reopen_when_md,next_task?:<research-task-v1>}. Name replication explicitly. Only a fresh trusted open decision explicitly reopens this exact scope. Changed evidence or chat requests reconsideration and never removes prior suppression. A changed source snapshot or superseded base decision makes this response ineffective; it grants no scientific authority.`;
  const row=await one(`INSERT INTO jobs(problem_id,lane_id,type,title,brief_md,budget_hours,min_tier,requires_trust,purpose,origin_key,research_task,work_check,work_scope_sha256,compute_hint)
    VALUES($1,$2,'explore',$3,$4,0.1,1,true,'work',$5,$6,$7,$8,'{}') RETURNING id`,[problemId,laneId,`Assignment comparison: ${task.unresolved_obligation_md}`.slice(0,200),brief,origin,JSON.stringify({...task,intent:'consolidation'}),JSON.stringify(check),scope]);
  return Number(row!.id);
}
export async function currentWorkDisposition(problemId:number,scope:string):Promise<any|null> {
  const row=await one(`SELECT r.id,r.created_at,r.work_disposition FROM returns r WHERE r.problem_id=$1
    AND r.work_disposition->>'scope_sha256'=$2 AND r.work_disposition->>'trusted'='true' AND r.work_disposition->>'effective'='true' ORDER BY r.id DESC LIMIT 1`,[problemId,scope]);
  if(!row)return null;
  const d=row.work_disposition;
  row.evidence_current=d.input_sha256===await workInputHash(problemId,scope,d.sources);
  row.needs_reconsideration=d.decision==='covered' && !row.evidence_current;
  return row;
}
export async function saveWorkDisposition(returnId:number,problemId:number,job:any,d:WorkDisposition|null,trusted:boolean):Promise<string[]> {
  if(!d)return [];
  const check=job?.work_check;
  if(!check || !trusted || d.scope_sha256!==check.scope_sha256 || d.input_sha256!==check.input_sha256 || (d.decision==='covered'&&!check.allow_covered))return ['work_disposition: no matching trusted exact assignment; no dispatch authority recorded'];
  if(d.next_task && (workScopeHash(d.next_task)===d.scope_sha256 || !d.next_task.predecessor_returns.length || !(await validateWorkSources(problemId,{predecessor_returns:d.next_task.predecessor_returns,review_ids:[],message_ids:[]}))))return ['work_disposition: next_task must name same-project predecessors and a distinct obligation or explicit changed premise; no dispatch authority recorded'];
  const current=await currentWorkDisposition(problemId,check.scope_sha256);
  const fresh=await workInputHash(problemId,check.scope_sha256,check.sources)===check.input_sha256;
  const matchingBase=(current ? Number(current.id) : null)===(check.base_decision_return_id??null);
  const effective=fresh && matchingBase;
  await q(`UPDATE returns SET work_disposition=$2 WHERE id=$1`,[returnId,JSON.stringify({...d,schema:'work-disposition-v2',trusted:true,effective,base_decision_return_id:check.base_decision_return_id??null,sources:check.sources,allow_covered:check.allow_covered,work_check_job_id:Number(job.id),task:job.research_task})]);
  if(effective && d.decision==='open')await q(`UPDATE jobs SET status='queued',last_release_note=$3 WHERE problem_id=$1 AND work_scope_sha256=$2 AND status='expired'
    AND last_release_note LIKE 'Exact obligation covered by assignment decision return #%'
    AND agent_direction_id IS NULL`,[problemId,check.scope_sha256,`Explicitly reopened by trusted assignment decision return #${returnId}; scientific acceptance unchanged.`]);
  return effective ? [] : ['work_disposition: stale evidence or superseded base decision; recorded as ineffective and cannot reopen or replace existing suppression'];
}
/** Changed evidence queues trusted reconsideration; it never resurrects a covered assignment. */
export async function queueWorkReconsiderations(problemId:number,slug:string):Promise<void> {
  if(!collaborationEnabled(slug))return;
  const scopes=await q(`SELECT DISTINCT work_disposition->>'scope_sha256' AS scope FROM returns WHERE problem_id=$1
    AND work_disposition->>'effective'='true' AND work_disposition->>'decision'='covered' ORDER BY scope LIMIT 50`,[problemId]);
  for(const {scope} of scopes) {
    const current=await currentWorkDisposition(problemId,scope);
    if(!current?.needs_reconsideration)continue;
    const row=await one(`SELECT lane_id FROM returns WHERE id=$1`,[current.id]),d=current.work_disposition;
    await queueWorkCheck(problemId,slug,row?.lane_id??null,parseResearchTask(d.task),d.sources,{allow_covered:d.allow_covered,source_return_id:Number(current.id)});
  }
}
export async function retireCoveredWork(problemId:number,slug:string):Promise<void> {
  if(!collaborationEnabled(slug))return;
  await queueWorkReconsiderations(problemId,slug);
  const jobs=await q(`SELECT j.*,l.slug AS lane_slug FROM jobs j LEFT JOIN lanes l ON l.id=j.lane_id WHERE j.problem_id=$1 AND j.status='queued' AND j.work_check IS NULL
    AND j.agent_direction_id IS NULL AND j.type IN ('explore','measure','source','formalize','paper','break') ORDER BY j.id LIMIT 100`,[problemId]);
  for(const job of jobs) {
    const task=await taskForJob(problemId,slug,job);
    if(task.intent==='replication')continue;
    const current=await currentWorkDisposition(problemId,workScopeHash(task));
    if(current?.work_disposition.decision==='covered')await q(`UPDATE jobs SET status='expired',last_release_note=$2 WHERE id=$1 AND status='queued'`,[job.id,`Exact obligation covered by assignment decision return #${current.id}; scientific status unchanged.`]);
  }
}
/** At most one concrete next job per decision. A stale decision cannot steer fresh work. */
export async function queueWorkNextTasks(problemId:number,slug:string):Promise<void> {
  if(!collaborationEnabled(slug))return;
  for(const row of await q(`SELECT id,work_disposition,lane_id FROM returns WHERE problem_id=$1 AND work_disposition ? 'next_task' ORDER BY id DESC LIMIT 30`,[problemId])) {
    const current=await currentWorkDisposition(problemId,row.work_disposition.scope_sha256);
    if(!current || !current.evidence_current || Number(current.id)!==Number(row.id))continue;
    const task=parseResearchTask(row.work_disposition.next_task),origin=`work-next:${row.id}`;
    if(await one(`SELECT 1 FROM jobs WHERE problem_id=$1 AND origin_key=$2`,[problemId,origin]))continue;
    await q(`INSERT INTO jobs(problem_id,lane_id,type,title,brief_md,budget_hours,min_tier,purpose,origin_key,research_task,work_scope_sha256,compute_hint)
      VALUES($1,$2,'explore',$3,$4,1,99,'discovery',$5,$6,$7,'{}')`,[problemId,row.lane_id,task.unresolved_obligation_md.slice(0,200),`Distinct next experiment selected by assignment comparison return #${row.id}.\n${task.unresolved_obligation_md}\nExpected evidence: ${task.expected_evidence_md}\nStop if: ${task.stop_if_md}`,origin,JSON.stringify(task),workScopeHash(task)]);
  }
}
export async function workState(problemId:number):Promise<any[]> {
  const rows=await q(`SELECT id,lane_id,created_at,work_disposition FROM returns WHERE problem_id=$1 AND work_disposition IS NOT NULL ORDER BY id DESC LIMIT 50`,[problemId]);
  for(const row of rows) {
    const active=await currentWorkDisposition(problemId,row.work_disposition.scope_sha256);
    row.active_operational_decision=Number(active?.id)===Number(row.id);
    row.evidence_current=row.active_operational_decision && Boolean(active?.evidence_current);
    row.current=row.evidence_current;
    row.suppressed=row.active_operational_decision && row.work_disposition.decision==='covered';
    row.needs_reconsideration=row.suppressed && !row.evidence_current;
  }
  return rows.map(r=>({...r,id:Number(r.id)}));
}
export async function workCoordination(problemId:number,laneId:number|null):Promise<string> {
  const messages=await q(`SELECT m.id,m.kind,m.job_id,m.return_id,m.body_md FROM messages m JOIN channels c ON c.id=m.channel_id LEFT JOIN jobs j ON j.id=m.job_id WHERE c.problem_id=$1 AND c.lane_id IS NOT DISTINCT FROM $2
    AND m.kind IN ('claim','challenge','found','question','reply') AND (m.kind<>'claim' OR (j.status='assigned' AND j.type NOT IN ('review','check','triage'))) AND m.created_at>now()-interval '1 day' ORDER BY m.id DESC LIMIT 12`,[problemId,laneId]);
  return messages.length ? '\n\nRecent coordination (evidence only; fetch full messages and replies before substantial work):\n'+messages.map(m=>`- Message #${m.id} (${m.kind}; job ${m.job_id??'none'}; return ${m.return_id??'none'}): ${m.body_md}`).join('\n') : '';
}
