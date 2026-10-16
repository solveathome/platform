#!/usr/bin/env node
// SolveAtHome twin primes, lane `adversarial`: the pinned evaluator. Spec: GET /projects/twin-primes/lane/adversarial/spec
// (projects/twin-primes/lanes/adversarial/spec.md). Its sha256 is recorded in projects/twin-primes/project.json; a check of a measured
// or verified result in this lane runs this file unchanged, or the checker's own reimplementation, never the author's script.
//
// Usage: node evaluate.mjs <claims.json>
//
// claims.json: {"lane": "<this lane>", "claims": [{"quantity": "<name>", "args": {...}, "value": <claimed>, "rel_tol": <optional>, "tol": <optional>}]}
// Every claim is recomputed here from first principles; nothing from the author's code is read or run. One line per claim:
//   ok          the recomputed value equals the claim (within the claim's stated tolerance, for real-valued quantities)
//   MISMATCH    it does not
//   UNSUPPORTED this evaluator does not compute that quantity, or the arguments are outside its limits
// Exit 0: every claim ok. Exit 1: at least one MISMATCH. Exit 2: no mismatch, but something UNSUPPORTED or the file is malformed;
// an unsupported claim is not judged, and the checker covers it with an independent implementation of its own.
// Integers compare exactly. Real values compare within max(tol, rel_tol*|computed|); both default to 0 for integer quantities and to
// rel_tol 1e-9 for real ones, and a claim may widen rel_tol to at most 0.05 (a value printed to two significant figures).
// Self-contained: Node 18 or later, no dependencies, no network, no files written. The server never runs it.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

class Unsupported extends Error {}
const need = (cond, why) => { if (!cond) throw new Unsupported(why); };
const int = (v, name, max = Number.MAX_SAFE_INTEGER, min = 0) => { need(Number.isSafeInteger(v) && v >= min && v <= max, `${name} must be an integer in [${min}, ${max}]`); return v; };
const big = (v, name) => { need((typeof v === 'string' && /^\d{1,30}$/.test(v)) || (Number.isSafeInteger(v) && v >= 0), `${name} must be a non-negative integer (a string for values above 2^53)`); return BigInt(v); };

// ---- primes ------------------------------------------------------------------------------------------------------------------------
function primesUpTo(n) {
  const c = new Uint8Array(n + 1), out = [];
  for (let i = 2; i <= n; i++) { if (c[i]) continue; out.push(i); for (let j = i * i; j <= n; j += i) c[j] = 1; }
  return out;
}
function modpow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
/** Deterministic Miller-Rabin for n < 3.3e24 (the first twelve prime bases). */
function isPrime(n) {
  n = BigInt(n); if (n < 2n) return false;
  const bases = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];
  for (const p of bases) { if (n === p) return true; if (n % p === 0n) return false; }
  need(n < 3317044064679887385961981n, 'primality above 3.3e24 is outside this evaluator');
  let d = n - 1n, s = 0n; while (!(d & 1n)) { d >>= 1n; s++; }
  outer: for (const a of bases) {
    let x = modpow(a, d, n); if (x === 1n || x === n - 1n) continue;
    for (let i = 1n; i < s; i++) { x = x * x % n; if (x === n - 1n) continue outer; }
    return false;
  }
  return true;
}
const nextPrime = (n) => { let m = BigInt(n) + 1n; while (!isPrime(m)) m++; return m; };
const firstTwinAfter = (p) => { let r = BigInt(p) + 1n; while (!(isPrime(r) && isPrime(r + 2n))) r++; return r; };
/** Calls visit(p) for every prime p in [lo, hi], by a segmented sieve (hi <= 1e15 keeps every value exact in a double). */
function eachPrime(lo, hi, visit) {
  need(hi <= 1e15, 'ranges above 1e15 are outside this evaluator');
  if (hi < 2) return; lo = Math.max(lo, 2);
  const base = primesUpTo(Math.floor(Math.sqrt(hi)) + 1), SEG = 1 << 22, mark = new Uint8Array(SEG);
  for (let s = lo; s <= hi; s += SEG) {
    const e = Math.min(hi, s + SEG - 1); mark.fill(0, 0, e - s + 1);
    for (const p of base) {
      if (p * p > e) break;
      let j = Math.max(p * p, Math.ceil(s / p) * p);
      for (; j <= e; j += p) mark[j - s] = 1;
    }
    for (let i = 0; i <= e - s; i++) if (!mark[i]) visit(s + i);
  }
}
/** Lower members a of twin pairs with lo <= a and a + 2 <= hi, in order. */
function eachTwin(lo, hi, visit) { let prev = -10; eachPrime(Math.max(2, lo), hi, (p) => { if (p - prev === 2 && prev >= lo) visit(prev); prev = p; }); }
/** pi2(n): pairs (p, p+2) of primes with p <= n; (3,5) and (5,7) both count (OEIS A007508). */
function pi2(n) { let k = 0; eachTwin(2, n + 2, (a) => { if (a <= n) k++; }); return k; }

