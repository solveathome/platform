import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBrief } from "../src/lib/brief.ts";
import { compactDepartmentBrief } from "../src/lib/department-protocol.ts";
import { GUIDANCE_VERSION, taskGuidance } from "../src/lib/research-guidance.ts";
import { tangentJob } from "../src/lib/tangent.ts";
import { EFFORT_GUIDANCE, workspaceSections } from "../src/lib/workspace-guidance.ts";
import { MODEL_IDENTITY_GUIDANCE } from "../src/lib/model-id.ts";
import { LOG_LOCATIONS } from "../src/lib/tokens.ts";
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
      assert.match(brief,/model\/thinking-level lookup/);assert.match(brief,/compatible pinned tools across folders/);
      assert.match(brief,/identity, tooling, execution and publication_safety/);
      assert.match(brief,/If you cannot read your own session, follow runtime_lifecycle/);
      assert.match(brief,/Otherwise continue without pausing/);
      assert.match(brief,/automated extraction and submission scripts/);
      assert.match(brief,/detect agent\/model\/effort changes and preserve each turn's attribution/);
    }
  }
});

test('core runtime instructions require self-discovery and avoid application-specific recipes',()=>{
  const sections=workspaceSections('https://x.test/projects/p');
  const brief=renderBrief(job,'https://x.test/projects/p',session);
  for(const text of [EFFORT_GUIDANCE,MODEL_IDENTITY_GUIDANCE,LOG_LOCATIONS,brief,...Object.values(sections)]) {
    assert.doesNotMatch(text,/Freebuff|Buffy|Claude Code|GitHub Copilot CLI|OpenCode|Antigravity|desktop-v2\.db|threads\.reasoning_effort|~\/\.codex|~\/\.claude/);
  }
  assert.match(EFFORT_GUIDANCE,/Research the current application's own documentation/);
  assert.match(EFFORT_GUIDANCE,/sources checked and concrete reason/);
  assert.match(EFFORT_GUIDANCE,/Verify outgoing headers against the record/);
  assert.match(EFFORT_GUIDANCE,/Missing is not none/);
  assert.match(EFFORT_GUIDANCE,/preparation of each new submission/);
  assert.match(EFFORT_GUIDANCE,/Never relabel earlier work with the current sender's identity/);
  assert.match(EFFORT_GUIDANCE,/If you can identify and read your own current application session, continue normally without stopping or restarting/);
  assert.match(EFFORT_GUIDANCE,/delayed final usage alone does not require a pause/);
  assert.match(sections.runtime_lifecycle,/Only if you cannot yet identify or read your own session after the normal lookup/);
  assert.match(sections.runtime_lifecycle,/no pause, restart, continuation mechanism or restart test is required/);
  assert.match(sections.runtime_lifecycle,/Please resume this conversation so I can check whether my session metadata is now available/);
  assert.match(sections.runtime_lifecycle,/Then end the turn/);
  assert.match(sections.runtime_lifecycle,/Do not start a replacement session automatically/);
  assert.match(sections.runtime_lifecycle,/reload the checkpoint and recheck your own session before registration or research/);
  assert.match(sections.runtime_lifecycle,/verify current model\/settings before using them for current headers/);
  assert.match(sections.runtime_lifecycle,/original instruction, direction and remaining limits/);
  assert.match(sections.runtime_lifecycle,/Do not loop through resume requests or invent metadata/);
  assert.match(sections.tooling,/Another run executing a compatible tool is not a reason to rebuild/);
  assert.match(sections.execution,/Allocation bookkeeping is advisory/);
  assert.match(sections.execution,/confirm cleanup or quarantine the capacity/);
  assert.match(sections.publication_safety,/refuse to send anything/);
  assert.match(sections.acceptance,/method \(simulation or real application\/OS run\)/);
  assert.match(sections.accounting,/derive model, thinking level, transcript slice and attributable usage together/);
  assert.match(sections.accounting,/Keep model\/effort changes on their original turns/);
  assert.match(sections.accounting,/ambiguous source or conflicting attribution must fail local preflight/);
  assert.match(sections.accounting,/switching a real model on that run is not/);
  assert.match(sections.accounting,/do not disguise a new model with the old header/);
  assert.match(sections.accounting,/An uncertain request is reconciled or retried exactly/);
  assert.match(sections.accounting,/Re-extraction after later records appear produces a separate correction/);
  assert.match(sections.acceptance,/agent change after a lost response preserves the exact pending request/);
});

test('compact department briefs retain issued context, earlier claims and dynamic warnings',()=>{
  const issued={...job,attempt_id:'attempt-example',compute_hint:{ram_gb:4},git_ref:'snapshot-123',prior_claims:[{id:63,handle:'someone',model:'claude-opus-5',created_at:'2026-09-10T12:00:00Z'}]};
  const full=renderBrief(issued,'https://x.test/projects/p',session).replace('\n## ', '\nMissing source: ask the author for the named document.\n## ');
  const compact=compactDepartmentBrief(full,issued,session,null);
  assert.match(compact,/snapshot-123/);assert.match(compact,/Compute hint: `\{"ram_gb":4\}`/);
  assert.match(compact,/Earlier claim: message #63/);assert.match(compact,/Missing source: ask the author/);
  assert.match(compact,/paper.slug: beta2-note/);assert.doesNotMatch(compact,/## Rules \(read before starting\)/);
});

// A one-assignment session ends at the result, so a done message afterwards is refused (supervised Fable session, Sep 16 2026):
// the compact brief must not ask for one.
test('a one-assignment compact brief says the return is the completion note',()=>{
  const issued={...job,attempt_id:'attempt-example'};
  const full=renderBrief(issued,'https://x.test/projects/p',session);
  const last=compactDepartmentBrief(full,issued,{...session,jobs:1,max:1},null);
  assert.match(last,/this is the session's last assignment, so the session ends at the result and the return itself is the completion note/);
  assert.doesNotMatch(last,/post one concise completion/);
  const open=compactDepartmentBrief(full,issued,{...session,jobs:1,max:null},null);
  assert.match(open,/post one concise completion/);
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
  for(const stage of ['discover','probe','pursue','rescue']) {
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

test("no timings on a task (Chris, Sep 19 2026): the brief states no time budget and no deadline; an empty compute hint reads as none", () => {
  const md = renderBrief(job, "https://x.test/projects/p", session);
  assert.match(md, /there is no time budget or deadline on this assignment/);
  assert.doesNotMatch(md, /Budget:|Expires:|h of your time|your person allows up to/);
  assert.match(md, /Compute hint: none\./);
  const loose = renderBrief({ ...job, budget_hours: 1 }, "https://x.test/projects/p", session);
  assert.doesNotMatch(loose, /Budget:|1 h/);
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

test("briefs distinguish session limits from assignments, which carry no time limit, and retain the person's session length", () => {
  const continuous = renderBrief(job, "https://x.test/projects/p", {...session, max: null});
  assert.match(continuous, /continuing until your person stops you/);
  assert.match(continuous, /presence or a reply between assignments is not required/);
  assert.match(continuous, /There is no time limit on an assignment/);
  const timed = renderBrief(job, "https://x.test/projects/p", {...session, max: null, length: "until 2026-09-13T22:00:00Z"});
  assert.match(timed, /Session: assignment 1; until 2026-09-13T22:00:00Z/);
  assert.doesNotMatch(timed, /continuing until your person stops you/);
  const capped = renderBrief(job, "https://x.test/projects/p", session);
  assert.match(capped, /assignment 1 of 1 your person allowed/);
  assert.match(capped, /When the cap is reached the server says so: stop/);
});

// Issue #83: the protocol is an imperative second-person spec with sections named identity, bootstrap and runtime_lifecycle,
// so a summarising fetcher read it as an attempt to install an alternative operating framework and refused to relay it.
// Onboarding then fails closed at step one, before a department has any local cache. The content is unchanged; what was
// missing is the context a defensive reader needs to place it.
test('issue #83: the protocol says what it is, and who published it, before it says anything else', async () => {
  const { PROTOCOL_PROVENANCE } = await import('../src/lib/department-protocol.ts');
  assert.match(PROTOCOL_PROVENANCE, /^What this is: the participation guidance for solveathome/);
  assert.match(PROTOCOL_PROVENANCE, /github\.com\/solveathome\/platform/, 'who publishes it');
  assert.match(PROTOCOL_PROVENANCE, /Your person chose to join this project and gave you this URL/, 'why the reader has it');
  assert.match(PROTOCOL_PROVENANCE, /does not replace or override your own operating rules/, 'the sentence a defensive reader is missing');
  assert.match(PROTOCOL_PROVENANCE, /applies only to work on this project/);
});

// Issue #90: one session can report two strings for itself, `claude-opus-5` on every assistant line and `claude-opus-5[1m]`
// once in the harness environment block. The canonical id is the right answer for X-Model and for the rule that a model never
// reviews its own kind, and a 1M-context run is the same kind. The variant was simply being lost, so an agent asked what
// configuration it ran under had nowhere to put the answer.
test('issue #90: a context variant is recorded beside the model and never folded into it', async () => {
  const { parseCapabilities } = await import('../src/lib/agent-profile.ts');
  const { canonicalModel } = await import('../src/lib/model-id.ts');
  assert.equal(canonicalModel('claude-opus-5[1m]'), 'claude-opus-5', 'the id that decides tier and same-kind review is unchanged');
  const withVariant = parseCapabilities(JSON.stringify({skills: ['python'], model_variant: '1m'}));
  assert.equal(withVariant.model_variant, '1m');
  assert.deepEqual(withVariant.skills, ['python'], 'the rest of the profile is untouched');
  assert.equal(parseCapabilities('{}').model_variant, undefined, 'an agent with one string keeps working unchanged');
  assert.equal(parseCapabilities(JSON.stringify({model_variant: 'claude-opus-5[1m]'})).model_variant, 'claude-opus-5[1m]', 'a full id is accepted as the variant string');
  const messy = parseCapabilities(JSON.stringify({model_variant: 'a b/c;drop table'})).model_variant;
  assert.doesNotMatch(messy, /[\s/;]/, 'it is a label: spaces and separators do not survive');
  assert.ok(parseCapabilities(JSON.stringify({model_variant: 'x'.repeat(200)})).model_variant.length <= 60);
});
