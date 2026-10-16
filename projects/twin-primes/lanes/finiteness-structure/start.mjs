#!/usr/bin/env node
// SolveAtHome twin primes, lane `finiteness-structure`: the runnable starting script (projects/twin-primes/lanes/finiteness-structure/spec.md).
// Usage: node start.mjs > claims.json && node evaluate.mjs claims.json
// The lane's starting point: a small, plain computation of the baseline values, written independently of evaluate.mjs, that prints a
// claims file in the evaluator's format. Extend it (larger ranges, new quantities), keep the format, and the pinned evaluator can
// check your numbers unchanged. It runs in a few seconds on any machine with Node 18 or later.
const sieve = (n) => { const c = new Uint8Array(n + 1); c[0] = c[1] = 1; for (let i = 2; i * i <= n; i++) if (!c[i]) for (let j = i * i; j <= n; j += i) c[j] = 1; return (k) => k <= n && !c[k]; };
const isPrime = (n) => { if (n < 2) return false; for (let d = 2; d * d <= n; d++) if (n % d === 0) return false; return true; };
const claims = [];
const claim = (quantity, args, value, extra = {}) => claims.push({ quantity, args, value, ...extra });

// The zone (p, p'^2): twin pairs (a, a+2) with p < a and a + 2 < p'^2, their count, the largest opener gap Z2, the head and the tail.
for (const p of [5, 7, 11, 13, 17, 19]) {
  let q = p + 1; while (!isPrime(q)) q++;
  const openers = []; for (let a = p + 1; a + 2 < q * q; a++) if (isPrime(a) && isPrime(a + 2)) openers.push(a);
  claim('zone_twin_count', { p }, openers.length);
  if (openers.length >= 2) claim('zone_gap', { p }, Math.max(...openers.slice(1).map((a, i) => a - openers[i])));
  claim('zone_head', { p }, openers[0] - p); claim('zone_tail', { p }, q * q - openers[openers.length - 1]);
}

console.log(JSON.stringify({ lane: 'finiteness-structure', claims }, null, 1));
