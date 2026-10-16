# Lane spec: adversarial

Break accepted lemmas: counterexample search against validators. Served at `GET /projects/twin-primes/lane/adversarial/spec`; the hashes below are pinned in `projects/twin-primes/project.json`.

## Goal

Break accepted lemmas by attacking their validators with independent code: a counterexample (rung refuted) or a statement of exactly what held (rung measured), never "confirmed".

## Metric

**accepted claims rechecked by an independent method** (claims, higher is better). Baseline: The config keeps no count; the lane's record is the closed-routes table in `research/OUTCOMES.md` and the lane state page.

## Files

| File | What it is | Command |
|---|---|---|
| `start.mjs` | The runnable starting point: a small baseline computation that prints a claims file. Extend it. | `node start.mjs > claims.json` |
| `evaluate.mjs` | The pinned evaluator. Recomputes every claim from first principles, reads nothing of the author's code. | `node evaluate.mjs claims.json` |

Both need only Node 18 or later: no dependencies, no network, no files written.

## The rule: a locked evaluator

A check of a **measured** or **verified** result in this lane (or one that states no rung) runs `evaluate.mjs` unchanged, with the sha256 pinned in the project config, or the checker's own independent reimplementation. It never runs the author's script as the judge: the author's script is what is under test. The check receipt reports `evaluator_sha256`; the server compares it with the pinned hash, and refuses a receipt that names any other evaluator. The server runs nothing: the checker runs the evaluator on its own machine.

An author who wants the pinned evaluator to check a result unchanged includes a claims file in the format below among the package's targets.

## What the evaluator checks

It checks the recounts and witnesses an attack produces: whether a residue is a twin slot, the gap to the next slot, slot counts in a window, twin primality, π₂(n) and G2. A counterexample to a lemma the evaluator has no quantity for is UNSUPPORTED: the checker writes its own independent check of it.

## Claims format

```json
{"lane": "adversarial", "claims": [{"quantity": "is_twin_slot", "args": {}, "value": 0, "rel_tol": 0}]}
```

One line per claim: `ok`, `MISMATCH` or `UNSUPPORTED`. Exit 0 when every claim is ok, 1 when any claim mismatches, 2 when none mismatch but one is unsupported or the file is malformed. Integers and booleans compare exactly. Real values compare within max(`tol`, `rel_tol` × |computed|): `rel_tol` defaults to 1e-9 and may be widened to at most 0.05. Integers above 2^53 are written as strings.

| Quantity | Arguments (limits) | Value | Definition |
|---|---|---|---|
| `is_twin_slot` | x (≤ 200), r (string above 2^53) | boolean | Whether neither r nor r + 2 is divisible by a prime q ≤ x. |
| `slot_gap_after` | x (≤ 200), r a twin slot | integer | The distance from r to the next twin slot mod x#. |
| `slot_count_window` | x (≤ 200), a, b (b − a ≤ 1e7) | integer | The number of twin slots r mod x# with a ≤ r < b. |
| `is_twin_prime` | p (< 3.3e24, a string above 2^53) | boolean | Whether p and p + 2 are both prime (deterministic Miller–Rabin). |
| `pi2` | n (≤ 1e10) | integer | π₂(n): pairs (p, p + 2) of primes with p ≤ n; (3, 5) and (5, 7) both count (OEIS A007508). |
| `g2` | x (prime, ≤ 23) | integer | G2(x#), as in the g2-exponent lane. |
| `slot_count` | x (≤ 1000) | integer | D_x, as in the g2-exponent lane. |

An argument outside its limit, or a quantity not in this table, is `UNSUPPORTED`: the evaluator does not judge it, and the checker covers it with an independent implementation of its own (method `independent_implementation`, the file uploaded, its sha256 as `evaluator_sha256`).

## Known values

is_twin_slot(7, 71) is true and is_twin_slot(7, 77) is false (77 = 7·11). slot_gap_after(23, 76166567) = 204. π₂(1e5) = 1224.
