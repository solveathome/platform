import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import express from 'express';

// The contributor page's ledger resolves what a review credit judged whether the credit's source is a review job id or
// 'r<return id>' (a self-assigned review has no job). One such row took every profile down with a 500 on Sep 11 2026.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the ledger tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BASE_URL = process.env.BASE_URL ?? 'http://localhost:0';

const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {root} = await import('../src/routes/board.ts');

const tag = `ledger-test-${Date.now().toString(36)}`;
let server, base, uid, pid, jobId, retId;

before(async () => {
  await migrate();
  uid = Number((await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [930_000_000 + Math.floor(Math.random() * 1e8), tag, TERMS_VERSION])).id);
  pid = Number((await one(`INSERT INTO problems (slug, name, repo_url, status_md) VALUES ($1,$2,'https://example.org/r','open') RETURNING id`, [tag, 'Ledger test'])).id);
  retId = Number((await one(`INSERT INTO returns (problem_id, type, user_id, model, provider, report_md, transcript, status) VALUES ($1,'source',$2,'m','p','x','t','accepted') RETURNING id`, [pid, uid])).id);
  jobId = Number((await one(`INSERT INTO jobs (problem_id, type, title, brief_md, git_ref, compute_hint, budget_hours, min_tier, quorum, status, parent_return_id) VALUES ($1,'review','Review','b','main','{}',1,1,1,'accepted',$2) RETURNING id`, [pid, retId])).id);
  await q(`INSERT INTO credits (user_id, problem_id, kind, points, source_type, source_id, note) VALUES ($1,$2,'review',5,'review',$3,'by job'), ($1,$2,'tokens',0.5,'review',$4,'self-assigned'), ($1,$2,'result',15,'return',$5,'accepted')`, [uid, pid, String(jobId), `r${retId}`, String(retId)]);
  const app = express(); app.use(express.json()); app.use('/', root);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.close();
  await q(`DELETE FROM credits WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM jobs WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM returns WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM reputation WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM users WHERE id = $1`, [uid]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE id = $1) + (SELECT count(*) FROM credits WHERE user_id = $1) + (SELECT count(*) FROM problems WHERE id = $2) AS n`, [uid, pid]);
  await pool.end();
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

test('the profile JSON renders with a self-assigned review credit in the ledger, and names what each review judged', async () => {
  const r = await fetch(`${base}/@${tag}`, {headers: {accept: 'application/json'}});
  const t = await r.text(); assert.equal(r.status, 200, t);
  const j = JSON.parse(t);
  const byNote = Object.fromEntries(j.credit.ledger.map(c => [c.note, c]));
  assert.equal(Number(byNote['by job'].review_of), retId);
  assert.equal(Number(byNote['self-assigned'].review_of), retId);
  assert.equal(byNote['accepted'].review_of, null);
  assert.equal(j.credit.total, 20.5);
});
