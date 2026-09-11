import assert from 'node:assert/strict';
import {test} from 'node:test';
// The per-handle budget names the sessions that used it (issue #35).
const {hitDetailed, hit} = await import('../src/lib/ratelimit.ts');

test('hitDetailed counts per sub and names the heaviest when over', () => {
  const key = `t-${Date.now()}`;
  for (let i = 0; i < 7; i++) hitDetailed(key, 'busy-session', 8, 60_000);
  hitDetailed(key, 'quiet-session', 8, 60_000);
  const r = hitDetailed(key, 'newcomer', 8, 60_000);
  assert.equal(r.over, true);
  assert.deepEqual(r.top[0], ['busy-session', 7]);
  assert.ok(r.top.some(([s]) => s === 'newcomer'));
  assert.equal(hit(`${key}-other`, 8, 60_000).over, false);
});
