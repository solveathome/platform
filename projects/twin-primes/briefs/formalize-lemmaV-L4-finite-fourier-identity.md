---
type: formalize
title: Formalize: L4 of lemmaV-parseval.js, sum_{a != 0 mod e} F_H(a/e) = h(e-h) for H = Qe + h
lane: formalize
git_ref: main
budget_hours: 3
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": true}
---
Calibration per `CLAUDE.md`: L4 is a finite identity proved in one paragraph inside `research/lemmaV-parseval.js` (embedded output, section S1) and verified numerically for e <= 30, H <= 40. The lemma it serves (mean-square Lemma V) is PROVEN in the repo; the route above it is CLOSED (`research/OUTCOMES.md`, 2026-08-18). A Lean proof fixes the rung of this identity only.

Statement. For integers e >= 1 and H >= 1 write H = Qe + h with 0 <= h < e. Let F_H(t) = |sum_{m=1}^{H} e(mt)|^2 where e(t) = exp(2 pi i t). Then sum_{a=0}^{e-1} F_H(a/e) = e #{(m, n) in [1, H]^2 : e | m - n} = e(eQ^2 + 2hQ + h), and subtracting the a = 0 term H^2 gives sum_{a=1}^{e-1} F_H(a/e) = h(e - h). Consequences stated in the script: Psi(g, delta, H) = sum_{a != 0} F_H(a/g) e(-a delta/g) satisfies |Psi| <= h(g-h) (the script's (V2)) and Psi = 0 when g | H (its (V1)).

Write a Lean 4 file against Mathlib proving the counting identity and the sum. Route: expand |sum e(mt)|^2 as a double sum, swap with the sum over a, and use orthogonality sum_{a mod e} e(a(m-n)/e) = e if e | m-n else 0 (Mathlib has roots-of-unity sums; `ZMod` character orthogonality may be the shortest path). Then count pairs (m, n) in [1, H]^2 with e | m - n by residue class: the class sizes are Q+1 for h classes and Q for the others, giving h(Q+1)^2 + (e-h)Q^2 = eQ^2 + 2hQ + h. If you prefer, prove the counting identity over ℕ first and the complex identity second, and say which parts compile.

Return the `.lean` file, toolchain, build output and sha256 in `hashes`. Grade `conjectured` if sorries remain, `proven` for the identity otherwise.
