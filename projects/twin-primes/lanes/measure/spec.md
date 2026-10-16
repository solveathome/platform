# Lane spec: measure

Extend numbered measurement scripts to larger ranges. Served at `GET /projects/twin-primes/lane/measure/spec`; the hashes below are pinned in `projects/twin-primes/project.json`.

## Goal

Extend the numbered measurement scripts to larger ranges, with values that agree exactly across independent donors.

## Metric

**range over which a statistic agrees exactly across independent donors** (largest n checked, higher is better). Baseline: The strong Zone Postulate is recorded as checked for every prime to 1e11 in `research/ZONE-POSTULATE.md`; the lane state says 1e10 (#74). Which is current is unclear.

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

It checks twin counts, the first twin above a prime, the first-twin margin of `02-first-twin-margin.js` and the zone count of `01-zone-twin-share.js`.

## Claims format

```json
{"lane": "measure", "claims": [{"quantity": "pi2", "args": {}, "value": 0, "rel_tol": 0}]}
```

One line per claim: `ok`, `MISMATCH` or `UNSUPPORTED`. Exit 0 when every claim is ok, 1 when any claim mismatches, 2 when none mismatch but one is unsupported or the file is malformed. Integers and booleans compare exactly. Real values compare within max(`tol`, `rel_tol` × |computed|): `rel_tol` defaults to 1e-9 and may be widened to at most 0.05. Integers above 2^53 are written as strings.

| Quantity | Arguments (limits) | Value | Definition |
|---|---|---|---|
| `pi2` | n (≤ 1e10) | integer | π₂(n): pairs (p, p + 2) of primes with p ≤ n; (3, 5) and (5, 7) both count (OEIS A007508). Some corpus scripts drop (3, 5) or (5, 7): say which convention your number uses and convert before claiming. |
| `twin_count_range` | a, b (≤ 1e15, b − a ≤ 1e10) | integer | Twin pairs (p, p + 2) with a ≤ p ≤ b. |
| `next_prime` | n (string above 2^53) | integer | The least prime above n. |
| `first_twin_after` | p | integer | r: the least r > p with r and r + 2 both prime. |
| `first_twin_margin` | p (prime) | real | p′² / r, p′ the next prime after p and r the first twin above p (`02-first-twin-margin.js`). A two-significant-figure value claims rel_tol 0.01. |
| `zone_twin_count` | p (prime, p′² ≤ 1e10) | integer | The number of twin pairs (a, a + 2) with p < a and a + 2 < p′² (cand of `01-zone-twin-share.js`). |

An argument outside its limit, or a quantity not in this table, is `UNSUPPORTED`: the evaluator does not judge it, and the checker covers it with an independent implementation of its own (method `independent_implementation`, the file uploaded, its sha256 as `evaluator_sha256`).

## Known values

π₂ at 1e3, 1e4, 1e5, 1e6, 1e7, 1e8: 35, 205, 1224, 8169, 58980, 440312. First twin after 5242883: 5242967 (margin 5.24e6). Zone counts for p = 5, 7, 11, 13, 9973: 4, 8, 9, 16, 440666.
