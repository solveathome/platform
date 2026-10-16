import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import pg from 'pg';

// Yield per model per million tokens (Oct 16 2026). The schema gives the query its model functions (lean_model_family,
// canon_model); the fixtures live only in a connection-local temp table that shadows returns, so nothing is written to the real tables.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the model yield tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const {migrate, pool} = await import('../src/db/index.ts');
const {YIELD_SQL, USAGE_STATUS_SQL, perMillion, isThin} = await import('../src/lib/yield.ts');
const {usageStatus} = await import('../src/lib/tokens.ts');
const db = new pg.Client({connectionString: process.env.TEST_DATABASE_URL});

const T = (input, output, extra = {}) => JSON.stringify({input, output, cache_read: 0, cache_write: 0, source: 'claude-jsonl', ...extra});
before(async () => {
  await migrate(); await pool.end();
  await db.connect();
  await db.query(`CREATE TEMP TABLE returns (id bigint, problem_id bigint, model text, status text, final_rung text, tokens jsonb)`);
  await db.query(`INSERT INTO returns VALUES
    (1, 1, 'claude-opus-5-5', 'accepted', 'proven',   $1),
    (2, 1, 'claude-opus-5-5', 'accepted', 'verified', $2),
    (3, 1, 'claude-fable-5-1', 'rejected', null,      $3),
    (4, 1, 'claude-opus-5-5', 'accepted', 'measured', null),
    (5, 1, 'gpt-6-astra',     'recorded', null,       $4),
    (6, 1, 'gpt-6-astra',     'accepted', 'verified', $5),
    (7, 1, 'chatgpt-unmeasured', 'accepted', 'heuristic', $6),
    (8, 2, 'claude-opus-5-5', 'accepted', 'proven',   $1)`,
    [T(400_000, 100_000, {cache_read: 500_000}), T(1_000_000, 0), T(0, 500_000), JSON.stringify({input: 600_000, output: 0, cache_read: 0, cache_write: 0, source: 'reported'}),
     JSON.stringify({input: 0, output: 0, cache_read: 0, cache_write: 0, source: 'none', log: 'summary', unmeasured: 'no record'}),
     JSON.stringify({input: 0, output: 0, cache_read: 0, cache_write: 0, source: 'none', log: 'mcp-observed'})]);
});
after(async () => { await db.end(); });

test('accepted results by rung per family and model per million tokens, counting only returns that carry usage, one project at a time', async () => {
  const rows = (await db.query(YIELD_SQL, [1])).rows;
  const all = rows.find(r => r.project_total);
  assert.equal(all.returns, 7); assert.equal(all.with_usage, 4); assert.equal(all.missing, 1); assert.equal(all.unmeasured, 2); assert.equal(all.reported, 1);
  assert.equal(all.tokens, 3_100_000); assert.equal(all.cache_read, 500_000); assert.equal(all.accepted, 5); assert.equal(all.accepted_with_usage, 2);
  const anthropic = rows.find(r => r.family === 'anthropic' && r.model === null);
  assert.equal(anthropic.returns, 4); assert.equal(anthropic.with_usage, 3); assert.equal(anthropic.missing, 1); assert.equal(anthropic.tokens, 2_500_000);
  assert.equal(anthropic.accepted, 3); assert.equal(anthropic.accepted_with_usage, 2);       // return 4 is accepted but carries no usage: in the board's count, not in the rate
  assert.equal(anthropic.proven, 1); assert.equal(anthropic.measured, 1); assert.equal(anthropic.measured_with_usage, 0); assert.equal(anthropic.verified_with_usage, 1);
  assert.equal(perMillion(anthropic.accepted_with_usage, anthropic.tokens), 0.8);
  const opus = rows.find(r => r.model === 'claude-opus-5-5');
  assert.equal(opus.family, 'anthropic'); assert.equal(opus.returns, 3); assert.equal(opus.tokens, 2_000_000);
  const openai = rows.find(r => r.family === 'openai' && r.model === null);
  assert.equal(openai.with_usage, 1); assert.equal(openai.reported, 1); assert.equal(openai.unmeasured, 1); assert.equal(openai.accepted_with_usage, 0);
  assert.equal(rows.find(r => r.family === 'other' && r.model === null).unmeasured, 1);   // a chat label names no lineage
  assert.ok(isThin(anthropic));
  assert.equal(rows[0].project_total, true);                                               // the project row first, then each family before its models
  assert.equal((await db.query(YIELD_SQL, [2])).rows.find(r => r.project_total).returns, 1);
});

test('the SQL usage rule and usageStatus in tokens.ts agree', async () => {
  const cases = [null, {input: 0, output: 0, source: 'none'}, {input: 5, output: 1, source: 'reported'}, {input: 5, output: 1, source: 'codex-jsonl'}, {input: 0, output: 0, cache_read: 9, source: 'claude-jsonl'},
    {input: 0, output: 0, source: 'none', log: 'mcp-observed'}, {input: 0, output: 0, source: 'none', unmeasured: 'no record'}, {input: 0, output: 0, source: 'claude-jsonl', already_counted: {entries: 1, of: 1, on: []}},
    {input: 0, output: 0, source: 'claude-jsonl', mismatch: {reason: 'x', job: 1}}];
  for (const c of cases) {
    const sql = (await db.query(`SELECT ${USAGE_STATUS_SQL('$1::jsonb')} AS s`, [c === null ? null : JSON.stringify(c)])).rows[0].s;
    assert.equal(sql, usageStatus(c), JSON.stringify(c));
  }
});