// ---- twin slots mod x# -------------------------------------------------------------------------------------------------------------
/** The sorted twin slots mod x#: residues r with gcd(r(r+2), x#) = 1. Built by lifting through the primes, never a W-sized array. */
const slotCache = new Map();
function twinSlots(x) {
  if (slotCache.has(x)) return slotCache.get(x);
  need(Number.isInteger(x) && x >= 2 && x <= 23, 'slot enumeration is limited to x <= 23 (23# = 223092870, 7952175 slots)');
  const ps = primesUpTo(x); let W = 2, slots = new Uint32Array([1]);
  for (const q of ps.slice(1)) {
    const next = new Uint32Array(slots.length * (q - 2)); let k = 0;
    for (let t = 0; t < q; t++) for (const r0 of slots) { const r = r0 + t * W; const m = r % q; if (m !== 0 && m !== q - 2) next[k++] = r; }
    W *= q; slots = next.subarray(0, k).sort();
  }
  slotCache.set(x, { W, slots });
  return { W, slots };
}
/** Cyclic gaps between consecutive slots, the wrap gap last. */
function slotGaps({ W, slots }) { const n = slots.length, g = new Uint32Array(n); for (let i = 0; i < n; i++) g[i] = i + 1 < n ? slots[i + 1] - slots[i] : slots[0] + W - slots[i]; return g; }
function g2(x) { const t = twinSlots(x), g = slotGaps(t); let best = 0, at = 0; for (let i = 0; i < g.length; i++) if (g[i] > best) { best = g[i]; at = t.slots[i]; } return { g2: best, position: at }; }
/** The largest sum of m consecutive cyclic gaps (m = 1 is G2). */
function maxsum(x, m) { const g = slotGaps(twinSlots(x)), n = g.length; need(m >= 1 && m <= n, 'm out of range'); let s = 0; for (let i = 0; i < m; i++) s += g[i]; let best = s; for (let i = 1; i < n; i++) { s += g[(i + m - 1) % n] - g[i - 1]; if (s > best) best = s; } return best; }
/** D_x = prod_{3 <= q <= x} (q - 2), the number of twin slots mod x#. */
function slotCount(x) { need(Number.isInteger(x) && x >= 2 && x <= 1000, 'x must be at most 1000'); let d = 1n; for (const q of primesUpTo(x)) if (q >= 3) d *= BigInt(q - 2); return d; }
/** A test for twin slots mod x#: r is a slot when neither r nor r + 2 is divisible by a prime q <= x. */
function slotTester(x) { const ps = primesUpTo(x).map(BigInt); return (r) => { r = BigInt(r); return ps.every((q) => { const m = ((r % q) + q) % q; return m !== 0n && m !== (q - 2n) % q; }); }; }

// ---- the zone (p, p'^2) ------------------------------------------------------------------------------------------------------------
/** Twin pairs (a, a+2) with p < a and a + 2 < p'^2, p' the next prime (the Zone Postulate's zone; research/zonegap-01.js conventions):
 *  their count, the largest gap between consecutive openers a (Z2), the head a_first - p and the tail p'^2 - a_last. */
function zone(p) {
  p = int(p, 'p', 1e5, 2); need(isPrime(p), 'p must be prime');
  const q = Number(nextPrime(p)), top = q * q; need(top <= 1e10, "p'^2 must be at most 1e10");
  let count = 0, first = null, last = null, z2 = 0;
  eachTwin(p + 1, top - 1, (a) => { if (last !== null && a - last > z2) z2 = a - last; if (first === null) first = a; last = a; count++; });
  return { count, z2: count >= 2 ? z2 : null, head: first === null ? null : first - p, tail: last === null ? null : top - last };
}

