import { workHash } from './work-disposition-format.js';

export const WORK_INPUT_VERSION = 'material-evidence-v1';
export type WorkEvidence = { version: typeof WORK_INPUT_VERSION; entries: Record<string,string>; sha256: string; complete?:boolean };

/** JSONB key order and archive bookkeeping are not changes to scientific evidence. */
export function canonical(value:any):any {
  if(Array.isArray(value))return value.map(canonical);
  if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
export const materialHash = (value:any) => workHash(canonical(value));
const sortedMetadata=(value:any[])=>value.slice().sort((a,b)=>materialHash(a).localeCompare(materialHash(b)));
const assessment = (value:any) => {
  const content=Object.fromEntries(Object.entries(value??{}).filter(([key,v])=>!['work_check','schema'].includes(key) && v!==null && v!=='' && !(Array.isArray(v)&&!v.length)));
  for(const key of ['supported_scopes','comparison_checks'])if(Array.isArray(content[key]))content[key]=sortedMetadata(content[key] as any[]);
  return Object.keys(content).length?content:null;
};
const researchEvidence=(value:any)=>value?{...value,topic_ids:(value.topic_ids??[]).slice().sort(),scopes:sortedMetadata((value.scopes??[]).map((s:any)=>({...s,artifact_sha256:(s.artifact_sha256??[]).slice().sort()})))}:null;
export function reviewEvidence(row:any):any {
  return {return_id:Number(row.return_id),user_id:row.user_id==null?null:Number(row.user_id),model:row.model,provider:row.provider,effort:row.effort,
    verdict:row.verdict,rung:row.rung,trusted:row.trusted,weight:row.weight===undefined?undefined:Number(row.weight),needs_reassessment:row.needs_reassessment,
    notes_md:row.notes_md,research_assessment:assessment(row.research_assessment),verification:row.verification,
    verification_receipt_id:row.verification_receipt_id==null?null:Number(row.verification_receipt_id),verification_sufficiency_md:row.verification_sufficiency_md,
    verification_conflict_resolution_md:row.verification_conflict_resolution_md};
}
export function materialEvidence(rows:{returns:any[];reviews:any[];history:any[];findings:any[];artifacts:any[];messages:any[]}):WorkEvidence {
  const entries:Record<string,string>={};
  for(const r of rows.returns)entries[`return:${r.id}`]=materialHash({id:Number(r.id),
    // Pending versus recorded is admission bookkeeping, not scientific acceptance.
    authority:['accepted','rejected','contested'].includes(r.status)?r.status:'unaccepted',
    final_rung:r.status==='accepted'?r.final_rung:null,provisional:r.provisional,
    report_md:r.report_md,research:r.research,research_evidence:researchEvidence(r.research_evidence),recipe_md:r.recipe_md,repo_url:r.repo_url,commit:r.commit,cpu_hours:r.cpu_hours==null?null:Number(r.cpu_hours),revision_sha:r.revision_sha,patch:r.patch,
    verification_fingerprint:r.verification_fingerprint,verification_plan:r.verification_plan});
  const active=new Set<string>();
  for(const r of rows.reviews) {const hash=materialHash(reviewEvidence(r));entries[`review:${r.return_id}:${r.user_id??r.id}:${r.model}`]=hash;active.add(hash);}
  // Re-archiving an unchanged judgment adds no evidence. Withdrawal or changed judgment still does.
  for(const h of rows.history) {const hash=materialHash(reviewEvidence(h.review));if(!active.has(hash))entries[`archived-review:${hash}`]=hash;}
  for(const f of rows.findings)entries[`finding:${f.id}`]=materialHash(f);
  for(const f of rows.artifacts)entries[`artifact:${f.ref_id}:${f.file_sha}`]=f.file_sha;
  // Only explicitly cited messages enter the material snapshot. New chatter/replies must be nominated.
  // Reposting identical evidence under a new message id is not a fresh experiment.
  for(const m of rows.messages) {const hash=materialHash({user_id:m.user_id,model:m.model,kind:m.kind,body_md:m.body_md,return_id:m.return_id});entries[`message:${hash}`]=hash;}
  return {version:WORK_INPUT_VERSION,entries,sha256:materialHash({version:WORK_INPUT_VERSION,entries})};
}
export function evidenceDelta(before:WorkEvidence|null,after:WorkEvidence):string[] {
  if(!before)return ['Legacy or first comparison: establish one material baseline; historical raw fingerprints cannot establish which evidence changed.'];
  return [...new Set([...Object.keys(before.entries),...Object.keys(after.entries)])].sort().filter(k=>before.entries[k]!==after.entries[k]);
}
