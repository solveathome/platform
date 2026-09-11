import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';

// Points reward the work you integrated with (Chris, Sep 11 2026): a review earns a share of what it judged scaled by depth,
// an integrated revision pays, and a tier-1 model at a top thinking level pays 25% more. Runs against a real Postgres; cleans up.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the credit tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {payAcceptedReturn, payRejectedReturn, frontierMultiplier, POINTS} = await import('../src/lib/credit.ts');

const tag = `credit-test-${Date.now().toString(36)}`;
let author, reviewer, pid;
const tierRowsBefore = new Set((await q(`SELECT model FROM model_tiers`)).map(r => r.model));

before(async () => {
  await migrate();
  author = Number((await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), `${tag}-author`, TERMS_VERSION])).id);
  reviewer = Number((await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [900_000_000 + Math.floor(Math.random() * 1e8), `${tag}-reviewer`, TERMS_VERSION])).id);
  pid = Number((await one(`INSERT INTO problems (slug, name, repo_url, status_md) VALUES ($1,$2,'https://example.org/r','open') RETURNING id`, [tag, 'Credit test'])).id);
});
after(async () => {
  await q(`DELETE FROM credits WHERE user_id = ANY($1)`, [[author, reviewer]]);
  await q(`DELETE FROM document_versions WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM reputation WHERE user_id = ANY($1)`, [[author, reviewer]]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [[author, reviewer]]);
  const now = (await q(`SELECT model FROM model_tiers`)).map(r => r.model).filter(m => !tierRowsBefore.has(m));
  if (now.length) await q(`DELETE FROM model_tiers WHERE model = ANY($1)`, [now]);
  const residue = await one(`SELECT (SELECT count(*) FROM credits WHERE user_id = ANY($1)) + (SELECT count(*) FROM users WHERE id = ANY($1)) + (SELECT count(*) FROM problems WHERE id = $2) AS n`, [[author, reviewer], pid]);
  await pool.end();
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

const mkReturn = async (type, model, effort, extra = {}) => one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status, effort, revision_path, revision_sha) VALUES ($1,$2,$3,$4,'anthropic','r','t','accepted',$5,$6,$7) RETURNING *`, [pid, type, author, model, effort, extra.revision_path ?? null, extra.revision_sha ?? null]);
const sum = async (rid, kind) => Number((await one(`SELECT coalesce(sum(points), 0) AS p FROM credits WHERE source_type = 'return' AND source_id = $1 AND kind = $2`, [String(rid), kind])).p);

test('frontier premium applies to a tier-1 model at a top thinking level only', async () => {
  assert.equal(await frontierMultiplier('claude-fable-5-1', 'max'), 1.25);
  assert.equal(await frontierMultiplier('claude-fable-5-1', 'low'), 1, 'a frontier model at low effort judges at tier 2 and earns no premium');
  assert.equal(await frontierMultiplier('claude-opus-5', 'max'), 1);
  assert.equal(await frontierMultiplier(null, null), 1);
});

test('an integrated audit by a frontier model: result with premium, integration bonus, and a rerun review paid as a share', async () => {
  const sha = 'b'.repeat(64);
  const ret = await mkReturn('audit', 'claude-fable-5-1', 'max', {revision_path: 'paper/x.md', revision_sha: sha});
  await q(`INSERT INTO document_versions (problem_id, path, version, content_sha, return_id, author_user_id, verified_by, summary, diff) VALUES ($1,'paper/x.md',2,$2,$3,$4,'[]','','')`, [pid, sha, ret.id, author]);
  await payAcceptedReturn(ret, [{user_id: reviewer, verdict: 'accept', model: 'claude-opus-5', provider: 'anthropic', verification: 'rerun', effort: 'high'}]);
  assert.equal(await sum(ret.id, 'result'), 75, 'audit 60 × 1.25');
  assert.equal(await sum(ret.id, 'integrated'), POINTS.integrated);
  assert.equal(await sum(ret.id, 'review'), 30, '25% of 60, × 2 for a rerun, no premium for Opus');
});

test('a read review of a source by a frontier model at max hits the floor; a spot check of a paper by the same pays 47', async () => {
  const src = await mkReturn('source', 'claude-opus-5', 'high');
  await payAcceptedReturn(src, [{user_id: reviewer, verdict: 'accept', model: 'claude-fable-5-1', provider: 'anthropic', verification: 'read', effort: 'max'}]);
  assert.equal(await sum(src.id, 'result'), 15, 'no premium for Opus');
  assert.equal(await sum(src.id, 'review'), 5, '15 × 0.25 × 1 × 1.25 = 4.7, floored to 5');
  assert.equal(await sum(src.id, 'integrated'), 0, 'nothing integrated');
  const paper = await mkReturn('paper', 'claude-opus-5', 'high');
  await payAcceptedReturn(paper, [{user_id: reviewer, verdict: 'accept', model: 'claude-fable-5-1', provider: 'anthropic', verification: 'spot', effort: 'max'}, {user_id: reviewer, verdict: 'reject', model: 'gpt-6-astra', provider: 'openai', verification: 'read', effort: 'max'}]);
  assert.equal(await sum(paper.id, 'review'), 47, '100 × 0.25 × 1.5 × 1.25 = 46.9; the disagreeing review earns nothing');
});

test('a correct rejection pays the reviewer who called it, once; the author and the disagreeing reviewer get nothing', async () => {
  const rej = await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'audit',$2,'claude-fable-5-1','anthropic','r','t','rejected') RETURNING *`, [pid, author]);
  const votes = [{user_id: reviewer, verdict: 'reject', model: 'gpt-6-astra', provider: 'openai', verification: 'read', effort: 'xhigh'}, {user_id: author, verdict: 'accept', model: 'claude-opus-5', provider: 'anthropic', verification: 'read', effort: 'high'}];
  await payRejectedReturn(rej, votes); await payRejectedReturn(rej, votes);
  assert.equal(await sum(rej.id, 'result'), 0, 'no result points on a rejection');
  assert.equal(Number((await one(`SELECT coalesce(sum(points),0) AS p FROM credits WHERE source_type = 'return' AND source_id = $1 AND kind = 'review' AND user_id = $2`, [String(rej.id), reviewer])).p), 19, '60 × 0.25 × 1 × 1.25 = 18.75, once');
  assert.equal(Number((await one(`SELECT coalesce(sum(points),0) AS p FROM credits WHERE source_type = 'return' AND source_id = $1 AND kind = 'review' AND user_id = $2`, [String(rej.id), author])).p), 0, 'the accept vote did not match');
});
