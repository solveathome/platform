import assert from 'node:assert/strict';
import {test} from 'node:test';

// Announcements (#sah-discord-announcer): which acceptances are candidates, how the post reads, what agent text is allowed to do in it.
const {candidateKind, buildPost, quoteSafe, texToUnicode, overclaim, announceConfig, webhookUrl, announceEnabled, ANNOUNCE_DEFAULTS} = await import('../src/lib/announce.ts');

test('candidate kinds come from the final record, never the author', () => {
  assert.equal(candidateKind({type: 'formalize', final_rung: 'proven'}), 'proof');
  assert.equal(candidateKind({type: 'explore', final_rung: 'proven'}), 'proof');
  assert.equal(candidateKind({type: 'break', final_rung: 'refuted'}), 'refutation');
  assert.equal(candidateKind({type: 'explore', final_rung: 'refuted'}), null);
  assert.equal(candidateKind({type: 'challenge', final_rung: 'measured', finding: 'holds'}), 'challenge');
  assert.equal(candidateKind({type: 'challenge', final_rung: 'measured', finding: 'partial'}), null);
  assert.equal(candidateKind({type: 'measure', final_rung: 'verified'}, 'pass'), 'verified');
  assert.equal(candidateKind({type: 'measure', final_rung: 'verified'}, 'not_attempted'), null, 'verified without an independent pass is not news');
  assert.equal(candidateKind({type: 'explore', final_rung: 'measured'}), 'opening');
  assert.equal(candidateKind({type: 'explore', final_rung: 'heuristic'}), null);
  assert.equal(candidateKind({type: 'direction', final_rung: 'conjectured'}), 'opening');
  assert.equal(candidateKind({type: 'audit', final_rung: 'measured'}), null);
});

test('the post names the finder only, leads with the rung and who decided, and links back', () => {
  const p = buildPost({kind: 'proof', final_rung: 'proven', return_id: 42, type: 'formalize', handle: 'finder', slug: 'twin-primes', base: 'https://solveathome.org', decided_at: '2026-09-26T10:00:00Z', route: {id: 7, title: 'Bound on $G_2(x)$'}, note: 'Lemma 3 is proved for $x \\ge 2$.'});
  assert.match(p.title, /^Proved: accepted at Proven by a trusted reviewer/);
  assert.match(p.description, /^Found by \*\*\[@finder\]\(https:\/\/solveathome\.org\/@finder\)\*\*\./);
  assert.match(p.description, /Return #42 \(formalize\), route #7 “Bound on G₂\(x\)”/);
  assert.match(p.description, /Validator's note: “Lemma 3 is proved for x ≥ 2\.”/);
  assert.match(p.description, /Decided 2026-09-26\. Decisions can be revisited/);
  assert.equal(p.url, 'https://solveathome.org/projects/twin-primes/return/42');
  const r = buildPost({kind: 'refutation', final_rung: 'refuted', return_id: 5, type: 'break', handle: 'b', slug: 's', base: 'http://x', decided_at: new Date(), target_return_id: 3});
  assert.match(r.description, /the claim in return #3 does not hold/);
  assert.doesNotMatch(r.description, /Validator's note/, 'no note, no line');
  const o = buildPost({kind: 'opening', final_rung: 'measured', return_id: 1, type: 'explore', handle: 'h', slug: 's', base: 'http://x', decided_at: new Date()});
  assert.match(o.title, /accepted at Measured by a trusted reviewer/);
});

test('agent text in a post: mentions broken, links and Markdown defused, TeX to Unicode or code, capped', () => {
  assert.equal(quoteSafe('ping @everyone', 50), 'ping @​everyone');
  assert.equal(quoteSafe('see [here](https://evil.example)', 50), 'see here');
  assert.doesNotMatch(quoteSafe('go to https://evil.example now', 80), /https:\/\//);
  assert.equal(quoteSafe('**bold** _it_', 50), '\\*\\*bold\\*\\* \\_it\\_');
  assert.equal(quoteSafe('a $\\weirdmacro{x}$ b', 50), 'a `\\weirdmacro{x}` b');
  assert.equal([...quoteSafe('x'.repeat(300), 200)].length, 200);
  assert.deepEqual(texToUnicode('x^{2} \\le \\sqrt{n} \\cdot \\log x'), {text: 'x² ≤ √n · log x', clean: true});
  assert.deepEqual(texToUnicode('\\frac{a}{bc}'), {text: 'a/(bc)', clean: true});
  assert.equal(texToUnicode('\\mathbb{N}').text, 'ℕ');
});

test('the phrase filter flags wording that says more than the record', () => {
  assert.ok(overclaim('This proves the twin prime conjecture'));
  assert.ok(overclaim('A breakthrough on the gap'));
  assert.equal(overclaim('Lemma 3 holds at Proven for x >= 2'), null);
});

test('config: off unless turned on; defaults are the proposal\'s; a webhook is https or a local stub', () => {
  assert.deepEqual(announceConfig(null), ANNOUNCE_DEFAULTS);
  assert.equal(announceConfig({slug: 'x', announce: {discord: true}}).discord, true);
  assert.equal(announceConfig({slug: 'x', announce: {discord: true, approval: false, hold_hours: 0}}).hold_hours, 0);
  assert.equal(announceConfig({slug: 'x', announce: {webhook_env: 'lower-case'}}).webhook_env, 'DISCORD_PROGRESS_WEBHOOK_URL');
  const cfg = announceConfig(null);
  assert.equal(webhookUrl(cfg, {}), null);
  assert.equal(webhookUrl(cfg, {DISCORD_PROGRESS_WEBHOOK_URL: 'http://evil.example/hook'}), null);
  assert.ok(webhookUrl(cfg, {DISCORD_PROGRESS_WEBHOOK_URL: 'http://127.0.0.1:9/hook'}));
  assert.ok(webhookUrl(cfg, {DISCORD_PROGRESS_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc'}));
});

test('the kill switch: ANNOUNCE_ENABLED=0 (or false, off, no) stops every pass', () => {
  const was = process.env.ANNOUNCE_ENABLED;
  try {
    delete process.env.ANNOUNCE_ENABLED; assert.equal(announceEnabled(), true);
    for (const v of ['0', 'false', 'OFF', 'no']) { process.env.ANNOUNCE_ENABLED = v; assert.equal(announceEnabled(), false, v); }
  } finally { if (was === undefined) delete process.env.ANNOUNCE_ENABLED; else process.env.ANNOUNCE_ENABLED = was; }
});
