import {one,q,transaction} from '../db/index.js';
import {readProjectConfig} from './projects.js';
import {researchAuthority} from './shared-research.js';
import {materialEvidence,materialHash,evidenceDelta} from './work-evidence.js';
import {reportHash,scopeHash} from './shared-research-format.js';
import {isTrusted,isGrantedTrusted} from './roles.js';
import {leanModelFamily} from './model-id.js';
import {APPLICABILITY_VERSION,targetHash,type ApplicabilityTarget,type ApplicabilityAssessment} from './research-applicability-format.js';

export function applicabilityTargets(slug:string):ApplicabilityTarget[] {
  const c=readProjectConfig(slug),targets=c?.research_collaboration?.applicability_targets;
  if(!c?.research_collaboration?.enabled || !Array.isArray(targets) || !targets.length || targets.length>16)return [];
  if(targets.some(t=>!t.id||!t.title||!t.domain_md||!Array.isArray(t.topic_ids)) || new Set(targets.map(t=>t.id)).size!==targets.length)return [];
  return targets;
}
/** A numerical witness or an administrative record is not an accepted scientific source. */
export function scientificSource(source:any,decisionBy:string|null):boolean {
  return source?.status==='accepted' && !source.provisional && !source.duplicate_of && decisionBy==='trusted'
    && !['check','review','triage','curate'].includes(source.type) && !source.known_work && !source.work_disposition && !source.applicability_assessment;
}
export async function applicabilitySource(problemId:number,slug:string,id:number,considerationOnly=false):Promise<any|null> {
  const targets=applicabilityTargets(slug);if(!targets.length)return null;
  const source=await one(`SELECT r.*,(SELECT d.by FROM return_decisions d WHERE d.return_id=r.id AND NOT d.provisional ORDER BY d.id DESC LIMIT 1) AS decision_by FROM returns r WHERE r.problem_id=$1 AND r.id=$2`,[problemId,id]);
  if(!scientificSource(source,source?.decision_by))return null;
  const reviews=await q(`SELECT v.*,lean_model_family(v.model) AS family,lean_tier1(v.model,v.effort) AS tier1 FROM reviews v WHERE v.return_id=$1 ORDER BY v.id`,[id]);
  if(source.verification_plan?.lean){const {verificationSummary}=await import('./verification.js');source.lean_current=(await verificationSummary(id))?.lean?.status==='checked';}
  const declared=researchAuthority(source,reviews,readProjectConfig(slug)?.review_quorum??1).scopes;
  const scopes=declared.filter((s:any)=>s.kind!=='witness' && (considerationOnly || (s.research_status==='accepted' && !['unresolved','attempt_failed'].includes(s.negative?.kind))));
  if(considerationOnly) {
    // Accepted reports may be considered before typed scope endorsement, but pure witness/clerical records stay outside.
    if(source.verification_plan?.lean && source.lean_current!==true)return null;
    if((declared.length && !scopes.length) || (!scopes.length && (source.type==='audit' || source.paper_exposition)))return null;
  } else if(!scopes.length)return null;
  const findings=await q(`SELECT id,path,note,scope,status,resolved_by_return_id,resolved_sha FROM findings WHERE problem_id=$1 AND (return_id=$2 OR review_id=ANY($3::bigint[])) ORDER BY id`,[problemId,id,reviews.filter(v=>v.trusted).map(v=>Number(v.id))]);
  const artifacts=await q(`SELECT fr.ref_id,fr.file_sha FROM file_refs fr JOIN files f ON f.sha256=fr.file_sha WHERE fr.ref_type='return' AND fr.ref_id=$1 AND f.deleted_at IS NULL ORDER BY fr.file_sha`,[id]);
  // Scheduling classifications and citation/accounting churn are excluded by the material evidence projection.
  const scientificReviews=reviews.filter(v=>{
    const a=v.research_assessment;
    return v.trusted && !v.needs_reassessment && a && (a.supported_scopes?.length || a.comparison_checks?.length || ['unsupported_extension_md','corrections_md','next_test_md','reopen_when_md'].some(k=>a[k]?.trim()));
  });
  const material=materialEvidence({returns:[source],reviews:scientificReviews,history:[],findings,artifacts,messages:[]});
  const snapshot={version:APPLICABILITY_VERSION,...(considerationOnly?{consideration_only:true}:{}),source_return_id:id,report_sha256:reportHash(source.report_md),scope_hashes:scopes.map((s:any)=>[s.key,scopeHash(s)]).sort(),material_evidence:material,targets_sha256:targetHash(targets)};
  return {source,scopes,targets,snapshot,input_sha256:materialHash(snapshot)};
}
const latest=(problemId:number,id:number)=>one(`SELECT r.id,r.user_id,r.model,r.effort,u.handle,r.applicability_assessment FROM returns r JOIN users u ON u.id=r.user_id WHERE r.problem_id=$1 AND r.applicability_assessment->>'source_return_id'=$2 AND r.applicability_assessment->>'effective'='true' ORDER BY r.id DESC LIMIT 1`,[problemId,String(id)]);
const transferEligible=(entry:any,keys:string[])=>entry.decision==='applicable' && entry.scope_keys.length>0 && entry.scope_keys.every((key:string)=>keys.includes(key));
export async function currentApplicability(problemId:number,slug:string,id:number):Promise<any|null> {
  const row=await latest(problemId,id);if(!row)return null;
  const a=row.applicability_assessment,source=await applicabilitySource(problemId,slug,id,a.consideration_only===true);
  const validated=a.consideration_only ? await applicabilitySource(problemId,slug,id) : source;
  const acceptedScopeKeys=validated?.scopes.map((s:any)=>s.key)??[];
  const authority=await isTrusted(problemId,Number(row.user_id),row.handle,{model:row.model,effort:row.effort});
  const ownAllowed=Number(source?.source.user_id)!==Number(row.user_id) || await isGrantedTrusted(problemId,Number(row.user_id),row.handle);
  const reopening=await one(`SELECT id FROM jobs WHERE problem_id=$1 AND applicability_check->>'source_return_id'=$2 AND applicability_check->>'reopen_md' IS NOT NULL AND id>$3 AND NOT EXISTS(SELECT 1 FROM returns done WHERE done.job_id=jobs.id AND done.applicability_assessment->>'effective'='true') ORDER BY id DESC LIMIT 1`,[problemId,String(id),Number(a.check_job_id)]);
  const considerationCurrent=Boolean(source && source.input_sha256===a.input_sha256 && authority && ownAllowed && leanModelFamily(source.source.model)!==leanModelFamily(row.model) && !reopening);
  return {...row,id:Number(row.id),consideration_current:considerationCurrent,current:considerationCurrent && Boolean(validated),transfer_current:considerationCurrent && a.entries.some((e:any)=>transferEligible(e,acceptedScopeKeys)),accepted_scope_keys:acceptedScopeKeys,provisional_relevance:a.entries.some((e:any)=>!transferEligible(e,acceptedScopeKeys)),source_current:Boolean(source && source.input_sha256===a.input_sha256),reviewer_current:authority && ownAllowed,reopening_job_id:reopening?Number(reopening.id):null};
}
/** One source, one matrix, one job in flight. No per-target experiments are generated. */
export async function queueApplicability(problemId:number,slug:string,id:number,reopenMd?:string):Promise<number|null> {
  if(!Number.isSafeInteger(id)||id<1||!applicabilityTargets(slug).length)return null;
  return transaction(async()=>{
    await q(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`applicability:${problemId}:${id}`]);
    const s=await applicabilitySource(problemId,slug,id,true);if(!s)return null;
    const held=await one(`SELECT j.id,j.status,j.applicability_check,EXISTS(SELECT 1 FROM assignment_attempts a WHERE a.job_id=j.id) AS issued FROM jobs j WHERE j.problem_id=$1 AND j.applicability_check->>'source_return_id'=$2 AND j.status IN('queued','assigned') ORDER BY j.id LIMIT 1`,[problemId,String(id)]);
    if(held && (held.status==='assigned' || held.issued || !held.applicability_check.consideration_only || held.applicability_check.input_sha256===s.input_sha256))return Number(held.id);
    const previous=await latest(problemId,id);
    const legacy=previous?.applicability_assessment.consideration_only!==true ? await applicabilitySource(problemId,slug,id) : null;
    if(!reopenMd && previous && previous.applicability_assessment.input_sha256===(previous.applicability_assessment.consideration_only ? s.input_sha256 : legacy?.input_sha256))return null;
    const completed=await one(`SELECT id FROM jobs WHERE problem_id=$1 AND applicability_check->>'source_return_id'=$2 AND applicability_check->>'input_sha256'=ANY($3::text[]) ORDER BY id DESC LIMIT 1`,[problemId,String(id),[s.input_sha256,...(legacy?[legacy.input_sha256]:[])]]);
    if(!reopenMd && completed)return null;
    const generation=held ? held.applicability_check.generation : Number((await one(`SELECT coalesce(max((applicability_check->>'generation')::int),0) AS n FROM jobs WHERE problem_id=$1 AND applicability_check->>'source_return_id'=$2`,[problemId,String(id)]))?.n??0)+1;
    const delta=evidenceDelta(previous?.applicability_assessment.source_snapshot?.material_evidence??null,s.snapshot.material_evidence);
    if(previous && previous.applicability_assessment.source_snapshot.targets_sha256!==s.snapshot.targets_sha256)delta.push('Configured target domains changed.');
    const check={schema:APPLICABILITY_VERSION,consideration_only:true,source_return_id:id,input_sha256:s.input_sha256,source_snapshot:s.snapshot,input_delta:delta,scopes:s.scopes,targets:s.targets,base_assessment_return_id:previous?Number(previous.id):null,generation,...(reopenMd?{reopen_md:reopenMd}:{})};
    const prior=previous?`Prior assessment return #${previous.id}: ${JSON.stringify(previous.applicability_assessment.entries.map((e:any)=>({target_id:e.target_id,decision:e.decision,scope_keys:e.scope_keys})))}. Read its full conditions at GET <project>/return/${previous.id}. Reuse unchanged entries; inspect only changed source evidence: ${delta.slice(0,20).join(', ')||'unchanged; explicit reopening only'}.`:'No prior screening. Read the source and its current scope assessments once.';
    const brief=`Bounded applicability screening of accepted scientific return #${id}: provisional consideration before validated transfer. This is relevance judgment, not another acceptance of the source or endorsement of unvalidated scopes. Do not run experiments, reproduce a computation or re-prove the source. ${prior}\n\nSource snapshot: ${JSON.stringify(s.snapshot)}\nDeclared non-witness scopes with their existing authority: ${JSON.stringify(s.scopes)}\nConfigured areas: ${JSON.stringify(s.targets)}\n\nFor each area return applicability_assessment:{source_return_id:${id},input_sha256:"${s.input_sha256}",entries:[{target_id,decision:"applicable|inapplicable|unresolved",scope_keys:[<declared source keys; [] when the accepted report has no typed scope>],evidence_md,assumptions_md}]}. Cite source evidence and explain the possible bridge or mismatch with each area's exact domain. Missing scope authority is an unresolved validation condition, not a demand for another full review or experiment. Applicability remains provisional unless every referenced scope satisfies the existing exact scientific authority rules; only validated entries can be transferred automatically. Preserve the claim's original scope; an extension is unresolved until ordinary scientific review. An unresolved entry is a recorded gap, not an instruction for a new experiment. Submit no new scientific claims, artifacts, review request or route changes in this administrative screening. Record existing evidence even when every area is inapplicable. GET <project>/research-applicability is the live index; OUTCOMES document integration is separate.`;
    const task={schema:'research-task-v1',intent:'consolidation',topic_ids:[...new Set(s.targets.flatMap((t:ApplicabilityTarget)=>t.topic_ids))],predecessor_returns:[id],unresolved_obligation_md:`Assess the relevance of source #${id} across configured areas.`,changed_premise_md:reopenMd??'Use the exact accepted source snapshot; only material corrections justify reconsideration.',expected_evidence_md:'One evidence-backed applicability matrix; no new scientific execution.',stop_if_md:'The issued source snapshot is stale or no longer scientifically accepted.',domain_md:'Each issued target domain separately; preserve all original source restrictions.'};
    // Material endorsements arriving before first dispatch update the one unissued consideration, not another job.
    // Any issued or legacy contract remains frozen, including a released attempt that may be recovered.
    if(held){await q(`UPDATE jobs SET brief_md=$2,origin_key=$3,research_task=$4,applicability_check=$5 WHERE id=$1 AND status='queued' AND NOT EXISTS(SELECT 1 FROM assignment_attempts a WHERE a.job_id=jobs.id)`,[held.id,brief,`applicability:${id}:${generation}:${s.input_sha256}`,JSON.stringify(task),JSON.stringify(check)]);return Number(held.id);}
    const row=await one(`INSERT INTO jobs(problem_id,type,title,brief_md,budget_hours,min_tier,requires_trust,purpose,origin_key,research_source_return_id,avoid_model,research_task,applicability_check,compute_hint)
      VALUES($1,'explore',$2,$3,0.1,1,true,'work',$4,$5,$6,$7,$8,'{}') RETURNING id`,[problemId,`Applicability of return #${id}`,brief,`applicability:${id}:${generation}:${s.input_sha256}`,id,s.source.model,JSON.stringify(task),JSON.stringify(check)]);
    return Number(row!.id);
  });
}
export async function saveApplicability(returnId:number,problemId:number,slug:string,job:any,a:ApplicabilityAssessment|null,reviewer:any):Promise<string[]> {
  if(!a || !job?.applicability_check)return ['applicability_assessment needs its issued screening job; no relevance authority recorded'];
  const c=job.applicability_check;
  const trusted=await isTrusted(problemId,reviewer.user_id,reviewer.handle,{model:reviewer.model,effort:reviewer.effort});
  const granted=await isGrantedTrusted(problemId,reviewer.user_id,reviewer.handle);
  const source=await applicabilitySource(problemId,slug,c.source_return_id,c.consideration_only===true);
  if(!trusted || (reviewer.user_id===Number(source?.source.user_id) && !granted) || leanModelFamily(reviewer.model)===leanModelFamily(source?.source.model))return ['applicability_assessment requires a different trusted model family; own-handle judgment needs a project grant; no relevance authority recorded'];
  const exact=a.source_return_id===c.source_return_id && a.input_sha256===c.input_sha256 && a.entries.length===c.targets.length && c.targets.every((t:any)=>a.entries.some(e=>e.target_id===t.id)) && a.entries.every(e=>(c.consideration_only || e.scope_keys.length>0) && e.scope_keys.every(k=>c.scopes.some((s:any)=>s.key===k)));
  if(!exact)return ['applicability_assessment must match every issued target and supported source scope; no relevance authority recorded'];
  return transaction(async()=>{
    await q(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`applicability:${problemId}:${c.source_return_id}`]);
    const current=await applicabilitySource(problemId,slug,c.source_return_id,c.consideration_only===true);
    const validated=c.consideration_only ? await applicabilitySource(problemId,slug,c.source_return_id) : current;
    const acceptedScopeKeys=validated?.scopes.map((s:any)=>s.key)??[];
    const prior=await latest(problemId,c.source_return_id),effective=Boolean(current && current.input_sha256===c.input_sha256 && (prior?Number(prior.id):null)===(c.base_assessment_return_id??null));
    const entries=a.entries.map(e=>({...e,provisional_relevance:!transferEligible(e,acceptedScopeKeys),transfer_eligible:effective && transferEligible(e,acceptedScopeKeys)}));
    const saved={...a,entries,schema:APPLICABILITY_VERSION,consideration_only:c.consideration_only===true,provisional_relevance:entries.some(e=>e.provisional_relevance),effective,scientific_authority:false,source_snapshot:c.source_snapshot,targets:c.targets,check_job_id:Number(job.id),base_assessment_return_id:c.base_assessment_return_id??null,reviewer:{user_id:reviewer.user_id,handle:reviewer.handle,model:reviewer.model,effort:reviewer.effort,trusted:true,authority_basis:granted?'project_grant':'trusted_model',same_contributor:reviewer.user_id===Number(source?.source.user_id)}};
    await q(`UPDATE returns SET applicability_assessment=$2 WHERE id=$1 AND problem_id=$3`,[returnId,JSON.stringify(saved),problemId]);
    return effective?[]:['applicability_assessment source or decision base changed; recorded as ineffective, never used for automatic transfer'];
  });
}
/** Reconcile only sources already screened/nominated; never backfill historical acceptances or loop on elapsed time. */
const reconsiderCursor=new Map<number,number>();
export async function reconsiderApplicability(problemId:number,slug:string):Promise<void> {
  if(!applicabilityTargets(slug).length)return;
  const read=(after:number)=>q(`SELECT DISTINCT (applicability_check->>'source_return_id')::bigint AS id FROM jobs WHERE problem_id=$1 AND applicability_check IS NOT NULL AND (applicability_check->>'source_return_id')::bigint>$2 ORDER BY id LIMIT 12`,[problemId,after]);
  let rows=await read(reconsiderCursor.get(problemId)??0);if(!rows.length)rows=await read(0);
  if(rows.length)reconsiderCursor.set(problemId,Number(rows.at(-1)!.id));
  for(const row of rows)await queueApplicability(problemId,slug,Number(row.id));
}
export async function applicableSources(problemId:number,slug:string,job:any,topicIds:string[]):Promise<any[]> {
  if(job.applicability_check)return [];
  const targetIds=applicabilityTargets(slug).filter(t=>(t.lane && t.lane===job.lane_slug) || (t.paper && t.paper===job.paper_slug) || t.topic_ids.some(id=>topicIds.includes(id))).map(t=>t.id);
  if(!targetIds.length)return [];
  const rows=await q(`SELECT DISTINCT (applicability_assessment->>'source_return_id')::bigint AS id FROM returns WHERE problem_id=$1 AND applicability_assessment->>'effective'='true' AND EXISTS(SELECT 1 FROM jsonb_array_elements(applicability_assessment->'entries') e WHERE e->>'decision'='applicable' AND e->>'target_id'=ANY($2::text[])) ORDER BY id DESC LIMIT 40`,[problemId,targetIds]);
  const matches=[];
  for(const row of rows){const a=await currentApplicability(problemId,slug,Number(row.id));if(a?.current){const entries=a.applicability_assessment.entries.filter((e:any)=>targetIds.includes(e.target_id)&&transferEligible(e,a.accepted_scope_keys));if(entries.length)matches.push({source_return_id:Number(row.id),assessment_return_id:Number(a.id),input_sha256:a.applicability_assessment.input_sha256,source_snapshot:a.applicability_assessment.source_snapshot,reviewer:a.applicability_assessment.reviewer,entries,provisional_relevance:false,scientific_authority:false});}}
  return matches;
}
export async function applicabilityIndex(problemId:number,slug:string):Promise<any> {
  const rows=await q(`SELECT id FROM returns WHERE problem_id=$1 AND status='accepted' AND NOT provisional AND applicability_assessment IS NULL ORDER BY id DESC LIMIT 40`,[problemId]);
  const sources=[];
  for(const row of rows){const s=await applicabilitySource(problemId,slug,Number(row.id),true);if(s)sources.push({source_return_id:Number(row.id),report_sha256:s.snapshot.report_sha256,scopes:s.scopes,consideration_eligible:true,validated_transfer_source:Boolean(await applicabilitySource(problemId,slug,Number(row.id))),assessment:await currentApplicability(problemId,slug,Number(row.id))});}
  return {schema:APPLICABILITY_VERSION,targets:applicabilityTargets(slug),sources,bounded:true,document_integration:'Separate reviewed revision; this live index does not rewrite OUTCOMES or historical verdicts.'};
}
