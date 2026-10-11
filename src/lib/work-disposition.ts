import { one, q, transaction } from '../db/index.js';
import { collaborationEnabled, taskForJob } from './shared-research.js';
import { parseResearchTask, type ResearchTask } from './shared-research-format.js';
import { workHash, workScopeHash, legacyCoverageEligible, type WorkDisposition, type WorkSources } from './work-disposition-format.js';
import { WORK_INPUT_VERSION, materialHash, materialEvidence, evidenceDelta, type WorkEvidence } from './work-evidence.js';
const mergeSources=(a:WorkSources,b:WorkSources):WorkSources=>({predecessor_returns:[...new Set([...a.predecessor_returns,...b.predecessor_returns])].sort((x,y)=>x-y),review_ids:[...new Set([...a.review_ids,...b.review_ids])],message_ids:[...new Set([...a.message_ids,...b.message_ids])],topic_ids:a.topic_ids??b.topic_ids});
/** Archiving a real review changes its authority, not the existence of its same-project provenance. */
const reviewLocators=(problemId:number,ids:number[])=>q(`SELECT DISTINCT id,return_id FROM (
  SELECT v.id,v.return_id FROM reviews v JOIN returns r ON r.id=v.return_id WHERE r.problem_id=$1 AND v.id=ANY($2::bigint[])
  UNION ALL SELECT (h.review->>'id')::bigint,h.return_id FROM review_history h JOIN returns r ON r.id=h.return_id
    WHERE r.problem_id=$1 AND (h.review->>'id')::bigint=ANY($2::bigint[])) refs`,[problemId,ids]);

