import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {isoTime, timeHtml} from '../src/lib/timestamps.ts';
import {sourceDates} from '../scripts/source-dates.ts';

// Temporary history uses the repository's configured human identity so local attribution guards stay enabled.
function fixtureIdentity(key,env) {
  try {return execFileSync('git',['config','--get',key],{env,encoding:'utf8',stdio:'pipe'}).trim();}
  catch {return key==='user.name' ? 'Fixture' : 'fixture@example.test';}
}

test('exact timestamps normalize offsets and Date objects, preserving milliseconds and unknowns', () => {
  assert.equal(isoTime('2026-09-01T15:10:20.123+02:00'), '2026-09-01T13:10:20.123Z');
  assert.match(timeHtml(new Date('2026-09-01T13:10:20.123Z')), /datetime="2026-09-01T13:10:20.123Z">2026-09-01 13:10:20.123 UTC/);
  for (const value of [undefined, null, '', 'invalid', new Date(NaN)]) assert.equal(timeHtml(value), 'not recorded');
});

test('source dates follow renames, detect uncommitted bytes, and do not use filesystem dates', () => {
  const root = mkdtempSync(join(tmpdir(), 'sah-source-dates-'));
  // Inside a git hook (the pre-push gate run from a linked worktree) git exports GIT_DIR, GIT_INDEX_FILE and friends, and
  // `git -C <tmp>` obeys them: on Sep 18 2026 this fixture initialised, configured and committed into the real repository
  // (core.bare = true, user "Fixture", two commits on the pushing branch). The fixture's git never sees the caller's repository.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', env: clean}).trim();
  const commit = date => execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture'], {env: {...clean, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date}});
  try {
    git('init', '-q'); git('config', 'user.name', fixtureIdentity('user.name',clean)); git('config', 'user.email', fixtureIdentity('user.email',clean));
    writeFileSync(join(root, 'original.md'), '# First\n'); git('add', '.'); commit('2026-01-02T03:04:05+02:00');
    const first = git('rev-parse', 'HEAD');
    git('mv', 'original.md', 'renamed.md'); commit('2026-02-03T04:05:06Z');
    const dates = sourceDates(root, 'renamed.md', '# Public edition\n');
    assert.equal(dates.created_at, '2026-01-02T01:04:05.000Z');
    assert.equal(dates.modified_at, '2026-02-03T04:05:06.000Z');
    assert.equal(dates.first_commit, first);
    assert.equal(dates.state, 'committed'); assert.equal(dates.public_edition, true);
    writeFileSync(join(root, 'renamed.md'), '# Uncommitted revision\n');
    const dirty = sourceDates(root, 'renamed.md', '# Uncommitted revision\n');
    assert.equal(dirty.created_at, dates.created_at); assert.equal(dirty.modified_at, null); assert.equal(dirty.state, 'uncommitted');
    writeFileSync(join(root, 'new.md'), '# New\n');
    assert.equal(sourceDates(root, 'new.md', '# New\n').created_at, null);
  } finally { rmSync(root, {recursive: true, force: true}); }
});


test('publication preserves original author dates separately from commit dates',()=>{
  const root=mkdtempSync(join(tmpdir(),'sah-author-dates-'));
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));
  const git=(...args)=>execFileSync('git',['-C',root,...args],{env,stdio:'pipe'});
  try {
    git('init','-q');git('config','user.name',fixtureIdentity('user.name',env));git('config','user.email',fixtureIdentity('user.email',env));
    writeFileSync(join(root,'note.md'),'Evidence\n');git('add','.');
    execFileSync('git',['-C',root,'commit','-qm','fixture'],{env:{...env,GIT_AUTHOR_DATE:'2026-01-02T03:04:05Z',GIT_COMMITTER_DATE:'2026-02-03T04:05:06Z'}});
    const previousGitDir=process.env.GIT_DIR;
    process.env.GIT_DIR=join(root,'not-this-repository');
    let d;try {d=sourceDates(root,'note.md','Evidence\n');} finally {if(previousGitDir===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=previousGitDir;}
    
    assert.equal(d.created_at,'2026-02-03T04:05:06.000Z');
    assert.equal(d.author_created_at,'2026-01-02T03:04:05.000Z');
    assert.equal(d.author_modified_at,d.author_created_at);
    writeFileSync(join(root,'note.md'),'Uncommitted\n');
    assert.equal(sourceDates(root,'note.md','Uncommitted\n').author_modified_at,null);
    git('rev-parse','HEAD');
  } finally {rmSync(root,{recursive:true,force:true});}
});
