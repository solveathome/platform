// No job title opens with its kind (Chris, Sep 25 2026, #sah-route-triage-title: "Make sure we have step labels types and apply those. Never
// ever prefix tiles with <type>:"). The kind is data (type, research stage, follow-up) and renders as a label beside the title.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
const {JOB_KIND_LABELS, jobLabel, jobKind, withoutKindPrefix} = await import('../src/lib/research-format.ts');
const {tangentJob} = await import('../src/lib/tangent.ts');
const {POINTS} = await import('../src/lib/credit.ts');

// Every label, every job type, and the prefixes titles carried before (Triage, Pursue, Leads, Make checkable, Rescue investigation).
const WORDS = [...new Set([...Object.values(JOB_KIND_LABELS), ...Object.keys(JOB_KIND_LABELS), ...Object.keys(POINTS.result), 'Triage', 'Pursue', 'Leads', 'Make checkable', 'Rescue investigation', 'Probe'])];
const PREFIX = new RegExp(`^(${WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}): `, 'i');
const walk = (dir) => readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

test('every job type and route step has a label, and review triage is the only triage', () => {
  for (const type of [...Object.keys(POINTS.result), 'triage', 'check']) assert.ok(JOB_KIND_LABELS[jobKind({type})], `no label for type ${type}`);
  assert.equal(jobLabel({type: 'explore', research_stage: 'first_look'}), 'First look');
  assert.equal(jobLabel({type: 'explore', research_stage: 'triage'}), 'First look', 'a route row the previous container wrote');
  assert.equal(jobLabel({type: 'triage'}), 'Review triage');
  assert.deepEqual(Object.values(JOB_KIND_LABELS).filter(l => /triage/i.test(l)), ['Review triage']);
});

test('a tangent is titled with the person\'s words, not its kind', () => {
  for (const kind of ['challenge', 'direction']) {
    const j = tangentJob({kind, says: 'Direction: my own words stay', about: undefined}, 'https://example.org/projects/x', 'someone', 2);
    assert.equal(j.title, 'Direction: my own words stay'.slice(0, 120), 'the person\'s words are kept whole, and nothing is put in front of them');
  }
});

test('no checked-in brief is titled with its kind', () => {
  for (const f of walk('projects').filter(f => /\/briefs\/[^/]+\.md$/.test(f))) {
    const title = /^title:\s*(.*)$/m.exec(readFileSync(f, 'utf8'))?.[1] ?? '';
    assert.doesNotMatch(title, PREFIX, f);
  }
});

test('no code that makes a job writes a kind prefix into its title', () => {
  for (const f of [...walk('src'), ...walk('scripts')].filter(f => /\.(ts|mjs)$/.test(f))) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/INSERT INTO jobs[\s\S]*?\]\)/g)) {
      for (const lit of m[0].matchAll(/[`"']([^`"'$]*)/g)) assert.doesNotMatch(lit[1], PREFIX, `${f}: ${m[0].slice(0, 120)}`);
    }
    for (const lit of src.matchAll(/title(?:: | = )`([^`$]*)/g)) assert.doesNotMatch(lit[1], PREFIX, `${f}: title \`${lit[1]}\``);
  }
});

test('a title read from a report heading loses a leading kind, and nothing else', () => {
  assert.equal(withoutKindPrefix('Audit: `research/SEARCH-CONVENTIONS.md`'), '`research/SEARCH-CONVENTIONS.md`');
  assert.equal(withoutKindPrefix('Triage: the two dials'), 'The two dials');
  assert.equal(withoutKindPrefix('Break the bound: Lemma 2'), 'Break the bound: Lemma 2');
  assert.equal(withoutKindPrefix('Theorem 5.5: inert at (D1)'), 'Theorem 5.5: inert at (D1)');
  assert.equal(withoutKindPrefix('x'), 'x', 'a title with no kind is left exactly as written');
});


const {jobPresentation} = await import('../src/lib/job-presentation.ts');
test('public review context names the actual subject while retaining claim attribution and original titles', () => {
  const j={type:'review',title:'Review return #7',source_title:'Prime-window bounds',subject_return_id:7,source_report_md:'# Job #42 (route 3, pursue): a smaller window satisfies the bound\n\nNot an asymptotic result.'};
  const p=jobPresentation(j);
  assert.equal(p.title,'Prime-window bounds');
  assert.match(p.what,/Checking the author.s claim: a smaller window satisfies the bound/);
  assert.match(p.why,/what the evidence supports/);
  assert.equal(j.title,'Review return #7');
  assert.equal(p.subject_return_id,7);
  assert.equal(jobPresentation({...j,type:'triage',title:'Triage return #7'}).title,'Prime-window bounds');
  assert.match(jobPresentation({...j,type:'check'}).what,/Independently checking/);
});
test('pursuit context reads only the issued experiment and comparison context never promises execution', () => {
  const step={question:'Can the bound hold uniformly?',success:'A bound for every specified window.',compute:{ram_gb:2}};
  const j={type:'explore',research_stage:'pursue',title:'Window bound',brief_md:'The step:\n'+JSON.stringify(step)};
  assert.equal(jobPresentation(j).what,step.question);
  assert.match(jobPresentation(j).why,/aims to establish: A bound/);
  assert.match(jobPresentation({...j,research_stage:'first_look',step_check_of:12}).why,/before spending compute/);
  assert.match(jobPresentation({type:'audit',requires_trust:true,title:'Document correction'}).why,/Correct required review findings/);
  assert.equal(jobPresentation({type:'explore',title:'A distinct subject'}).title,'A distinct subject');
});

test('derived context redacts historical private diagnostics before excerpts and preserves scientific numbers',()=>{
  const p=jobPresentation({type:'review',title:'Review return #7',source_title:'Bound',source_report_md:'# Job #42: L_F and r_A(m), bound 12345678901234567890, run-0123456789abcdef and attempt 0123456789abcdef0123456789abcdef'});
  assert.match(p.what,/12345678901234567890/);assert.match(p.what,/REDACTED/);
  assert.match(p.what,/L_F and r_A\(m\)/);
  assert.doesNotMatch(p.what,/run-0123456789abcdef|attempt 0123456789abcdef0123456789abcdef/);
});
