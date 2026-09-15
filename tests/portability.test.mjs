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

test('unseeded random draws that reach stdout get a note; a seeded generator, a comment, or draws with no stdout get none; a print of one plain literal is never progress (issue #56)', () => {
  const js = 'let worst = 0;\nfor (let i = 0; i < 200000; i++) { const a = Math.random() * 2 - 1; worst = Math.max(worst, a); }\nconsole.log("sup = " + worst.toFixed(6));\n';
  const n = portabilityNotes('tjb-audit.js', js); assert.equal(n.length, 1); assert.match(n[0], /unseeded random numbers on line 2/); assert.match(n[0], /mulberry32/);
  assert.deepEqual(portabilityNotes('tjb-audit.js', '// Seeded so the sampled sup is reproducible. Math.random() is unseeded.\nfunction mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }\nconst rnd = mulberry32(1);\nconsole.log(rnd());\n'), []);
  assert.deepEqual(portabilityNotes('sim.js', 'const x = Math.random();\nconsole.error(x);\n'), [], 'nothing on stdout');
  const py = portabilityNotes('walk.py', 'import random\nx = random.randint(1, 9)\nprint(x)\n'); assert.equal(py.length, 1); assert.match(py[0], /random\.seed\(n\)/);
  assert.deepEqual(portabilityNotes('walk.py', 'import random\nrandom.seed(7)\nx = random.randint(1, 9)\nprint(x)\n'), []);
  assert.deepEqual(portabilityNotes('walk.py', 'import numpy as np\nrng = np.random.default_rng(20260911)\nprint(rng.choice(10))\n'), []);
  assert.deepEqual(portabilityNotes('hdr.js', "console.log('elapsed: see the log for timing');\nconsole.log(x);\n"), [], 'one plain literal cannot vary');
  assert.deepEqual(portabilityNotes('hdr.py', 'print("rate: 12 per second as stated in the paper")\n'), []);
  assert.equal(portabilityNotes('t.py', 'print("elapsed", elapsed)\n').length, 1, 'two arguments are not one literal');
});

// Issues #71 and #65: the note is shown to the author and repeated to the reviewer, and a fix job is opened for it, so a
// false positive costs a real assignment. Measured over every served script and every uploaded script, 1112 in all: these
// shapes accounted for four of the flags, and joining a call across its lines found six genuine clock reads that reading
// one line at a time had missed.
const timing = (name, src) => portabilityNotes(name, src).filter((n) => n.startsWith('prints'));

test('issue #71: a print whose arguments span lines sends to stderr if any line of the call says so', () => {
  const multiline = "import sys, time, json\nstarted = time.monotonic()\nprint(json.dumps({'wall_seconds': time.monotonic() - started,\n                  'cpu_seconds': cpu}), file=sys.stderr)\nprint(answer)\n";
  assert.deepEqual(timing('revise-registry.py', multiline), [], 'file=sys.stderr on the second line of the call still redirects it');
  const toStdout = "import time, json\nstarted = time.monotonic()\nprint(json.dumps({'wall_seconds': time.monotonic() - started,\n                  'cpu_seconds': cpu}))\n";
  assert.equal(timing('run.py', toStdout).length, 1, 'the same call without the redirect is still a stdout clock read');
  const jsMultiline = "const t0 = Date.now();\nconsole.log(`${String(n).padEnd(3)} ${best} ` +\n  `${((Date.now() - t0) / 1000).toFixed(2)}`);\n";
  assert.equal(timing('h2.js', jsMultiline).length, 1, 'a clock read on the continuation line is found, not missed');
});

test('issue #65: naming a clock API inside a literal is a label, not a read', () => {
  const label = "const unbound = scan();\nconsole.log(`    of those, with an explicit clock read (Date.now/hrtime/perf_counter): ${unbound.length}`);\n";
  assert.deepEqual(timing('rawcheck.mjs', label), [], 'the statement reads no clock; it counts scripts that do');
  const real = "const t0 = Date.now();\nconsole.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);\n";
  assert.equal(timing('real.js', real).length, 1, 'the same API outside a literal is a read');
  const pyInterp = 'import time\nt0 = time.time()\nprint(f"(sieve {time.time() - t0:.2f}s)")\n';
  assert.equal(timing('sieve.py', pyInterp).length, 1, 'a clock read inside an f-string interpolation still counts');
});

test('a ratio and a note about the absence of a clock are not timing', () => {
  assert.deepEqual(timing('quartic.js', "console.log(`  ${z}  ${(r.R1/s).toFixed(1)}`);\n"), [], 'R1/s divides by a variable named s');
  assert.equal(timing('rate.js', "console.log(`${(done/1000).toFixed(1)}/s`);\n").length, 1, 'a real per-second figure still counts');
  const disclaimer = "console.log(JSON.stringify({z, s, W,\n  strict: STRICT}));   // no elapsed field: the\n// tail's normaliser only rewrites times that carry a unit.\n";
  assert.deepEqual(timing('theta.js', disclaimer), [], 'a comment saying there is no elapsed field is not an elapsed field');
  assert.equal(timing('floor.py', 'print(total // seconds, "elapsed")\n').length, 1, 'floor division is not a comment in Python');
});
