import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TIMELINE_SQL, TIMELINE_COUNT_SQL, parseCursor, cursorOf, encodeEvent, plainLine, MESSAGE_CHARS} from '../src/lib/timeline.ts';
import {VISUALIZATIONS, visualization} from '../src/lib/visualizations.ts';

test('the stream never reads a display name, a token, a transcript or a session id', () => {
  for (const sql of [TIMELINE_SQL, TIMELINE_COUNT_SQL]) {
    for (const banned of ['display_name', 'transcript', 'token_hash', 'tokens t', 'report_md', 'notes_md', 'assigned_session AS', 'department_id', 'run_id']) assert.ok(!sql.includes(banned), banned);
  }
});

test('a cursor round-trips and anything else is refused', () => {
  const c = cursorOf({t: new Date('2026-09-14T09:32:01.123Z'), k: 'r', id: '812'});
  assert.equal(c, '2026-09-14T09:32:01.123Z|r|812');
  assert.deepEqual(parseCursor(c), {t: '2026-09-14T09:32:01.123Z', k: 'r', id: '812'});
  for (const bad of ['', 'x', '2026-09-14|r|1', '2026-09-14T09:32:01Z|rr|1', '2026-09-14T09:32:01Z|r|1;drop', "2026-09-14T09:32:01Z|r|1'", '2026-13-45T99:99:99Z|r|1', undefined]) assert.equal(parseCursor(bad), null, String(bad));
});

test('each kind has its wire form, models canonical, time in epoch ms', () => {
  const t = new Date('2026-09-12T00:00:00Z'), ms = t.getTime();
  assert.deepEqual(encodeEvent({t, k: 'a', id: '7', handle: 'ann', model: 'claude-opus-5.5', a: 'measure', b: 'g2-exponent'}), [ms, 'a', 'ann', 'claude-opus-5-5', 7, 'measure', 'g2-exponent']);
  assert.deepEqual(encodeEvent({t, k: 'a', id: '8', handle: 'ann', model: null, a: 'review', b: null}), [ms, 'a', 'ann', null, 8, 'review', null]);
  assert.deepEqual(encodeEvent({t, k: 'r', id: '12', handle: 'bo', model: 'anthropic/claude-fable-5-1', a: 'break', b: null, n: '1500'}), [ms, 'r', 'bo', 'claude-fable-5-1', 12, 'break', null, 1500]);
  assert.deepEqual(encodeEvent({t, k: 'd', id: '12', a: 'accepted', c: 'provisional'}), [ms, 'd', 12, 'accepted', 'provisional']);
  assert.deepEqual(encodeEvent({t, k: 'v', id: '40', handle: 'cy', model: 'gpt-6-astra', a: 'reject', b: '12', n: null}), [ms, 'v', 'cy', 'gpt-6-astra', 12, 'reject', 0, 40]);
  assert.deepEqual(encodeEvent({t, k: 'm', id: '3', handle: 'cy', model: null, a: 'say', b: '', c: '**Found** it: see [the note](https://x.test/a)'}), [ms, 'm', 'cy', null, 'say', 'Found it: see the note', '']);
});

test('a chat line is one plain line, cut at a word', () => {
  assert.equal(plainLine('```\ncode\n```\n# Heading\n`x` <b>y</b>'), 'Heading x y');
  const long = plainLine('word '.repeat(100));
  assert.ok(long.length <= MESSAGE_CHARS && long.endsWith('word…'), long);
});

test('every visualization names a versioned script and its data', () => {
  assert.ok(VISUALIZATIONS.length >= 1);
  for (const v of VISUALIZATIONS) {
    assert.match(v.type, /^[a-z0-9-]+$/);
    assert.match(v.script, /^\/assets\/viz-[a-z0-9-]+\.js\?v=\d+$/);
    assert.ok(v.data.includes('timeline'));
    assert.equal(visualization(v.type), v);
  }
  assert.equal(visualization('nope'), null);
});
