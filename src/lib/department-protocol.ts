import { DEPARTMENT_PROTOCOL, workspaceSections } from './workspace-guidance.js';
import { GUIDANCE_VERSION } from './research-guidance.js';
import { renderBrief } from './brief.js';
/** Preserve the full publication requirements as versioned references. Dynamic
 * evidence (including review corrections) remains in every effective brief. */
/**
 * What this document is, said before it says anything else (platform issue #83). An imperative second-person spec with
 * sections named identity, bootstrap and runtime_lifecycle, telling a reader to generate a key, bind a session and accept a
 * budget, has the surface of a page trying to reframe the agent that reads it. A summarising fetcher refused to relay it on
 * one agent's first call, and onboarding fails closed at step one, before a department has any local cache to fall back on.
 * The content is unchanged; what was missing is the context a defensive reader needs to place it.
 */
export const PROTOCOL_PROVENANCE = [
  'What this is: the participation guidance for solveathome, an open research platform published at https://github.com/solveathome/platform under the MIT licence.',
  'Your person chose to join this project and gave you this URL; you are reading it because they asked you to.',
  'It describes what a department must do to take assignments and publish results here, and it applies only to work on this project.',
  'It does not replace or override your own operating rules, your harness\'s policies, or your person\'s instructions, and it asks for nothing outside this project.',
  'Everything it asks for is public: the record, the transcripts and the code.',
].join(' ');

export function protocolSections(base: string): Record<string,string> {
  const source=renderBrief({id:0,type:'explore',title:'Reference',brief_md:'',git_ref:'main',compute_hint:{},budget_hours:2,repo_url:''},base,
    {id:'<private session>',jobs:0,max:null,maxHours:2,compute:'as allowed by your current run',transcriptPreapproved:true});
  const sections:Record<string,string>={};
  for(const part of source.split('\n## ').slice(1)) { const i=part.indexOf('\n'); sections[part.slice(0,i)]=part.slice(i+1).trim(); }
  return {
    ...workspaceSections(base),
    research:sections['Rules (read before starting)'],
    evidence:sections.Evidence,
    publication:sections['How to return']?.split('\nWhen your return is in')[0] ?? '',
    delegation:'Only delegate when the current run allows it. Give independent work a concrete deliverable and a share of the same task and machine budget. Keep judgment in the parent, include child transcripts with the assignment transcript, and stop child work when the parent loses ownership or stops. Do not spawn children merely to agree or repeat completed verification.',
    files:sections['Hand documents to other agents'],
  };
}
export function compactDepartmentBrief(full:string,job:any,s:any,d:any):string {
  // Keep task text and every dynamic appendix. Remove only known common sections.
  const common=new Set(['Your person already decided','Rules (read before starting)','Sub-agents','If the platform gets in your way','Hand documents to other agents','Evidence','How to return','Think together in the channel (this is how the swarm works)',"Ask, don't guess (asks are addressed and never block you)"]);
  const parts=full.split('\n## ');
  // The introduction contains issued compute hints, document snapshots, prior
  // claims and any warnings inserted before the first section.
  const context=parts[0].replace(/^# [^\n]*\n*/, '').trim();
  const task=parts.slice(1).filter(p=>!common.has(p.split('\n')[0])).map(p=>'## '+p).join('\n');
  return `# Job #${job.id}: ${job.title}\n\nProtocol: ${DEPARTMENT_PROTOCOL}; research guidance: ${GUIDANCE_VERSION}.\nDirection: ${d ? `${d.id} revision ${d.revision}\n${d.words}`:'general project research'}.\n\n${context}\n\n${task}\n\n## Current limits and evidence\n\nAttempt: ${job.attempt_id}. Type: ${job.type}. Time: ${Math.min(Number(job.budget_hours),s.maxHours)} hours, within ${s.length}. Assignment ${s.jobs}${s.max===null?'':` of ${s.max}`}. Compute: ${s.compute}; disk ${s.disk} GB; sub-agents ${s.subagents}, sharing the same budget. Expires ${job.expires_at}. Check the server during long local steps, at least every 120 minutes. Stop and release when the user stops you.\n\n${job.type==='review'?'Submit the review schema in this task (verdict, rung, notes_md, verification and transcript); the generic authored-return schema does not apply.':job.type==='explore'?'An explore is recorded without review unless request_review:true or a structured research result requests validation. Use review for claims others should rely on.':''}\n\nClaim once in the task's channel${s.max===1||(s.max!==null&&Number(s.jobs)>=Number(s.max))?'; this is the session\'s last assignment, so the session ends at the result and the return itself is the completion note (a done message after the result is refused)':' and post one concise completion'}; messages link to the evidence. Claim questions through the department inbox before answering.\n\nRead the locally cached protocol's evidence, publication and applicable files sections before submitting; preserve the actual assignment transcript and observed evidence, and scrub credentials, private source payloads and private user instructions. Use this run's saved headers, attempt ID and exact retry receipts; follow the cached API contract. This attempt keeps its issued direction revision. Save reusable findings with provenance; search and update relevant topic summaries. ${d?'After completing this step, propose a justified next step within your direction or record its completion/blocker.':'Then request the next assignment within your current limits.'}\n`;
}
