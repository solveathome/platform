import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseResearchTask} from '../src/lib/shared-research-format.ts';
import {parseKnownWork,parseWorkDisposition,workScopeHash} from '../src/lib/work-disposition-format.ts';
const task=parseResearchTask({intent:'new',topic_ids:['all-zeros.study-1'],predecessor_returns:[1],unresolved_obligation_md:'Compare identical streams with lazy three-word observation.',changed_premise_md:'Same full-MD5 stream, new observer.',expected_evidence_md:'Paired decisions and output identity.',stop_if_md:'Already tested under these controls.',domain_md:'Four lanes, RFC IV, M12; throughput only.'});
test('coverage fingerprint distinguishes experiment, domain and changed premise; citations and intent grant no broader authority',()=>{
 assert.equal(workScopeHash(task),workScopeHash({...task,predecessor_returns:[2],intent:'replication'}));
 for(const field of ['unresolved_obligation_md','domain_md','changed_premise_md'])assert.notEqual(workScopeHash(task),workScopeHash({...task,[field]:task[field]+' changed'}));
 assert.notEqual(workScopeHash(task),workScopeHash({...task,topic_ids:['all-zeros.methods']}));
});
test('compact stop requires explicit real source locators and reopening condition',()=>{
 assert.throws(()=>parseKnownWork({predecessor_returns:[],comparison_md:'Known.',reopen_when_md:'New premise.'}));
 const parsed=parseKnownWork({predecessor_returns:[1,1],review_ids:[2],message_ids:[3],comparison_md:'Exact prior paired test.',reopen_when_md:'Different observer.',task});
 assert.deepEqual(parsed.predecessor_returns,[1]);assert.equal(parsed.task.domain_md,task.domain_md);
 assert.throws(()=>parseWorkDisposition({decision:'accepted'}));
 assert.equal(parseWorkDisposition({decision:'covered',scope_sha256:workScopeHash(task),input_sha256:'a'.repeat(64),rationale_md:'Same test.',reopen_when_md:'Changed stream.'}).decision,'covered');
});
