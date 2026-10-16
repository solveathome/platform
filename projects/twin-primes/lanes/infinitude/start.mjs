#!/usr/bin/env node
// SolveAtHome twin primes, lane `infinitude`: the runnable starting script (projects/twin-primes/lanes/infinitude/spec.md).
// Usage: node start.mjs > claims.json && node evaluate.mjs claims.json
// The lane's starting point: a small, plain computation of the baseline values, written independently of evaluate.mjs, that prints a
// claims file in the evaluator's format. Extend it (larger ranges, new quantities), keep the format, and the pinned evaluator can
// check your numbers unchanged. It runs in a few seconds on any machine with Node 18 or later.
const sieve = (n) => { const c = new Uint8Array(n + 1); c[0] = c[1] = 1; for (let i = 2; i * i <= n; i++) if (!c[i]) for (let j = i * i; j <= n; j += i) c[j] = 1; return (k) => k <= n && !c[k]; };
const isPrime = (n) => { if (n < 2) return false; for (let d = 2; d * d <= n; d++) if (n % d === 0) return false; return true; };
const claims = [];
const claim = (quantity, args, value, extra = {}) => claims.push({ quantity, args, value, ...extra });

// M(x) = sum Lambda(n-2) mu(n) and S(x) = sum Lambda(n) Lambda(n-2) over n in (x/2, x], x = 2^j (research/centered-discrepancy-measurement.js).
const factor = (n) => { const f = []; for (let d = 2; d * d <= n; d++) while (n % d === 0) { f.push(d); n /= d; } if (n > 1) f.push(n); return f; };
const Lambda = (n) => { if (n < 2) return 0; const f = factor(n); return f.every((p) => p === f[0]) ? Math.log(f[0]) : 0; };
const mu = (n) => { const f = factor(n); return new Set(f).size === f.length ? (f.length % 2 ? -1 : 1) : 0; };
for (const j of [10, 12, 14]) {
  const x = 2 ** j; let M = 0, S = 0;
  for (let n = x / 2 + 1; n <= x; n++) { const l = Lambda(n - 2); if (l) { M += l * mu(n); S += l * Lambda(n); } }
  claim('M_over_x', { j }, M / x, { rel_tol: 1e-9 }); claim('S_over_x', { j }, S / x, { rel_tol: 1e-9 });
}

console.log(JSON.stringify({ lane: 'infinitude', claims }, null, 1));
