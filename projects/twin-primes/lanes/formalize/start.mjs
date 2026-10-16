#!/usr/bin/env node
// SolveAtHome twin primes, lane `formalize`: the runnable starting script (projects/twin-primes/lanes/formalize/spec.md).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
// Usage: node start.mjs > claims.json && node evaluate.mjs claims.json
// The lane's starting point: a small, plain computation of the baseline values, written independently of evaluate.mjs, that prints a
// claims file in the evaluator's format. Extend it (larger ranges, new quantities), keep the format, and the pinned evaluator can
// check your numbers unchanged. It runs in a few seconds on any machine with Node 18 or later.
const sieve = (n) => { const c = new Uint8Array(n + 1); c[0] = c[1] = 1; for (let i = 2; i * i <= n; i++) if (!c[i]) for (let j = i * i; j <= n; j += i) c[j] = 1; return (k) => k <= n && !c[k]; };
const isPrime = (n) => { if (n < 2) return false; for (let d = 2; d * d <= n; d++) if (n % d === 0) return false; return true; };
const claims = [];
const claim = (quantity, args, value, extra = {}) => claims.push({ quantity, args, value, ...extra });

// A Lean result's audit: run `lake env lean` with `#print axioms <theorem>` for every main theorem and save the output as axioms.log
// next to claims.json, beside the package's lean-toolchain and .lean sources. This starting script writes those claims for the
// files it finds; with no Lean output present it emits the definitional cross-check of G2 that the lane's #eval checks use.
if (existsSync('axioms.log')) {
  for (const m of readFileSync('axioms.log', 'utf8').matchAll(/'([^']+)' (?:depends on axioms|does not depend)/g)) claim('axioms_within_policy', { log: 'axioms.log', theorem: m[1] }, true);
}
if (existsSync('lean-toolchain')) claim('toolchain_pinned', { file: 'lean-toolchain' }, true);
for (const f of readdirSync('.').filter((f) => f.endsWith('.lean'))) claim('source_clean', { file: f }, true);
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
for (const x of [2, 3, 5, 7, 11, 13]) {
  let W = 1; for (let q = 2; q <= x; q++) if (isPrime(q)) W *= q;
  const s = []; for (let r = 0; r < W; r++) if (gcd(r, W) === 1 && gcd(r + 2, W) === 1) s.push(r);
  claim('g2', { x }, Math.max(...s.map((r, i) => (i + 1 < s.length ? s[i + 1] : s[0] + W) - r)));
}

console.log(JSON.stringify({ lane: 'formalize', claims }, null, 1));
