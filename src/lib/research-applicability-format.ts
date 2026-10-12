import {materialHash} from './work-evidence.js';

export const APPLICABILITY_VERSION = 'research-applicability-v1';
export type ApplicabilityTarget = {id:string;title:string;domain_md:string;topic_ids:string[];lane?:string;paper?:string};
export type ApplicabilityEntry = {target_id:string;decision:'applicable'|'inapplicable'|'unresolved';scope_keys:string[];evidence_md:string;assumptions_md:string};
export type ApplicabilityAssessment = {source_return_id:number;input_sha256:string;entries:ApplicabilityEntry[]};
const text=(x:any,required=false)=>{if(typeof x!=='string' || x.length>4000 || (required&&!x.trim()))throw new Error('applicability needs bounded evidence and assumptions');return x;};
export function parseApplicability(x:any):ApplicabilityAssessment {
  if(!x || !Number.isSafeInteger(Number(x.source_return_id)) || Number(x.source_return_id)<1 || !/^[a-f0-9]{64}$/.test(x.input_sha256) || !Array.isArray(x.entries) || !x.entries.length || x.entries.length>16)throw new Error('applicability needs source, exact input hash and bounded entries');
  const entries=x.entries.map((e:any)=>{
    if(!e || !/^[a-z0-9][a-z0-9.-]{0,80}$/.test(e.target_id) || !['applicable','inapplicable','unresolved'].includes(e.decision) || !Array.isArray(e.scope_keys) || !e.scope_keys.length || e.scope_keys.length>12 || e.scope_keys.some((k:any)=>typeof k!=='string'||!k.length||k.length>80))throw new Error('applicability needs a target, decision and exact source scopes');
    return {target_id:e.target_id,decision:e.decision,scope_keys:[...new Set<string>(e.scope_keys)].sort(),evidence_md:text(e.evidence_md,true),assumptions_md:text(e.assumptions_md,true)};
  });
  if(new Set(entries.map((e:ApplicabilityEntry)=>e.target_id)).size!==entries.length)throw new Error('applicability targets must be unique');
  return {source_return_id:Number(x.source_return_id),input_sha256:x.input_sha256,entries};
}
export const targetHash=(targets:ApplicabilityTarget[])=>materialHash(targets.map(t=>({...t,topic_ids:[...t.topic_ids].sort()})).sort((a,b)=>a.id.localeCompare(b.id)));
export const APPLICABILITY_GUIDANCE=`Authors of reusable findings should declare exact research_evidence scopes and transfer conditions; ordinary reviewers endorse only the currently supported scope hashes and record material corrections in research_assessment. Useful accepted scoped findings receive one bounded trusted applicability screening across the project's configured areas. This is relevance judgment, not a new scientific verdict or permission to extend a proof. Reuse the source's current exact scopes, corrections and artifacts. For every issued target record applicable, inapplicable or unresolved with evidence and assumptions. An applicable entry carries only the original supported claim and stated transfer conditions. Unknown applicability creates no experiments automatically; propose an ordinary distinct research task only when a consequential gap warrants it. Candidate verification, administrative records and unendorsed scopes are excluded. Current applicable findings enter new matching assignments; held payloads stay frozen. Read GET <project>/research-applicability for live scoped outcomes and screening history; the document OUTCOMES ledger is separately reviewed and may lag. Material source corrections require a fresh screening; unchanged evidence is reused. Only a trusted explicit POST <project>/return/:id/applicability/reopen with {note} requests reconsideration of an unchanged assessment.`;
