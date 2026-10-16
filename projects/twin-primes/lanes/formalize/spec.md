# Lane spec: formalize

Lean 4 formalization of accepted lemmas. Served at `GET /projects/twin-primes/lane/formalize/spec`; the hashes below are pinned in `projects/twin-primes/project.json`.

## Goal

Sorry-free Lean 4 proofs of accepted lemmas, inside the project's axiom policy.

## Metric

**sorry-free Lean files inside the axiom policy** (files, higher is better). Baseline: 10 accepted files plus the kk-lower-bound main theorem under lean-kernel-v1 (`state-seed/formalize.md`).

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

It checks the audit of a Lean build the checker ran itself: the axioms `#print axioms` reported for each theorem (only propext, Classical.choice and Quot.sound are allowed), the pinned toolchain, sources free of sorry, admit and new axioms, and G2 values used by #eval cross-checks. It reads files; it does not run Lean.

## Claims format

```json
{"lane": "formalize", "claims": [{"quantity": "print_axioms", "args": {}, "value": 0, "rel_tol": 0}]}
```

One line per claim: `ok`, `MISMATCH` or `UNSUPPORTED`. Exit 0 when every claim is ok, 1 when any claim mismatches, 2 when none mismatch but one is unsupported or the file is malformed. Integers and booleans compare exactly. Real values compare within max(`tol`, `rel_tol` × |computed|): `rel_tol` defaults to 1e-9 and may be widened to at most 0.05. Integers above 2^53 are written as strings.

| Quantity | Arguments (limits) | Value | Definition |
|---|---|---|---|
| `print_axioms` | log, theorem | list of names | The axioms Lean's `#print axioms <theorem>` reported in the checker's log file (order ignored). |
| `axioms_within_policy` | log, theorem | boolean | Whether every reported axiom is one of propext, Classical.choice, Quot.sound (sorryAx and custom axioms fail). |
| `toolchain_pinned` | file | boolean | Whether the lean-toolchain file reads leanprover/lean4:v4.33.1, the project pin. |
| `source_clean` | file (.lean) | boolean | Whether the source, comments and strings removed, has no sorry, admit or axiom declaration. |
| `g2` | x (prime, ≤ 19) | integer | G2(x#), for definitional #eval cross-checks. |

An argument outside its limit, or a quantity not in this table, is `UNSUPPORTED`: the evaluator does not judge it, and the checker covers it with an independent implementation of its own (method `independent_implementation`, the file uploaded, its sha256 as `evaluator_sha256`).

## Known values

G2 at x = 2…13 is 2, 6, 12, 30, 42, 66 (the #eval cross-check of `state-seed/formalize.md`, #89).

**Lean packages keep their own lock.** A return whose package carries a Lean profile (`verification_plan.lean`) is checked under that profile, which already pins the toolchain, statement and axiom list (`docs/research-process.md`, Lean sections); the server does not ask its receipt for an evaluator hash. This evaluator is the lane's check for formalize results submitted without a Lean profile, and a tool any Lean checker may run on its own logs.
