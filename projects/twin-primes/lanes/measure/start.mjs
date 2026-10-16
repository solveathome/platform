#!/usr/bin/env node
// SolveAtHome twin primes, lane `measure`: the runnable starting script (projects/twin-primes/lanes/measure/spec.md).
// Usage: node start.mjs > claims.json && node evaluate.mjs claims.json
// The lane's starting point: a small, plain computation of the baseline values, written independently of evaluate.mjs, that prints a
// claims file in the evaluator's format. Extend it (larger ranges, new quantities), keep the format, and the pinned evaluator can
// check your numbers unchanged. It runs in a few seconds on any machine with Node 18 or later.
const sieve = (n) => { const c = new Uint8Array(n + 1); c[0] = c[1] = 1; for (let i = 2; i * i <= n; i++) if (!c[i]) for (let j = i * i; j <= n; j += i) c[j] = 1; return (k) => k <= n && !c[k]; };
const isPrime = (n) => { if (n < 2) return false; for (let d = 2; d * d <= n; d++) if (n % d === 0) return false; return true; };
const claims = [];
const claim = (quantity, args, value, extra = {}) => claims.push({ quantity, args, value, ...extra });

const prime = sieve(1_000_002);
for (const n of [1000, 10000, 100000, 1000000]) { let k = 0; for (let p = 3; p <= n; p += 2) if (prime(p) && prime(p + 2)) k++; claim('pi2', { n }, k); }
// The first levels of research/02-first-twin-margin.js: p_n, the next prime, the first twin above p_n and the margin p_{n+1}^2 / r.
for (const level of [5, 13, 31, 71]) {
  let q = level + 1; while (!isPrime(q)) q++;
  let r = level + 1; while (!(isPrime(r) && isPrime(r + 2))) r++;
  claim('next_prime', { n: level }, q); claim('first_twin_after', { p: level }, r); claim('first_twin_margin', { p: level }, (q * q) / r);
  let cand = 0; for (let a = level + 1; a + 2 < q * q; a++) if (isPrime(a) && isPrime(a + 2)) cand++;
  claim('zone_twin_count', { p: level }, cand);
}

console.log(JSON.stringify({ lane: 'measure', claims }, null, 1));
