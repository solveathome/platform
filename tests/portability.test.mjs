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
