import assert from 'node:assert/strict';
import {test} from 'node:test';
import {recordAwards, RECORD_POINTS} from '../src/lib/challenge-credit.ts';
const r = (id, userId, value, extra = {}) => ({id, userId, value, target: 12, ...extra});
const awards = rs => [...recordAwards('higher', rs)];

test('reward follows existing break, formalization and refutation points; jway 11→12 earns 100', () => {
  assert.deepEqual(RECORD_POINTS, {site: 60, matched: 100, exceeded: 250});
  assert.deepEqual(awards([r(23, 1, 11), r(136, 2, 12)]), [[23,60],[136,100]]);
});
test('staging improvements, skipping tiers, ties and duplicate keys cannot multiply rewards', () => {
  assert.deepEqual(awards([r(1,1,9), r(2,1,10), r(3,1,11), r(4,1,12), r(5,1,13), r(6,1,14), r(7,2,14)]), [[1,60],[4,40],[5,150]]);
  assert.deepEqual(awards([r(1,1,13)]), [[1,250]]);
  assert.deepEqual(awards([r(1,1,12),r(2,2,12),r(3,3,12,{duplicate:true})]), [[1,100]]);
});
test('copies and imports establish the baseline without credit; demo, withdrawn and score zero earn none', () => {
  assert.deepEqual(awards([r(1,1,0),r(2,1,10,{known:true}),r(3,2,10),r(4,2,11,{duplicate:true}),r(5,3,11),r(6,3,12,{demo:true}),r(7,4,13,{withdrawn:true})]), []);
});
test('receipt order, not input array order, owns discovery; a different tied candidate succeeds after a void', () => {
  assert.deepEqual(awards([r(2,2,12),r(1,1,12)]), [[1,100]]);
  assert.deepEqual(awards([r(1,1,12,{withdrawn:true}),r(2,2,12)]), [[2,100]]);
  assert.deepEqual(awards([r(1,1,12,{withdrawn:true}),r(2,2,12,{duplicate:true})]), []);
});
test('lower-is-better collisions use the same capped tiers and preserve reference snapshots', () => {
  assert.deepEqual([...recordAwards('lower', [r(1,1,256,{target:128}),r(2,1,248,{target:128}),r(3,1,128,{target:128}),r(4,1,126,{target:128})])], [[1,60],[3,40],[4,150]]);
  assert.deepEqual(awards([r(1,1,12),r(2,1,13,{target:14}),r(3,1,14,{target:14})]), [[1,100]]);
});
test('a restored record reproduces the same entitlement; unlimited further records cap at 250 per person/track', () => {
  const rs = Array.from({length:100}, (_,i) => r(i+1,1,i+1));
  assert.equal(awards(rs).reduce((sum,[,p])=>sum+p,0), 250);
  assert.deepEqual(awards([r(1,1,12)]), awards([r(1,1,12,{withdrawn:false})]));
});
