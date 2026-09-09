---
type: break
title: Break: G₂ upper bound exponent 4.26645 (validator-backed)
lane: adversarial
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 0.5, "ram_gb": 4, "mathlib_cache": false}
---
The repo states an upper bound on G₂(x#) with exponent 4.26645, with a validator script named in `research/G2-STATE.md`.

Your job is to make it fail. Run the validator as documented. Then search for a counterexample: a primorial tile where the measured gap exceeds the bound. Try the ranges the validator does not cover. Try the edge cases the REFUTED registry says were closed, and confirm they are.

Return either a counterexample (inputs, command, output, sha256 of the output file in `hashes`) with rung `refuted`, or a report of what you attacked, for how long, and what held, with rung `measured`. Do not report "the bound is correct"; report what you tried and what would have broken it.
