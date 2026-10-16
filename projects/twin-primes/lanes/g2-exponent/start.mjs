#!/usr/bin/env node
// SolveAtHome twin primes, lane `g2-exponent`: the runnable starting script (projects/twin-primes/lanes/g2-exponent/spec.md).
// Usage: node start.mjs > claims.json && node evaluate.mjs claims.json
// The lane's starting point: a small, plain computation of the baseline values, written independently of evaluate.mjs, that prints a
// claims file in the evaluator's format. Extend it (larger ranges, new quantities), keep the format, and the pinned evaluator can
// check your numbers unchanged. It runs in a few seconds on any machine with Node 18 or later.
const sieve = (n) => { const c = new Uint8Array(n + 1); c[0] = c[1] = 1; for (let i = 2; i * i <= n; i++) if (!c[i]) for (let j = i * i; j <= n; j += i) c[j] = 1; return (k) => k <= n && !c[k]; };
const isPrime = (n) => { if (n < 2) return false; for (let d = 2; d * d <= n; d++) if (n % d === 0) return false; return true; };
const claims = [];
const claim = (quantity, args, value, extra = {}) => claims.push({ quantity, args, value, ...extra });

// G2(x#): the largest cyclic gap between twin slots mod x# (r with gcd(r(r+2), x#) = 1), by a direct scan of every residue.
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
for (const x of [5, 7, 11, 13]) {
  let W = 1; for (let q = 2; q <= x; q++) if (isPrime(q)) W *= q;
  const slots = []; for (let r = 0; r < W; r++) if (gcd(r, W) === 1 && gcd(r + 2, W) === 1) slots.push(r);
  const gaps = slots.map((r, i) => (i + 1 < slots.length ? slots[i + 1] : slots[0] + W) - r);
  const best = Math.max(...gaps);
  claim('g2', { x }, best); claim('g2_position', { x }, slots[gaps.indexOf(best)]); claim('slot_count', { x }, slots.length);
  for (const m of [2, 3]) { let top = 0; for (let i = 0; i < gaps.length; i++) { let s = 0; for (let k = 0; k < m; k++) s += gaps[(i + k) % gaps.length]; top = Math.max(top, s); } claim('maxsum', { x, m }, top); }
}

console.log(JSON.stringify({ lane: 'g2-exponent', claims }, null, 1));
