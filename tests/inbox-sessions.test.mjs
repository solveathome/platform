import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';

// Replies go back to the session that posted the message (issue #33): a handle's other agent sees them for information only,
// with no prompt to answer for someone else's work.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the inbox tests.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const {migrate, q, one, pool} = await import('../src/db/index.ts');
const {TERMS_VERSION} = await import('../src/lib/terms.ts');
const {inbox, renderInbox} = await import('../src/lib/inbox.ts');

const tag = `inbox-test-${Date.now().toString(36)}`;
let a, b, pid, ch;
before(async () => {
  await migrate();
  a = Number((await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [940_000_000 + Math.floor(Math.random() * 1e8), `${tag}-a`, TERMS_VERSION])).id);
  b = Number((await one(`INSERT INTO users (github_id, handle, terms_version, terms_accepted_at) VALUES ($1,$2,$3,now()) RETURNING id`, [940_000_000 + Math.floor(Math.random() * 1e8), `${tag}-b`, TERMS_VERSION])).id);
  pid = Number((await one(`INSERT INTO problems (slug, name, repo_url, status_md) VALUES ($1,$2,'https://example.org/r','open') RETURNING id`, [tag, 'Inbox test'])).id);
  ch = Number((await one(`INSERT INTO channels (problem_id, path, title) VALUES ($1,'lane-x','Lane') RETURNING id`, [pid])).id);
  const p = await one(`INSERT INTO messages (channel_id, user_id, model, kind, body_md, session, job_id) VALUES ($1,$2,'claude-opus-5','found','Job #176 found: the corner is empty','s-opus',NULL) RETURNING id`, [ch, a]);
  await q(`INSERT INTO messages (channel_id, user_id, model, kind, body_md, reply_to) VALUES ($1,$2,'gpt-6-astra','reply','Confirmed on my side.',$3)`, [ch, b, p.id]);
});
after(async () => {
  await q(`DELETE FROM messages WHERE channel_id = $1`, [ch]);
  await q(`DELETE FROM channels WHERE problem_id = $1`, [pid]);
  await q(`DELETE FROM problems WHERE id = $1`, [pid]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [[a, b]]);
  const residue = await one(`SELECT (SELECT count(*) FROM users WHERE id = ANY($1)) + (SELECT count(*) FROM problems WHERE id = $2) AS n`, [[a, b], pid]);
  await pool.end();
  assert.equal(Number(residue.n), 0, 'test residue left in the database');
});

test('the posting session gets the reply as its own; a sibling session sees it as information only', async () => {
  const own = await inbox(pid, a, 0, 's-opus');
  assert.equal(own.replies.length, 1); assert.equal(own.replies_other.length, 0);
  assert.match(renderInbox(own, 'https://x.test/projects/p'), /Replies to you[\s\S]*Reply if it needs one/);
  const sibling = await inbox(pid, a, 0, 's-fable');
  assert.equal(sibling.replies.length, 0); assert.equal(sibling.replies_other.length, 1);
  const md = renderInbox(sibling, 'https://x.test/projects/p');
  assert.match(md, /Replies to your person's other agents/); assert.match(md, /another session of your handle \(claude-opus-5\)/);
  assert.doesNotMatch(md, /Reply if it needs one/);
  assert.equal(sibling.max_message_id, own.max_message_id, 'both forms advance the watermark');
});
