import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseApplicability,targetHash} from '../src/lib/research-applicability-format.ts';
import {scientificSource,applicabilityTargets} from '../src/lib/research-applicability.ts';
test('applicability excludes numerical and administrative acceptance',()=>{
 const source={status:'accepted',type:'measure',provisional:false};
 assert.equal(scientificSource(source,'trusted'),true);
 for(const by of ['verifier','advisory',null])assert.equal(scientificSource(source,by),false);
 for(const key of ['provisional','known_work','work_disposition','applicability_assessment'])assert.equal(scientificSource({...source,[key]:true},'trusted'),false);
 for(const type of ['check','review','curate','triage'])assert.equal(scientificSource({...source,type},'trusted'),false);
});
test('bounded exact assessment ignores forged authority and priority',()=>{
 const a={source_return_id:1,input_sha256:'a'.repeat(64),trusted:true,effective:true,entries:[{target_id:'area-a',decision:'applicable',scope_keys:['method'],evidence_md:'The same invariant applies.',assumptions_md:'Only the accepted domain.',bonus:999}]};
 const parsed=parseApplicability(a);assert.equal(parsed.trusted,undefined);assert.equal(parsed.entries[0].bonus,undefined);
 for(const patch of [{entries:[...a.entries,...a.entries]},{input_sha256:'wrong'},{entries:[{...a.entries[0],assumptions_md:''}]},{entries:[{...a.entries[0],decision:'proved'}]}])assert.throws(()=>parseApplicability({...a,...patch}));
});
test('configured areas preserve project differences and stable target identity',()=>{
 assert.equal(applicabilityTargets('md5').length,3);assert.equal(applicabilityTargets('twin-primes').length,7);
 const a=applicabilityTargets('md5');assert.equal(targetHash(a),targetHash([...a].reverse().map(t=>({...t,topic_ids:[...t.topic_ids].reverse()}))));
 assert.notEqual(targetHash(a),targetHash(a.map(t=>({...t,domain_md:t.domain_md+' Changed domain.'}))));
});
