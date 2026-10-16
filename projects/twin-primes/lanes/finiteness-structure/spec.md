# Lane spec: finiteness-structure

What structure a finite twin count would force (disproof-shaped lane). Served at `GET /projects/twin-primes/lane/finiteness-structure/spec`; the hashes below are pinned in `projects/twin-primes/project.json`.

## Goal

Work out what structure a finite number of twin primes would force, and measure that structure where it can be measured.

## Metric

**zone levels p at which the zone structure is measured** (largest p, higher is better). Baseline: The margin x′²/G2(x#) has its minimum 3.18 at x = 37 (`research/G2-STATE.md` section 2); Z2(p) is measured by `research/zonegap-01.js`.

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

It checks the zone (p, p′²) of `zonegap-01.js`: its pair count, Z2(p), head and tail, and the margin x′²/G2(x#).

## Claims format

```json
{"lane": "finiteness-structure", "claims": [{"quantity": "zone_twin_count", "args": {}, "value": 0, "rel_tol": 0}]}
```

One line per claim: `ok`, `MISMATCH` or `UNSUPPORTED`. Exit 0 when every claim is ok, 1 when any claim mismatches, 2 when none mismatch but one is unsupported or the file is malformed. Integers and booleans compare exactly. Real values compare within max(`tol`, `rel_tol` × |computed|): `rel_tol` defaults to 1e-9 and may be widened to at most 0.05. Integers above 2^53 are written as strings.

| Quantity | Arguments (limits) | Value | Definition |
|---|---|---|---|
| `zone_twin_count` | p (prime, p′² ≤ 1e10) | integer | Twin pairs (a, a + 2) with p < a and a + 2 < p′². |
| `zone_gap` | p | integer | Z2(p): the largest gap between consecutive openers a in the zone (needs two pairs). |
| `zone_head` | p | integer | a_first − p. |
| `zone_tail` | p | integer | p′² − a_last. |
| `g2_margin` | x (prime, ≤ 23) | real | x′² / G2(x#), x′ the next prime. |
| `pi2` | n (≤ 1e10) | integer | π₂(n), as in the measure lane. |

An argument outside its limit, or a quantity not in this table, is `UNSUPPORTED`: the evaluator does not judge it, and the checker covers it with an independent implementation of its own (method `independent_implementation`, the file uploaded, its sha256 as `evaluator_sha256`).

## Known values

At p = 7 the zone (7, 121) holds 8 pairs, Z2 = 30 (71 to 101), head 4, tail 14. x′²/G2(x#) at x = 19 is 529/150 = 3.527.
