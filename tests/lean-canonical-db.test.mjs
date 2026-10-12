import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';

// lean_identity_canonical moved from a recursive SQL function to PL/pgSQL for speed (Oct 12 2026, #sah-perf-sweep): every stored
// Lean binding hashes its output, so it must stay byte for byte what the SQL definition produced. The old definition runs here as
// a session-local function and both are compared on nested, escaped, unicode, numeric and empty documents. Creates no rows.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the Lean canonical JSON test.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const {migrate, pool} = await import('../src/db/index.ts');
let c;
before(async () => {
  await migrate();
  c = await pool.connect();
  await c.query(`CREATE FUNCTION pg_temp.canonical_sql(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT CASE jsonb_typeof(value)
      WHEN 'object' THEN '{'||coalesce((SELECT string_agg(to_json(key)::text||':'||pg_temp.canonical_sql(val),',' ORDER BY key COLLATE "C") FROM jsonb_each(value) AS item(key,val)),'')||'}'
      WHEN 'array' THEN '['||coalesce((SELECT string_agg(pg_temp.canonical_sql(val),',' ORDER BY ordinal) FROM jsonb_array_elements(value) WITH ORDINALITY AS item(val,ordinal)),'')||']'
      ELSE value::text END;
  $$`);
});
after(async () => { c?.release(); await pool.end(); });

const docs = [
  {}, [], null, 0, -1.5e3, 2.50, true, 'plain', 'quote " backslash \\ tab \t newline \n', 'unicode é ü 漢 😀',
  {b: 1, a: [1, {z: null, A: 'x'}], 'é': 2.5, aa: true, B: [], '': {}},
  [[], {}, '', [[[1]]], {x: [{y: {z: [null, false]}}]}],
  {policy: 'lean-comparator-v2', scientific_identity: {schema: 'solveathome-lean-scientific-v2', claims: Array.from({length: 40}, (_, i) => ({id: `c${i}`, declaration: `Thm.n${i}`, sha256: 'a'.repeat(64)}))}},
  {'key with space': 1, 'Z': 2, 'a': 3, '10': 4, '9': 5, '_': 6, '~': 7},
];

test('PL/pgSQL canonical JSON equals the SQL definition it replaced, and its bindings agree', async () => {
  for (const d of docs) {
    const {rows: [r]} = await c.query(`SELECT lean_identity_canonical($1::jsonb) AS now, pg_temp.canonical_sql($1::jsonb) AS was,
      lean_identity_binding('solveathome-test', $1::jsonb) AS binding, encode(sha256(convert_to('solveathome-test'||E'\\n'||pg_temp.canonical_sql($1::jsonb),'UTF8')),'hex') AS was_binding`, [JSON.stringify(d)]);
    assert.equal(r.now, r.was, JSON.stringify(d).slice(0, 80));
    assert.equal(r.binding, r.was_binding);
  }
  assert.equal((await c.query(`SELECT lean_identity_canonical(NULL) AS v`)).rows[0].v, null, 'still STRICT');
});
