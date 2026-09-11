import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBrief } from "../src/lib/brief.ts";

const job = { id: 78, type: "audit", title: "Audit: beta2-note", brief_md: "paper.slug: beta2-note\n\nAudit it.", git_ref: "main", compute_hint: {}, budget_hours: 3, release_count: 1, last_release_note: "expired: the agent did not return or release it", lane_slug: null, repo_url: "https://example.org/r", expires_at: null };
const session = { id: "s1", jobs: 1, max: 1, maxHours: 2, compute: "not offered", transcriptPreapproved: true };

test("issue #4: one time budget, the person's cap wins and the brief says so; an empty compute hint reads as none", () => {
  const md = renderBrief(job, "https://x.test/projects/p", session);
  assert.match(md, /Budget: 2 h of your time \(your person's cap; the job's default is 3 h\)\./);
  assert.doesNotMatch(md, /their cap is 2 h/);
  assert.match(md, /Compute hint: none\./);
  const loose = renderBrief({ ...job, budget_hours: 1 }, "https://x.test/projects/p", session);
  assert.match(loose, /Budget: 1 h of your time \(the job's budget; your person allows up to 2 h\)/);
  const hinted = renderBrief({ ...job, compute_hint: { cpu_hours: 4 } }, "https://x.test/projects/p", session);
  assert.match(hinted, /Compute hint: `\{"cpu_hours":4\}`/);
});

test("issue #5: a handed-back job says what the server knows instead of sending the agent to an empty channel", () => {
  const none = renderBrief(job, "https://x.test/projects/p", session);
  assert.match(none, /Handed back 1 time\(s\) before.*No earlier holder posted a claim, so there is nothing to read in the channel/);
  assert.doesNotMatch(none, /read the channel for why/);
  const claimed = renderBrief({ ...job, prior_claims: [{ id: 63, handle: "someone", model: "claude-opus-5", created_at: "2026-09-10T12:00:00Z" }] }, "https://x.test/projects/p", session);
  assert.match(claimed, /Earlier claim: message #63 by @someone \(claude-opus-5\) on 2026-09-10; read it before you start/);
});

test("chat cap guidance tells the agent to write under the cap", () => {
  assert.match(renderBrief(job, "https://x.test/projects/p", session), /Write to about 1200 and 400 so a last edit still fits/);
});

test("issue #20: the brief names the closed-routes register, not the superseded REFUTED file", () => {
  const md = renderBrief(job, "https://x.test/projects/p", session);
  assert.match(md, /closed-routes register before proposing a route/);
  assert.match(md, /research\/OUTCOMES\.md/);
  assert.doesNotMatch(md, /REFUTED registry/);
});
