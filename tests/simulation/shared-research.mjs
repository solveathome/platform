import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {proposal,step} from './harness.mjs';
import {scopeHash} from '../../src/lib/shared-research-format.ts';
/** Scripted reasoning; actual HTTP intake, shared retrieval and route comparison. Never scientific validation. */
export async function sharedCollaboration(w) {
 const {PROJECTS_DIR}=await import('../../src/lib/projects.ts');
 const root=PROJECTS_DIR,slug=w.base.split('/').at(-1);
 const cfg=JSON.parse(readFileSync(new URL('../../projects/md5/project.json',import.meta.url)));delete cfg.challenge;cfg.slug=slug;
 mkdirSync(join(root,slug));writeFileSync(join(root,slug,'project.json'),JSON.stringify(cfg));
 try {
  const a=await w.actor('author','gpt-6-astra'),b=await w.actor('other','claude-opus-5-5'),judge=await w.actor('judge','claude-fable-5-1',{trusted:true});
  const r=await a.submit({type:'direction',research:proposal('Gate to compare')});
  await w.take(a,j=>j.research_stage==='first_look');const first=await a.submit({request_review:true,research:{route_id:r.research.route_id,outcome:'promising',evidence_md:'A controlled gate is open.',next_step:step('matched gate')}});
  const scope={key:'matched-cache',statement_md:'A controlled cache comparison establishes throughput on this corpus.',domain_md:'Full MD5, RFC IV, 32 ASCII hex bytes; identical candidates and strong warmed cache baseline.',kind:'throughput',assumptions_md:'Fixture hardware and cache state.',artifact_sha256:[],transfer_conditions_md:'No output bias or numerical record.'};
  const evidence=await b.submit({type:'direction',research_evidence:{topic_ids:['self-match.methods'],scopes:[scope]},research_links:[{subject_return_id:first.return_id,route_id:r.research.route_id,relation:'bears_on',rationale_md:'Candidate association, not gate acceptance.'}]});
  const links=[{subject_return_id:evidence.return_id,route_id:r.research.route_id,relation:'addresses',rationale_md:'Controlled benchmark may answer the gate.'}];
  const assessment={supported_scopes:[{scope_key:scope.key,scope_sha256:scopeHash(scope)}],corrections_md:'Condition the broad extension on the chaining value.',next_test_md:'Use the matched cache baseline; avoid repeating H0.',reopen_when_md:'Only a changed premise or independent replication.'};
  await judge.submit({type:'review',return_id:evidence.return_id,verdict:'accept',rung:'measured',notes_md:'Scoped pending benchmark.',research_assessment:assessment,research_links:links});
  const candidate=await w.take(a,j=>j.research_stage==='first_look'&&Number(j.research_route_id)===r.research.route_id);
  assert.match(candidate.brief_md,/avoid repeating H0/);assert.match(candidate.brief_md,/pending/);
  const read=await w.read(`/return/${evidence.return_id}`);assert.equal(read.research_authority.scopes[0].research_status,'pending scoped endorsement');
  await a.submit({research:{route_id:r.research.route_id,outcome:'promising',evidence_md:'The pending cache report narrows the design but does not settle this controlled gate; preserve its correction.',next_step:step('matched gate')}});
  const pursuit=await w.one("SELECT * FROM jobs WHERE research_route_id=$1 AND status='queued' AND research_stage='pursue'",[r.research.route_id]);
  const {holdForStepCheck}=await import('../../src/lib/research.ts');assert.equal(await holdForStepCheck(pursuit),null);
  await w.invariant();w.record('expectations',{linked_pending_result_visible:true,review_correction_reused:true,scope_quorum_preserved:true,unchanged_comparison_reused:true});
 } finally {rmSync(join(root,slug),{recursive:true,force:true});}
}
