import { createHash } from 'node:crypto';
import { parseResearchTask, type ResearchTask } from './shared-research-format.js';

export const WORK_DISPOSITION_VERSION = 'work-disposition-v1';
export type WorkSources = { predecessor_returns: number[]; review_ids: number[]; message_ids: number[]; topic_ids?:string[] };
export type KnownWork = WorkSources & { task?: ResearchTask; comparison_md: string; remaining_gap_md: string; reopen_when_md: string };
export type WorkDisposition = { decision: 'covered' | 'open'; scope_sha256: string; input_sha256: string; rationale_md: string; reopen_when_md: string; next_task?: ResearchTask };
const obj = (x:any) => { if(!x || typeof x!=='object' || Array.isArray(x)) throw Error('expected an object'); return x; };
const text = (x:any, required=true) => { if(x===undefined && !required)return ''; if(typeof x!=='string' || x.length>4000 || (required&&!x.trim()))throw Error('expected nonempty text, at most 4000 characters'); return x.trim(); };
const ids = (x:any) => { if(x===undefined)return []; if(!Array.isArray(x)||x.length>20||x.some(v=>!Number.isSafeInteger(v)||v<1))throw Error('expected at most 20 positive integer locators'); return [...new Set<number>(x)]; };
const hash = (x:any) => { if(typeof x!=='string'||!/^[a-f0-9]{64}$/.test(x))throw Error('expected a lowercase SHA256'); return x; };
export const workHash = (x:any) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
/** Deliberately exact, never a lane/paper/topic-wide closure. Intent and citations do not alter the question. */
export const workScopeHash = (task:ResearchTask) => workHash([task.topic_ids.slice().sort(),task.unresolved_obligation_md,task.domain_md,task.changed_premise_md]);
export function parseKnownWork(raw:any):KnownWork {
  const x=obj(raw), predecessor_returns=ids(x.predecessor_returns);
  if(!predecessor_returns.length)throw Error('name at least one predecessor return');
  return {predecessor_returns,review_ids:ids(x.review_ids),message_ids:ids(x.message_ids),comparison_md:text(x.comparison_md),remaining_gap_md:text(x.remaining_gap_md,false),reopen_when_md:text(x.reopen_when_md),...(x.task ? {task:parseResearchTask(x.task)} : {})};
}
export function parseWorkDisposition(raw:any):WorkDisposition {
  const x=obj(raw); if(!['covered','open'].includes(x.decision))throw Error('decision must be covered or open');
  return {decision:x.decision,scope_sha256:hash(x.scope_sha256),input_sha256:hash(x.input_sha256),rationale_md:text(x.rationale_md),reopen_when_md:text(x.reopen_when_md),...(x.next_task ? {next_task:parseResearchTask(x.next_task)} : {})};
}
export const WORK_DISPOSITION_GUIDANCE = `Before substantial work, read the lane chat and current work-state, name the exact experiment and its changed premise, and compare in-flight claims. Claim once with that experiment; read replies between steps. Chat is evidence for coordination, never acceptance or permission to close a question. If existing evidence covers this unchanged obligation and you make no new scientific claim, use known_work:{predecessor_returns:[ids],review_ids:[ids],message_ids:[ids],comparison_md,remaining_gap_md,reopen_when_md,task?:<exact research-task-v1>}, with a short report and the actual assignment transcript. It is recorded without routine scientific review and nominates a deduplicated trusted assignment comparison. A generic run needs an explicit narrower task to claim coverage; otherwise its reviewer must select a distinct next experiment. New claims, patches, verification packages and witnesses use the ordinary result path. Covered assignment decisions never accept scientific claims, alter route state, integrate documents or affect other proof obligations. Changed premises and explicit replication remain possible.`;