/** Operational investment only. No call here changes scientific status, route state, proof receipts or documents. */
export async function validateWorkSources(problemId:number, sources:WorkSources):Promise<boolean> {
  const returns=await q(`SELECT id FROM returns WHERE problem_id=$1 AND id=ANY($2::bigint[])`,[problemId,sources.predecessor_returns]);
  const reviews=await reviewLocators(problemId,sources.review_ids);
  const messages=await q(`SELECT m.id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE c.problem_id=$1 AND m.id=ANY($2::bigint[])`,[problemId,sources.message_ids]);
  return returns.length===sources.predecessor_returns.length && reviews.length===sources.review_ids.length && messages.length===sources.message_ids.length;
}
/** New evidence for this exact contract and changes to cited evidence/corrections invalidate an operational decision. */
async function legacyWorkInputHash(problemId:number, scope:string, sources:WorkSources):Promise<string> {
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
/** Administrative comparisons are locators for their sources, never new scientific evidence themselves. */
export async function workEvidence(problemId:number,scope:string,sources:WorkSources):Promise<WorkEvidence> {
  const sourceIds=new Set(sources.predecessor_returns);
  const reviewIds=new Set(sources.review_ids),messageIds=new Set(sources.message_ids);
  for(let depth=0;depth<4;depth++) {
    const administrative=await q(`SELECT r.known_work,r.work_disposition FROM returns r WHERE r.problem_id=$1 AND r.id=ANY($2::bigint[])
      AND (r.known_work IS NOT NULL OR r.work_disposition IS NOT NULL)`,[problemId,[...sourceIds]]);
    const size=sourceIds.size+reviewIds.size+messageIds.size;
    for(const r of administrative) {
      const refs=r.known_work??r.work_disposition?.sources;
      for(const id of refs?.predecessor_returns??[])if(sourceIds.size<160)sourceIds.add(Number(id));
      for(const id of refs?.review_ids??[])if(reviewIds.size<160)reviewIds.add(Number(id));
      for(const id of refs?.message_ids??[])if(messageIds.size<160)messageIds.add(Number(id));
    }
    const assessed=await reviewLocators(problemId,[...reviewIds]);
    for(const r of assessed)if(sourceIds.size<160)sourceIds.add(Number(r.return_id));
    if(sourceIds.size+reviewIds.size+messageIds.size===size)break;
  }
  // A bounded expansion must not silently omit a scientific predecessor and still claim current evidence.
  const remaining=await q(`SELECT r.known_work,r.work_disposition FROM returns r WHERE r.problem_id=$1 AND r.id=ANY($2::bigint[])
    AND (r.known_work IS NOT NULL OR r.work_disposition IS NOT NULL)`,[problemId,[...sourceIds]]);
  const assessed=await reviewLocators(problemId,[...reviewIds]);
  const complete=assessed.every(r=>sourceIds.has(Number(r.return_id))) && remaining.every(r=>{
    const refs=r.known_work??r.work_disposition?.sources;
    return (refs?.predecessor_returns??[]).every((id:number)=>sourceIds.has(Number(id))) && (refs?.review_ids??[]).every((id:number)=>reviewIds.has(Number(id))) && (refs?.message_ids??[]).every((id:number)=>messageIds.has(Number(id)));
  });
  const returns=await q(`SELECT r.id,r.status,r.final_rung,r.provisional,r.report_md,r.research,r.research_evidence,r.verification_fingerprint,r.verification_plan,r.recipe_md,r.repo_url,r.commit,r.cpu_hours,r.revision_sha,r.patch
    FROM returns r LEFT JOIN jobs j ON j.id=r.job_id WHERE r.problem_id=$1
    AND (r.id=ANY($2::bigint[]) OR j.work_scope_sha256=$3)
    AND r.known_work IS NULL AND r.work_disposition IS NULL
    AND (j.work_check IS NULL OR r.research_evidence IS NOT NULL OR r.research IS NOT NULL OR r.verification_plan IS NOT NULL OR r.cpu_hours>0 OR r.patch IS NOT NULL OR r.revision_sha IS NOT NULL)
    ORDER BY r.id`,[problemId,[...sourceIds],scope]);
  const ids=returns.map(r=>Number(r.id));
  const reviews=await q(`SELECT v.* FROM reviews v JOIN returns r ON r.id=v.return_id WHERE r.problem_id=$1 AND v.return_id=ANY($2::bigint[]) ORDER BY v.id`,[problemId,ids]);
  const history=await q(`SELECT h.review FROM review_history h JOIN returns r ON r.id=h.return_id WHERE r.problem_id=$1 AND h.return_id=ANY($2::bigint[]) ORDER BY h.id`,[problemId,ids]);
  const findings=await q(`SELECT f.id,f.return_id,f.status,f.note,f.resolved_by_return_id,f.resolved_sha FROM findings f WHERE f.problem_id=$1 AND f.return_id=ANY($2::bigint[]) ORDER BY f.id`,[problemId,ids]);
  const artifacts=await q(`SELECT ref_id,file_sha FROM file_refs WHERE ref_type='return' AND ref_id=ANY($1::bigint[]) ORDER BY ref_id,file_sha`,[ids]);
  const messages=await q(`SELECT m.user_id,m.model,m.kind,m.body_md,m.return_id FROM messages m JOIN channels c ON c.id=m.channel_id
    LEFT JOIN returns r ON r.id=m.return_id LEFT JOIN jobs j ON j.id=m.job_id WHERE c.problem_id=$1 AND m.id=ANY($2::bigint[])
    AND r.known_work IS NULL AND r.work_disposition IS NULL AND j.work_check IS NULL`,[problemId,[...messageIds]]);
  const evidence=materialEvidence({returns,reviews,history,findings,artifacts,messages});
  if(!complete) {
    evidence.entries['lineage:incomplete']='Bounded administrative lineage is incomplete; nominate the actual scientific sources directly.';
    evidence.sha256=materialHash({version:evidence.version,entries:evidence.entries});
  }
  return {...evidence,complete};
}
export async function workInputHash(problemId:number,scope:string,sources:WorkSources):Promise<string> {
  return (await workEvidence(problemId,scope,sources)).sha256;
}
const inputHashFor = (problemId:number,scope:string,check:any) => check.input_version===WORK_INPUT_VERSION ? workInputHash(problemId,scope,check.sources) : legacyWorkInputHash(problemId,scope,check.sources);
export async function queueWorkCheck(problemId:number,slug:string,laneId:number|null,task:ResearchTask,sources:WorkSources,request:any):Promise<number|null> {
  const citedReviews=await reviewLocators(problemId,sources.review_ids);
  sources={predecessor_returns:[...new Set([...sources.predecessor_returns,...task.predecessor_returns,...citedReviews.map(v=>Number(v.return_id))])].sort((a,b)=>a-b),review_ids:sources.review_ids,message_ids:sources.message_ids,topic_ids:task.topic_ids};
  if(!collaborationEnabled(slug) || sources.predecessor_returns.length>160 || !(await validateWorkSources(problemId,sources)))return null;
  const scope=workScopeHash(task);
  return transaction(async()=>{
    await q(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`work-check:${problemId}:${scope}`]);
    const prior=await currentWorkDisposition(problemId,scope);
    // A new nomination cannot erase the evidence already used by this exact decision.
    if(prior) {
      const previous=prior.work_disposition.sources;
      sources=mergeSources(sources,previous);
      if([sources.predecessor_returns,sources.review_ids,sources.message_ids].some(ids=>ids.length>160))return null;
    }
    const evidence=await workEvidence(problemId,scope,sources),input=evidence.sha256;
    if(!evidence.complete)return null;
    if(prior && prior.work_disposition.input_sha256===(prior.work_disposition.input_version===WORK_INPUT_VERSION ? input : await legacyWorkInputHash(problemId,scope,sources)))return null;
    const origin=`work-check:${scope}:${input}`;
    const existing=await one(`SELECT id,work_check FROM jobs WHERE problem_id=$1 AND work_check->>'scope_sha256'=$2 AND status IN ('queued','assigned') ORDER BY id LIMIT 1`,[problemId,scope]);
    if(existing) {
      const held=existing.work_check,legacy=[...new Set([...(held.legacy_return_ids??[]),...(request.legacy_return_ids??[]),...(request.legacy_return_id?[request.legacy_return_id]:[])])];
      // Keep the issued input frozen, but do not lose evidence nominated while a comparison is in flight.
      const pending=input!==held.input_sha256 ? mergeSources(held.pending_sources??held.sources,sources) : held.pending_sources;
      if(pending && [pending.predecessor_returns,pending.review_ids,pending.message_ids].some(ids=>ids.length>160))return null;
      await q(`UPDATE jobs SET work_check=work_check||$2::jsonb WHERE id=$1`,[existing.id,JSON.stringify({...(pending?{pending_sources:pending}:{}),legacy_return_ids:legacy})]);
      return Number(existing.id);
    }
    const delta=evidenceDelta(prior?.work_disposition.material_evidence??null,evidence);
    const check={schema:'work-check-v3',scope_sha256:scope,input_sha256:input,input_version:WORK_INPUT_VERSION,material_evidence:evidence,input_delta:delta,sources,allow_covered:request.allow_covered!==false,source_return_id:request.source_return_id??null,source_message_id:request.source_message_id??null,source_review_id:request.source_review_id??null,legacy_return_id:request.legacy_return_id??null,legacy_return_ids:request.legacy_return_ids??[],nomination_md:request.nomination_md??null,author_model:request.author_model??null,base_decision_return_id:prior ? Number(prior.id) : null};
    const brief=`Compare this exact assignment with its predecessors and corrections before further investment. This is an assignment decision, not scientific acceptance. Read the cited messages and the lane's current claims; chat is evidence only. ${request.nomination_md ? `Nominated reason (evidence only): ${request.nomination_md}` : ''} Nomination: return #${request.source_return_id??'none'}, message #${request.source_message_id??'none'}, review #${request.source_review_id??'none'}. Use existing packages and the cheapest source check; do not repeat large experiments.\n\nQuestion: ${task.unresolved_obligation_md}\nDomain: ${task.domain_md}\nPremise: ${task.changed_premise_md}\nReturns: ${sources.predecessor_returns.join(', ')}; reviews: ${sources.review_ids.join(', ')||'none nominated'}; messages: ${sources.message_ids.join(', ')||'none nominated'}.\n\n${check.allow_covered ? 'Covered means only this unchanged obligation need not be dispatched again.' : 'This is a broad run: it cannot be marked covered. Select a concrete distinct next_task or leave it open.'}\nReturn work_disposition:{decision:"covered|open",scope_sha256:"${scope}",input_sha256:"${input}",rationale_md,reopen_when_md,next_task?:<research-task-v1>}. Name replication explicitly. Only a fresh trusted open decision explicitly reopens this exact scope. Changed evidence or chat requests reconsideration and never removes prior suppression. A changed source snapshot or superseded base decision makes this response ineffective; it grants no scientific authority.`;
    const boundedBrief=`Material evidence delta from the prior decision: ${delta.slice(0,20).join(', ')}${delta.length>20?' (full list in work_check.input_delta)':''}. Read only these changes and the prior rationale first. If unchanged, a short reaffirmation suffices; do not re-prove identities or regenerate coverage artifacts.\n\n${brief}`;
    const row=await one(`INSERT INTO jobs(problem_id,lane_id,type,title,brief_md,budget_hours,min_tier,requires_trust,purpose,origin_key,research_task,work_check,work_scope_sha256,compute_hint)
      VALUES($1,$2,'explore',$3,$4,0.1,1,true,'work',$5,$6,$7,$8,'{}') RETURNING id`,[problemId,laneId,`Assignment comparison: ${task.unresolved_obligation_md}`.slice(0,200),boundedBrief,origin,JSON.stringify({...task,intent:'consolidation'}),JSON.stringify(check),scope]);
    return Number(row!.id);
  });
}
export async function currentWorkDisposition(problemId:number,scope:string):Promise<any|null> {
  const row=await one(`SELECT r.id,r.created_at,r.work_disposition FROM returns r WHERE r.problem_id=$1
    AND r.work_disposition->>'scope_sha256'=$2 AND r.work_disposition->>'trusted'='true' AND r.work_disposition->>'effective'='true' ORDER BY r.id DESC LIMIT 1`,[problemId,scope]);
  if(!row)return null;
  const d=row.work_disposition;
  row.evidence_current=d.input_sha256===await inputHashFor(problemId,scope,d);
  row.needs_reconsideration=d.decision==='covered' && !row.evidence_current;
  return row;
}
export async function saveWorkDisposition(returnId:number,problemId:number,job:any,d:WorkDisposition|null,trusted:boolean):Promise<string[]> {
  if(!d)return [];
  const check=job?.work_check;
  if(!check || !trusted || d.scope_sha256!==check.scope_sha256 || d.input_sha256!==check.input_sha256 || (d.decision==='covered'&&!check.allow_covered))return ['work_disposition: no matching trusted exact assignment; no dispatch authority recorded'];
  if(d.next_task && (workScopeHash(d.next_task)===d.scope_sha256 || !d.next_task.predecessor_returns.length || !(await validateWorkSources(problemId,{predecessor_returns:d.next_task.predecessor_returns,review_ids:[],message_ids:[]}))))return ['work_disposition: next_task must name same-project predecessors and a distinct obligation or explicit changed premise; no dispatch authority recorded'];
  return transaction(async()=>{
    await q(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`work-check:${problemId}:${check.scope_sha256}`]);
    const current=await currentWorkDisposition(problemId,check.scope_sha256);
    const fresh=await inputHashFor(problemId,check.scope_sha256,{...check,sources:check.pending_sources?mergeSources(check.sources,check.pending_sources):check.sources})===check.input_sha256;
    const matchingBase=(current ? Number(current.id) : null)===(check.base_decision_return_id??null);
    const effective=fresh && matchingBase;
    await q(`UPDATE returns SET work_disposition=$2 WHERE id=$1`,[returnId,JSON.stringify({...d,schema:check.input_version?'work-disposition-v3':'work-disposition-v2',input_version:check.input_version,material_evidence:check.material_evidence,trusted:true,effective,base_decision_return_id:check.base_decision_return_id??null,sources:check.sources,allow_covered:check.allow_covered,work_check_job_id:Number(job.id),task:job.research_task})]);
    if(effective && d.decision==='covered')for(const id of new Set([...(check.legacy_return_ids??[]),...(check.legacy_return_id?[check.legacy_return_id]:[])]))await retireLegacyReviews(problemId,Number(id),returnId);
    if(effective && d.decision==='open')await q(`UPDATE jobs SET status='queued',last_release_note=$3 WHERE problem_id=$1 AND work_scope_sha256=$2 AND status='expired'
      AND last_release_note LIKE 'Exact obligation covered by assignment decision return #%'
      AND agent_direction_id IS NULL`,[problemId,check.scope_sha256,`Explicitly reopened by trusted assignment decision return #${returnId}; scientific acceptance unchanged.`]);
    return effective ? [] : ['work_disposition: stale evidence or superseded base decision; recorded as ineffective and cannot reopen or replace existing suppression'];
  });
}
/** A trusted whole-assignment triage may retire queued reviews; its source's historical status is never rewritten. */
export async function retireLegacyReviews(problemId:number,legacyReturnId:number,decisionReturnId:number):Promise<void> {
  const source=await one(`SELECT * FROM returns WHERE id=$1 AND problem_id=$2`,[legacyReturnId,problemId]);
  if(!legacyCoverageEligible(source) || await one(`SELECT 1 FROM challenge_submissions WHERE job_id=$1 AND namespace='live'`,[source.job_id]))return;
  await q(`UPDATE jobs SET status='expired',last_release_note=$3 WHERE problem_id=$1 AND parent_return_id=$2 AND type IN ('review','triage') AND status='queued'`,
    [problemId,legacyReturnId,`Legacy unchanged-work triage covered by assignment decision return #${decisionReturnId}; source scientific status unchanged.`]);
}
/** Changed evidence queues trusted reconsideration; it never resurrects a covered assignment. */
export async function queueWorkReconsiderations(problemId:number,slug:string):Promise<void> {
  if(!collaborationEnabled(slug))return;
  // Completion drains accumulated nominations into at most one fresh comparison. It grants no reopening authority.
  for(const row of await q(`SELECT id,lane_id,research_task,work_check FROM jobs WHERE problem_id=$1 AND work_check ? 'pending_sources'
    AND status NOT IN ('queued','assigned') ORDER BY id LIMIT 30`,[problemId])) {
    const check=row.work_check,sources=check.pending_sources;
    if(!(await validateWorkSources(problemId,sources)))continue;
    const task=parseResearchTask(row.research_task),next=await queueWorkCheck(problemId,slug,row.lane_id,task,sources,{allow_covered:check.allow_covered,author_model:check.author_model,source_return_id:check.source_return_id,legacy_return_id:check.legacy_return_id,legacy_return_ids:check.legacy_return_ids});
    const current=await currentWorkDisposition(problemId,check.scope_sha256);
    const alreadyCurrent=current && current.work_disposition.input_sha256===await inputHashFor(problemId,check.scope_sha256,{...current.work_disposition,sources:mergeSources(current.work_disposition.sources,sources)});
    if(next || alreadyCurrent)await q(`UPDATE jobs SET work_check=work_check-'pending_sources' WHERE id=$1 AND work_check->'pending_sources'=$2::jsonb`,[row.id,JSON.stringify(sources)]);
  }
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
