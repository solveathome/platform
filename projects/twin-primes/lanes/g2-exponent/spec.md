# Lane spec: g2-exponent

Lower the G₂ upper-bound exponent (4.27 toward 2). Served at `GET /projects/twin-primes/lane/g2-exponent/spec`; the hashes below are pinned in `projects/twin-primes/project.json`.

## Goal

Lower the exponent β in the proven bound G2(x#) ≪ x^(β+ε) from 4.26645 toward 2; a fixed exponent below 2 would prove the twin prime conjecture.

## Metric

**proven G2 exponent β** (exponent, lower is better). Baseline: 4.26645 from the DHR dimension-2 sieve (`research/G2-STATE.md` section 0). The band (2, 4.26645] is a proof gap; several routes across it are closed (`research/OUTCOMES.md`).

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

It checks the finite inputs the lane's measured and verified results rest on: exact G2 values, the positions of maximal gaps, sums of consecutive gaps and slot counts. It does not check the exponent argument itself; that is a proof and goes to review.

## Claims format

```json
{"lane": "g2-exponent", "claims": [{"quantity": "g2", "args": {}, "value": 0, "rel_tol": 0}]}
```

One line per claim: `ok`, `MISMATCH` or `UNSUPPORTED`. Exit 0 when every claim is ok, 1 when any claim mismatches, 2 when none mismatch but one is unsupported or the file is malformed. Integers and booleans compare exactly. Real values compare within max(`tol`, `rel_tol` × |computed|): `rel_tol` defaults to 1e-9 and may be widened to at most 0.05. Integers above 2^53 are written as strings.

| Quantity | Arguments (limits) | Value | Definition |
|---|---|---|---|
| `g2` | x (prime, ≤ 23) | integer | G2(x#): the largest cyclic gap between consecutive twin slots mod x#, the wrap gap included. A twin slot is a residue r mod x# with gcd(r(r+2), x#) = 1. Equals OEIS A144311 + 1. |
| `g2_position` | x (prime, ≤ 23) | integer | The lower slot r (least residue) that starts the first maximal gap. |
| `maxsum` | x (prime, ≤ 23), m ≥ 1 | integer | The largest sum of m consecutive cyclic slot gaps mod x# (m = 1 is G2). |
| `slot_count` | x (≤ 1000) | integer | D_x = ∏_{3 ≤ q ≤ x} (q − 2), the number of twin slots mod x# (OEIS A059861). |

An argument outside its limit, or a quantity not in this table, is `UNSUPPORTED`: the evaluator does not judge it, and the checker covers it with an independent implementation of its own (method `independent_implementation`, the file uploaded, its sha256 as `evaluator_sha256`).

## Known values

G2 for x = 2, 3, 5, 7, 11, 13, 17, 19, 23: 2, 6, 12, 30, 42, 66, 108, 150, 204. Positions for x = 5…23: 17, 71, 899, 731, 701, 659, 76166567. maxsum at x = 19, m = 1…5: 150, 186, 210, 228, 282. All from `research/G2-STATE.md` section 2 and `exact-g2-ladder.js`, recomputed by this evaluator.
