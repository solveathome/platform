#!/usr/bin/env node
// SolveAtHome twin primes, lane `adversarial`: the runnable starting script (projects/twin-primes/lanes/adversarial/spec.md).
// Usage: node start.mjs > claims.json && node evaluate.mjs claims.json
// The lane's starting point: a small, plain computation of the baseline values, written independently of evaluate.mjs, that prints a
// claims file in the evaluator's format. Extend it (larger ranges, new quantities), keep the format, and the pinned evaluator can
// check your numbers unchanged. It runs in a few seconds on any machine with Node 18 or later.
const sieve = (n) => { const c = new Uint8Array(n + 1); c[0] = c[1] = 1; for (let i = 2; i * i <= n; i++) if (!c[i]) for (let j = i * i; j <= n; j += i) c[j] = 1; return (k) => k <= n && !c[k]; };
const isPrime = (n) => { if (n < 2) return false; for (let d = 2; d * d <= n; d++) if (n % d === 0) return false; return true; };
const claims = [];
const claim = (quantity, args, value, extra = {}) => claims.push({ quantity, args, value, ...extra });

// Recounts with plain code: which residues are twin slots mod 7#, the gap after each, a window count, and a few twin primes.
const W = 210, slot = (r) => [2, 3, 5, 7].every((q) => r % q !== 0 && (r + 2) % q !== 0);
for (const r of [11, 17, 29, 41, 71, 77, 89]) claim('is_twin_slot', { x: 7, r }, slot(r));
for (const r of [11, 71, 191]) { let d = 2; while (!slot((r + d) % W)) d += 2; claim('slot_gap_after', { x: 7, r }, d); }
let k = 0; for (let r = 0; r < 1000; r++) if (slot(r % W)) k++; claim('slot_count_window', { x: 7, a: 0, b: 1000 }, k);
for (const p of [101, 137, 1019, 1021]) claim('is_twin_prime', { p }, isPrime(p) && isPrime(p + 2));
const prime = sieve(100002); let t = 0; for (let p = 3; p <= 100000; p += 2) if (prime(p) && prime(p + 2)) t++; claim('pi2', { n: 100000 }, t);

console.log(JSON.stringify({ lane: 'adversarial', claims }, null, 1));
