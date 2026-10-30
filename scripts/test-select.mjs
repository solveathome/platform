// Picks the checks a change could break (Oct 30 2026: longer suites may exist, but a push runs only what its change touches;
// a docs or style change runs nothing). The pre-push hook and `npm run test:changed` use it; `npm run test:all` stays the whole suite.
// A test covers a file when it names the file's path (an import or a read); docs/testing.md lists the rules below in prose.
import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

// The two lists the suite runs, read from package.json so a new test is found the moment it is listed there.
export const listedTests = (pkg) => {
  const files = (script) => (pkg.scripts?.[script] || '').match(/tests\/[\w.-]+\.test\.mjs/g) || [];
  return {unit: files('test'), db: files('test:db')};
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The names a test may use for a file: its path, and for TypeScript its path without the extension (or its folder, for index.ts).
const pathKeys = (file) => {
  const keys = [file];
  if (/\.ts$/.test(file)) keys.push(file.replace(/\.ts$/, ''));
  if (/\/index\.ts$/.test(file)) keys.push(file.replace(/\/index\.ts$/, ''));
  return keys;
};
// "src/lib/lean" must not match "src/lib/lean-display": a key counts only when a quote, an extension or a slash follows it.
const names = (text, file) => pathKeys(file).some((k) => new RegExp(escape(k) + '(\\.[jt]s)?[\'"`/]').test(text));

// Files a project's tests read by rule rather than by path: lane specs, briefs, project.json are reached through a slug.
const PROJECT_RULES = [
  [/^projects\/[^/]+\/lanes\//, ['tests/lane-spec.test.mjs', 'tests/lane-evaluator-db.test.mjs']],
  [/^projects\/[^/]+\/briefs\//, ['tests/brief.test.mjs', 'tests/brief-sections.test.mjs']],
  [/^projects\/[^/]+\/project\.json$/, ['tests/brief.test.mjs', 'tests/project-nav.test.mjs', 'tests/lane-spec.test.mjs']],
];

// What changes everything: the schema and the pool (every DB test boots through them), the compiler settings and the dependencies.
const ALL_DB = /^src\/db\//;
const EVERYTHING = /^(tsconfig\.json|package-lock\.json)$/;

// changed: repository paths. tests: {unit, db} lists. read(path) returns a test's text. depsChanged: package.json's dependencies moved.
// Returns {check, unit, db, reasons}: check is the typecheck, unit and db the test files, db may be 'all'.
export function selectTests(changed, {tests, read, depsChanged = false}) {
  const listed = new Set([...tests.unit, ...tests.db]);
  const unit = new Set(), db = new Set(), reasons = [];
  let check = false, allDb = false, allUnit = false;
  const add = (t, why) => {
    if (!listed.has(t)) return;
    (tests.db.includes(t) ? db : unit).add(t);
    reasons.push(`${t}: ${why}`);
  };
  if (depsChanged) { check = allUnit = allDb = true; reasons.push('package.json dependencies changed: everything'); }
  for (const f of changed) {
    if (/\.ts$/.test(f) && /^(src|scripts)\//.test(f)) check = true;
    if (EVERYTHING.test(f)) { check = allUnit = allDb = true; reasons.push(`${f}: everything`); continue; }
    if (ALL_DB.test(f)) { allDb = true; reasons.push(`${f}: all DB tests`); }
    if (/^tests\/[\w.-]+\.test\.mjs$/.test(f)) { add(f, 'changed'); continue; }
    for (const [re, ts] of PROJECT_RULES) if (re.test(f)) for (const t of ts) add(t, `reads ${f}`);
    for (const t of listed) if (names(read(t), f)) add(t, `names ${f}`);
  }
  if (allUnit) tests.unit.forEach((t) => unit.add(t));
  return {check, unit: [...unit].sort(), db: allDb ? 'all' : [...db].sort(), reasons};
}

const git = (...args) => execFileSync('git', args, {encoding: 'utf8'});
const depsOf = (json) => { try { const p = JSON.parse(json); return JSON.stringify([p.dependencies, p.devDependencies, p.engines]); } catch { return null; } };

// CLI: node scripts/test-select.mjs <base>[..<head>] ...  A range without a head is compared with the working tree, untracked files
// included. Prints three lines for scripts/test-changed.sh (check|none, the unit files, the DB files or "all"); the reasons go to stderr.
if (import.meta.url === `file://${process.argv[1]}`) {
  const changed = new Set();
  let depsChanged = false;
  for (const range of process.argv.slice(2)) {
    const [base, head] = range.split('..');
    const diff = head ? git('diff', '--name-only', '--no-renames', base, head) : git('diff', '--name-only', '--no-renames', base) + git('ls-files', '--others', '--exclude-standard');
    diff.split('\n').filter(Boolean).forEach((f) => changed.add(f));
    if (changed.has('package.json')) {
      const show = (rev) => { try { return git('show', `${rev}:package.json`); } catch { return ''; } };
      if (depsOf(show(base)) !== depsOf(head ? show(head) : readFileSync('package.json', 'utf8'))) depsChanged = true;
    }
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const tests = listedTests(pkg);
  const onDisk = new Set(readdirSync('tests').map((n) => `tests/${n}`));
  const cache = new Map();
  const read = (t) => { if (!cache.has(t)) cache.set(t, onDisk.has(t) ? readFileSync(join('tests', t.slice(6)), 'utf8') : ''); return cache.get(t); };
  const plan = selectTests([...changed], {tests, read, depsChanged});
  process.stderr.write(`${changed.size} changed file(s); ${plan.reasons.length ? plan.reasons.join('\n  ') : 'no test names them'}\n`.replace(/; /, ';\n  '));
  console.log(plan.check ? 'check' : 'none');
  console.log(plan.unit.join(' '));
  console.log(plan.db === 'all' ? 'all' : plan.db.join(' '));
}
