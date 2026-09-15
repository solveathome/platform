import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBrief } from "../src/lib/brief.ts";
import { compactDepartmentBrief } from "../src/lib/department-protocol.ts";
import { GUIDANCE_VERSION, taskGuidance } from "../src/lib/research-guidance.ts";
import { tangentJob } from "../src/lib/tangent.ts";
import { readdirSync, readFileSync } from "node:fs";

const job = { id: 78, type: "audit", title: "Audit: beta2-note", brief_md: "paper.slug: beta2-note\n\nAudit it.", git_ref: "main", compute_hint: {}, budget_hours: 3, release_count: 1, last_release_note: "expired: the agent did not return or release it", lane_slug: null, repo_url: "https://example.org/r", expires_at: null };
const session = { id: "s1", jobs: 1, max: 1, maxHours: 2, compute: "not offered", transcriptPreapproved: true };

test('every first and subsequent job requires working local tools and a framework self-review before research',()=>{
  for(const type of ['explore','source','direction','break','measure','formalize','paper','audit','check','review'])for(const jobs of [1,2]) {
    const issued={...job,type},run={...session,jobs,max:null};
    const full=renderBrief(issued,'https://x.test/projects/p',run);
    for(const brief of [full,compactDepartmentBrief(full,issued,run,null),compactDepartmentBrief(full,issued,run,{id:'direction-x',revision:1,words:'Investigate the finite bound.'})]) {
      assert.equal((brief.match(/## Your local research framework/g)??[]).length,1);
      assert.ok(brief.indexOf('## Your local research framework')<brief.indexOf('## The task'));
      assert.match(brief,/self-review your local framework/);assert.match(brief,/Build and validate missing essentials now/);
      assert.match(brief,/before the first research step/);assert.match(brief,/server receipt before marking the result submitted/);
      assert.match(brief,/usage explicitly pending/);assert.match(brief,/section=framework/);
      assert.match(brief,/Preserve sibling runs and their instructions/);
      assert.match(brief,/ALL issued attempts, including those with no submission/);
      assert.match(brief,/normally ending a turn/);
      assert.match(brief,/section=lifecycle/);assert.match(brief,/section=publication/);
    }
  }
});

test('compact department briefs retain issued context, earlier claims and dynamic warnings',()=>{
  const issued={...job,attempt_id:'attempt-example',compute_hint:{ram_gb:4},git_ref:'snapshot-123',prior_claims:[{id:63,handle:'someone',model:'claude-opus-5',created_at:'2026-09-10T12:00:00Z'}]};
  const full=renderBrief(issued,'https://x.test/projects/p',session).replace('\n## ', '\nMissing source: ask the author for the named document.\n## ');
  const compact=compactDepartmentBrief(full,issued,session,null);
  assert.match(compact,/snapshot-123/);assert.match(compact,/Compute hint: `\{"ram_gb":4\}`/);
  assert.match(compact,/Earlier claim: message #63/);assert.match(compact,/Missing source: ask the author/);
  assert.match(compact,/paper.slug: beta2-note/);assert.doesNotMatch(compact,/## Rules \(read before starting\)/);
});

test('all imported project briefs receive current task guidance before operational reference material',()=>{
  const directory=new URL('../projects/twin-primes/briefs/',import.meta.url);
  const names=readdirSync(directory).filter(name=>name.endsWith('.md'));assert.ok(names.length>30);
  for(const name of names) {
    const body=readFileSync(new URL(name,directory),'utf8'),type=/^type: (\w+)$/m.exec(body)[1];
    const md=renderBrief({...job,type,brief_md:body},'https://x.test/projects/p',session);
    assert.ok(md.includes(`Guidance version: ${GUIDANCE_VERSION}`),name);
    assert.ok(md.includes(taskGuidance({type})),name);
    assert.ok(md.indexOf('## The task')<md.indexOf('## Hand documents to other agents'),name);
    assert.ok(md.indexOf('### Success criteria for this assignment')>md.indexOf(body),name);
    assert.doesNotMatch(md,/think step by step|one sub-agent per hypothesis|ensure we get the right answer/i,name);
  }
});

test('research, conflict resolution, execution and judgment have distinct success and stop criteria',()=>{
  for(const stage of ['discover','triage','pursue','rescue']) {
    const focus=taskGuidance({type:'explore',research_stage:stage});
    assert.match(focus,/prior.work|prior work|Search|search/);
    assert.match(focus,/next|experiment|test|uncertainty/);
  }
  assert.match(taskGuidance({type:'check'}),/pass, fail or unable/);
  assert.match(taskGuidance({type:'check',research_stage:'discover'}),/Complete this check once/);
  assert.match(taskGuidance({type:'review'}),/Reuse eligible receipts/);
  assert.match(taskGuidance({type:'explore',research_stage:'consolidate',evidence_return_id:1}),/Reconcile the supplied conflicting observations/);
  assert.match(taskGuidance({type:'source'}),/Stop once the bounded lookup is resolved/);
  assert.match(taskGuidance({type:'formalize'}),/a changed theorem is a separate proposal/i);
  assert.match(taskGuidance({type:'explore',purpose:'work'}),/specified evidence or integration obligation/);
  assert.match(taskGuidance({type:'direction',purpose:'work'}),/Find an uncovered contribution/);
  const followUp=renderBrief({...job,type:'explore',follow_up_of:1,brief_md:'Make the existing claim checkable.'},'https://x.test/projects/p',session);
  assert.match(followUp,/Resolve the stated follow-up obligation/);
  assert.doesNotMatch(followUp,/Find an uncovered contribution/);
});

test('donor tangents use source-first research and resolve ambiguity without a new approval loop',()=>{
  const challenge=tangentJob({kind:'challenge',about:'return:1',says:'This bound needs another assumption.'},'https://x.test/projects/p','donor',1);
  assert.match(challenge.brief_md,/bounded interpretation/);assert.doesNotMatch(challenge.brief_md,/ask them/);
  const direction=tangentJob({kind:'direction',says:'Try a new source-field connection.'},'https://x.test/projects/p','donor',1);
  assert.match(direction.brief_md,/search online/i);assert.match(direction.brief_md,/research.proposal/);
  assert.doesNotMatch(direction.brief_md,/refuted registry|before anything/);
});

test('every served assignment puts global prior work before older task instructions and defers numerical reproduction',()=>{
  for(const type of ['explore','direction','source','break','measure','formalize','paper','audit','review','check']) {
    const task='Older queued task: regenerate the published table.';
    const md=renderBrief({...job,type,brief_md:task},'https://x.test/projects/p',session);
    assert.ok(md.indexOf('Search the global body of work first')>=0&&md.indexOf('Search the global body of work first')<md.indexOf(task),type);
    assert.match(md,/Do not regenerate published counts/);
    assert.match(md,/An assigned validation check executes that scope and reuses the search record/);
    assert.match(md,/If online access is unavailable/);
  }
});

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

test("the brief names the handle's remaining file quota (issue #32) and says a 5xx is not a call that counts (issue #34)", () => {
  const md = renderBrief(job, "https://x.test/projects/p", { ...session, files: { left: 2, bytes_left: 3 * 1048576, per_day: 249 } });
  assert.match(md, /Your handle has 2 of 249 uploads and 3 MB left in the rolling 24 h, shared by all of its sessions/);
  assert.match(md, /A 5xx, a body reading "error code: 502" or a dropped connection is not a call that counts: wait ten seconds/);
  assert.doesNotMatch(renderBrief(job, "https://x.test/projects/p", session), /Your handle has/, "no quota line without the numbers");
});

test("the chat is a chat, not a log: window of 15 and 3 days, read between steps, address agents by name (Chris, Sep 11 2026)", () => {
  const md = renderBrief(job, "https://x.test/projects/p", session);
  assert.match(md, /a chat, not a status feed and not a work log/);
  assert.match(md, /last 15 messages and the unanswered ideas, questions and stuck posts of the last 3 days/);
  assert.match(md, /before you write your return, `GET [^`]*messages\?since=<last_id>` \(no wait/);
  assert.match(md, /Talk to the others by name: `@handle`/);
});

test("an explore brief names request_review and its default (issue #44); other types do not", () => {
  const explore = renderBrief({ ...job, type: "explore" }, "https://x.test/projects/p", session);
  assert.match(explore, /recorded without review unless the body carries `"request_review": true`/);
  assert.match(explore, /request review later for a recorded return, including your own/);
  assert.doesNotMatch(explore, /cannot be added afterwards/);
  assert.doesNotMatch(renderBrief(job, "https://x.test/projects/p", session), /request_review/);
});

test("briefs distinguish session limits from per-assignment budgets and retain timed deadlines", () => {
  const continuous = renderBrief(job, "https://x.test/projects/p", {...session, max: null});
  assert.match(continuous, /continuing until your person stops you/);
  assert.match(continuous, /presence or a reply between assignments is not required/);
  assert.match(continuous, /time budget is per assignment, not the length of the session/);
  const timed = renderBrief(job, "https://x.test/projects/p", {...session, max: null, length: "until 2026-09-13T22:00:00Z"});
  assert.match(timed, /Session: assignment 1; until 2026-09-13T22:00:00Z/);
  assert.doesNotMatch(timed, /continuing until your person stops you/);
  const capped = renderBrief(job, "https://x.test/projects/p", session);
  assert.match(capped, /assignment 1 of 1 your person allowed/);
  assert.match(capped, /When the cap is reached the server says so: stop/);
});
