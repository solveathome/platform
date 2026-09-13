import assert from 'node:assert/strict';
import {test} from 'node:test';
// Files that will not run or reproduce as shipped (Chris, Sep 12 2026: never refuse; tell the author and the reviewer where).
const {portabilityNotes} = await import('../src/lib/files.ts');

test('a script with a hard-coded home directory or a progress line on stdout gets a note naming the line; a clean script gets none', () => {
  const home = portabilityNotes('compare.js', 'const fs = require("fs");\nconst base = "/Users/nate/twin-primes/research/";\nconsole.log(fs.readFileSync(base + "a.txt", "utf8").length);\n');
  assert.equal(home.length, 1); assert.match(home[0], /hard-coded home directory: \/Users\/nate\/twin-primes\/research\/ \(line 2\)/); assert.match(home[0], /relative to the repository/);
  const tick = portabilityNotes('sweep.py', 'import sys\nfor i in range(n):\n    if i % 1000 == 0:\n        print(f"{100*i/n:.1f}% done, elapsed {t:.0f}s")\nprint(result)\n');
  assert.equal(tick.length, 1); assert.match(tick[0], /progress or timing to stdout on line 4/); assert.match(tick[0], /send progress, timing and rates to stderr/);
  const fine = portabilityNotes('sweep.py', 'import sys\nfor i in range(n):\n    if i % 1000 == 0:\n        print(f"{100*i/n:.1f}% done", file=sys.stderr)\nprint(result)\n');
  assert.deepEqual(fine, []);
  assert.deepEqual(portabilityNotes('tick.js', 'setInterval(() => console.error(`${pct}% done, ${rate}/s`), 30000);\nconsole.log(JSON.stringify(out));\n'), [], 'ticks on stderr are fine');
  const both = portabilityNotes('run.sh', 'cd /home/bob/work/repo\necho "progress: $i of $n"\n');
  assert.equal(both.length, 2);
});

test('documents and logs are checked for the home path only', () => {
  assert.equal(portabilityNotes('notes.md', 'See /Users/bob/notes/x.md for the table.\nprogress: 50% done, elapsed 3s\n').length, 1);
  assert.deepEqual(portabilityNotes('run.log', 'progress: 50% done, elapsed 3s\n'), []);
});

test('mathematics printed to stdout is not progress: eta, rate:, remaining and {x/s} in section headers are silent; a clock read or a timing figure is not', () => {
  // Real lines from served scripts (Sep 12–13 2026), each of which opened a fix job under the word-list heuristic.
  for (const l of [
    "console.log('\\n=== 4. The growth rate: is |F_r| >= 2^{0.92 r} the right constant? ===');",
    "console.log('  ||T_L|| ||T_R|| >= (L_0 eta/64) * sqrt(w_L w_R) * x log^2 x');",
    "console.log('\\n=== 5. The remaining exact relations in the verdict ===');",
    "console.log('  \"8 of 14 enumerable steps starting at s = 9\": 8/14 = '+f(8/14*100,1)+' % of the steps');",
    "console.log(`heuristic K = ${fmt(rich.K)}; heuristic slack of that one-sided target at eta=0: ${x}`);",
    "console.log(`${label}: embedded ${embLines.length} lines (${E.length} after dropping progress lines), run ${run}`);",
    "process.stdout.write('PASS: timing/progress variation leaves stdout unchanged; changed data remains visible.\\n');",
  ]) assert.deepEqual(portabilityNotes('audit.js', l + '\n'), [], l);
  assert.deepEqual(portabilityNotes('regions.py', 's = max(abs(Bd), abs(Bn)); print(f"  {side:5} {name:15}: {Bd/s}*delta + {Bn/s}*nu < {(1-B0)/s}")\n'), []);
  for (const [name, l] of [
    ['job68-check.py', 'print(f"[task 1 done at {elapsed():.1f} s]")'],
    ['g2check.py', 'print(f"p_n={p:2d} P={P:>12d} census={census} G2={G2}  [{time.time()-t:.1f}s]")'],
    ['walk.py', 't=time.time(); check(x,p); print(f"   ({time.time()-t:.1f}s)")'],
    ['transport.js', "console.log('total ' + ((Date.now() - T0) / 1000).toFixed(1) + ' s');"],
    ['pairs.js', 'console.log(`@${x}: W=${W}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);'],
    ['sweep.py', 'print(f"{i}/{n} done, ETA {eta:.0f}s")'],
    ['sweep.py', 'print(f"rate: {n/dt:.0f}/s")'],
  ]) { const n = portabilityNotes(name, 'x\n' + l + '\n'); assert.equal(n.length, 1, `${name}: ${l}`); assert.match(n[0], /stdout on line 2/); }
});
