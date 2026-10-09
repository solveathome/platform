// Transport and mapping fixtures only; no model or TeX/Lean result is asserted.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {decodeExpositionPdf,acceptedExpositionSource,expositionKey,validateExpositionMapping,expositionReviewMatches} from '../src/lib/paper-exposition.ts';
const hash=s=>createHash('sha256').update(s).digest('hex');
const summary={status:'checked',judged_receipt_id:3,manuscript_sha256:'a'.repeat(64),statement_binding:'b'.repeat(64),checked_claims:['main'],claims:[{id:'main',declaration:'Proof.main',target:'Proof.lean',coverage:'full',assumptions:['S is a prime family']}]};
const source={id:1,status:'accepted',provisional:false,verification_fingerprint:'c'.repeat(64)};
const map=()=>({schema:'paper-exposition-map-v1',source_return_id:1,source_fingerprint:source.verification_fingerprint,receipt_id:3,tex_sha256:'d'.repeat(64),claims:[{source_claim_id:'main',...summary.claims[0],tex_locator:'Theorem 1'}],unproved_claims:[{id:'O1',status:'open',tex_locator:'Section 4',description:'Unproved stronger estimate'}]});
test('only current finally accepted mapped evidence qualifies, including explicitly conditional scope',()=>{
  assert.equal(acceptedExpositionSource(source,summary),true);
  for(const status of ['stale','awaiting_review','conflicting','rejected','unable','no_proof','failed','superseded']) assert.equal(acceptedExpositionSource(source,{...summary,status}),false,status);
  for(const r of [{...source,status:'pending'},{...source,provisional:true},{...source,paper_exposition:{}},null]) assert.equal(acceptedExpositionSource(r,summary),false);
  assert.equal(acceptedExpositionSource(source,{...summary,status:'conditional'}),true);
  assert.equal(acceptedExpositionSource(source,{...summary,checked_claims:[]}),false);
});
test('deduplication is invariant to receipt refresh and operational observations, but changes with scientific scope',()=>{
  const key=expositionKey('paper',summary);
  assert.equal(expositionKey('paper',{...summary,judged_receipt_id:9,machine:'fixture'}),key);
  for(const change of [{manuscript_sha256:'e'.repeat(64)},{statement_binding:'f'.repeat(64)},{checked_claims:['other']}]) assert.notEqual(expositionKey('paper',{...summary,...change}),key);
});
test('a revised exposition binds its own exact TeX and preserves formal parameters and explicit open scope',()=>{
  const m=map();assert.equal(validateExpositionMapping(m,source,summary,m.tex_sha256)[0].source_claim_id,'main');
  assert.throws(()=>validateExpositionMapping(m,source,summary,'e'.repeat(64)),/exact source/);
  for(const change of [{declaration:'Proof.stronger'},{assumptions:[]},{coverage:'partial'},{target:'Other.lean'},{source_claim_id:'new'}]) {
    const n=map();Object.assign(n.claims[0],change);assert.throws(()=>validateExpositionMapping(n,source,summary,n.tex_sha256),/unchanged/);
  }
  const n=map();n.unproved_claims[0].status='verified';assert.throws(()=>validateExpositionMapping(n,source,summary,n.tex_sha256),/open status/);
  const duplicate=map();duplicate.claims.push(duplicate.claims[0]);assert.throws(()=>validateExpositionMapping(duplicate,source,summary,duplicate.tex_sha256),/unique/);
  const duplicateOpen=map();duplicateOpen.unproved_claims.push(duplicateOpen.unproved_claims[0]);assert.throws(()=>validateExpositionMapping(duplicateOpen,source,summary,duplicateOpen.tex_sha256),/unique/);
  assert.throws(()=>validateExpositionMapping(map(),source,{...summary,checked_claims:['main','other']},map().tex_sha256),/every accepted/);
});
test('fidelity acceptance is bound to this artifact version and every mapped claim, including at decision time',()=>{
  const e={tex_sha256:'d'.repeat(64),claim_map_sha256:'e'.repeat(64),pdf_sha256:'f'.repeat(64),source_fingerprint:source.verification_fingerprint,claims:[{source_claim_id:'main'}]};
  const review={...e,reviewed_claim_ids:['main'],fidelity_md:'The exact exposition artifacts preserve the accepted formal statement, definitions, domains and explicit open scope.'};
  assert.equal(expositionReviewMatches(e,review),true);
  for(const change of [{tex_sha256:'a'.repeat(64)},{reviewed_claim_ids:[]},{reviewed_claim_ids:['main','main']},{source_fingerprint:'b'.repeat(64)},{fidelity_md:'Too short'}]) assert.equal(expositionReviewMatches(e,{...review,...change}),false);
  assert.equal(expositionReviewMatches(e,null),false);
});
test('PDF envelope decoding is bounded, canonical and hash-exact, without interpreting PDF data',()=>{
  const bytes=Buffer.from('%PDF-1.4\nSynthetic transport fixture, not a rendered paper.\n%%EOF\n');
  const p={schema:'paper-exposition-pdf-v1',bytes:bytes.length,sha256:hash(bytes),base64:bytes.toString('base64')};
  assert.deepEqual(decodeExpositionPdf(JSON.stringify(p)).bytes,bytes);
  for(const change of [{bytes:p.bytes+1},{bytes:10**9},{sha256:'0'.repeat(64)},{base64:p.base64+'AA=='},{base64:'!'.repeat(p.base64.length)}]) assert.throws(()=>decodeExpositionPdf(JSON.stringify({...p,...change})));
  assert.throws(()=>decodeExpositionPdf('{}'));
});