// ---- claims ------------------------------------------------------------------------------------------------------------------------
function compare(claim, computed, q) {
  const real = !!q.real, v = q.normalize ? q.normalize(claim.value) : claim.value;
  if (!real) {
    const want = typeof computed === 'bigint' ? computed.toString() : JSON.stringify(computed);
    const got = typeof computed === 'bigint' ? (typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v)) : JSON.stringify(v);
    return got === want;
  }
  need(typeof v === 'number' && Number.isFinite(v), 'a real-valued quantity needs a numeric value');
  const rel = claim.rel_tol ?? 1e-9, abs = claim.tol ?? 0;
  need(typeof rel === 'number' && rel >= 0 && rel <= 0.05 && typeof abs === 'number' && abs >= 0, 'rel_tol must be in [0, 0.05] and tol non-negative');
  return Math.abs(v - computed) <= Math.max(abs, rel * Math.abs(computed));
}
const show = (x) => typeof x === 'bigint' ? x.toString() : typeof x === 'number' && !Number.isInteger(x) ? x.toPrecision(10) : JSON.stringify(x);
function run(lane, QUANTITIES, file) {
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.log(`UNSUPPORTED cannot read ${file} as JSON: ${e.message}`); return 2; }
  if (!doc || doc.lane !== lane || !Array.isArray(doc.claims) || !doc.claims.length || doc.claims.length > 500) { console.log(`UNSUPPORTED the claims file must be {"lane": "${lane}", "claims": [1 to 500 claims]}`); return 2; }
  const ctx = { dir: dirname(resolve(file)) };
  let mismatch = 0, unsupported = 0;
  doc.claims.forEach((c, i) => {
    const label = `#${i + 1} ${c?.quantity}(${JSON.stringify(c?.args ?? {})})`;
    try {
      const q = QUANTITIES[c?.quantity]; need(q, `unknown quantity; this evaluator computes: ${Object.keys(QUANTITIES).join(', ')}`);
      need(c.args && typeof c.args === 'object', 'args must be an object');
      const computed = q.compute(c.args, ctx);
      if (compare(c, computed, q)) console.log(`ok          ${label} = ${show(computed)}`);
      else { mismatch++; console.log(`MISMATCH    ${label}: claimed ${show(c.value)}, computed ${show(computed)}`); }
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      unsupported++; console.log(`UNSUPPORTED ${label}: ${e.message}`);
    }
  });
  console.log(`summary: ${doc.claims.length} claims, ${doc.claims.length - mismatch - unsupported} ok, ${mismatch} mismatch, ${unsupported} unsupported`);
  return mismatch ? 1 : unsupported ? 2 : 0;
}

const QUANTITIES = {
  is_twin_slot: { compute: (a) => slotTester(int(a.x, 'x', 200, 2))(big(a.r, 'r')) },
  slot_gap_after: { compute: (a) => { const t = slotTester(int(a.x, 'x', 200, 2)), r = big(a.r, 'r'); need(t(r), 'r is not a twin slot mod x#'); let d = 2n; while (!t(r + d)) { d += 2n; need(d < 1000000n, 'no slot within 1e6'); } return d; } },
  slot_count_window: { compute: (a) => { const t = slotTester(int(a.x, 'x', 200, 2)), lo = int(a.a, 'a', 1e15), hi = int(a.b, 'b', 1e15); need(hi >= lo && hi - lo <= 1e7, 'b - a must be between 0 and 1e7'); let k = 0; for (let r = lo; r < hi; r++) if (t(r)) k++; return k; } },
  is_twin_prime: { compute: (a) => { const p = big(a.p, 'p'); return isPrime(p) && isPrime(p + 2n); } },
  pi2: { compute: (a) => pi2(int(a.n, 'n', 1e10)) },
  g2: { compute: (a) => { const x = int(a.x, 'x', 23, 2); need(isPrime(x), 'x must be prime'); return g2(x).g2; } },
  slot_count: { compute: (a) => slotCount(int(a.x, 'x', 1000, 2)) },
};

const LANE = 'adversarial';
if (!process.argv[2]) { console.log('usage: node evaluate.mjs <claims.json>'); process.exitCode = 2; }
else process.exitCode = run(LANE, QUANTITIES, process.argv[2]);
