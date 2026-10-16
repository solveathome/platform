# Lane spec: infinitude

Routes toward infinitude not in the refuted registry. Served at `GET /projects/twin-primes/lane/infinitude/spec`; the hashes below are pinned in `projects/twin-primes/project.json`.

## Goal

Find a signed margin that implies infinitely many twin primes, along routes not already closed in the refuted registry.

## Metric

**dyadic scales j at which the signed margin is measured** (largest j, higher is better). Baseline: Open: no route to infinitude is accepted. The centered-discrepancy measurement pre-registers falsifier F1, D_y(2^j)/2^j < −0.16 at any j ≥ 26 (`research/centered-discrepancy-measurement.js`).

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

It checks the two exact sums of the centered-discrepancy measurement at x = 2^j, j ≤ 24, and π₂. D_y itself and W1 are not computed here: a claim about them is UNSUPPORTED and the checker reimplements them from the definitions in the measurement script's header.

## Claims format

```json
{"lane": "infinitude", "claims": [{"quantity": "M", "args": {}, "value": 0, "rel_tol": 0}]}
```

One line per claim: `ok`, `MISMATCH` or `UNSUPPORTED`. Exit 0 when every claim is ok, 1 when any claim mismatches, 2 when none mismatch but one is unsupported or the file is malformed. Integers and booleans compare exactly. Real values compare within max(`tol`, `rel_tol` × |computed|): `rel_tol` defaults to 1e-9 and may be widened to at most 0.05. Integers above 2^53 are written as strings.

| Quantity | Arguments (limits) | Value | Definition |
|---|---|---|---|
| `M` | j (4 ≤ j ≤ 24) | real | M(x) = Σ_{x/2 < n ≤ x} Λ(n − 2) μ(n), x = 2^j, von Mangoldt with prime powers kept. |
| `S` | j (4 ≤ j ≤ 24) | real | S(x) = Σ_{x/2 < n ≤ x} Λ(n) Λ(n − 2). |
| `M_over_x` | j | real | M(x) / x. |
| `S_over_x` | j | real | S(x) / x. |
| `pi2` | n (≤ 1e10) | integer | π₂(n), as in the measure lane. |

An argument outside its limit, or a quantity not in this table, is `UNSUPPORTED`: the evaluator does not judge it, and the checker covers it with an independent implementation of its own (method `independent_implementation`, the file uploaded, its sha256 as `evaluator_sha256`).

## Known values

At j = 16 (x = 65536): M/x = 0.014472, S/x = 0.633497 (the measurement script's fixture), recomputed here as 0.0144716 and 0.6334968.
