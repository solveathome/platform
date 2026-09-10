---
type: break
title: Break: the mean-square Lemma V bound <R^2>_H <= B(z,s) H (lemmaV-parseval.js)
lane: g2-exponent
git_ref: main
budget_hours: 3
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": false}
---
Calibration per `CLAUDE.md`. `research/G2-STATE.md` lists the mean-square Lemma V as PROVEN: B <= 9 A(z)^2 (E(z)-1) = O((log z)^8), unconditional, for weights supported on divisors of P(z) with |lambda_d| <= 1. The companion finding that B was never the binding term is VERIFIED at z = 13..47 only. The route built on it is CLOSED in `research/OUTCOMES.md` ("Lemma V's mean-square form as the missing factor", 2026-08-18); the lemma itself is what you attack.

`research/lemmaV-parseval.js` (`node research/lemmaV-parseval.js`, about 7 min; `--quick` skips the O(N^2) rows; `S5` runs one section) verifies the chain L1..L5 and Theorem B: R(x) = sum_{m<=H}(c(x+m) - M); <R^2>_H = sum_{|v|<H}(H-|v|)K(v); the Parseval form in Theta_e(a); and the bound C: <R^2>_H <= B(z,s) H with B = sum_{e|P(z), e>1} e Vabs(e)^2. It imports the term list from `research/sift-limit-lemmaV.js`.

Attack the bound, not the identities. The proof takes absolute values in the divisor-pair sum; check whether it silently assumes the weights are the Rosser-Iwaniec ones (the G2-STATE statement claims any |lambda_d| <= 1). Construct adversarial weight vectors on divisors of P(z) for z = 13, 17, 19, compute <R^2>_H exactly over the full period, and compare with B(z,s) H. Try H not dividing the period, H = 1, and H larger than the period. Check L4 (sum_{a != 0 mod e} F_H(a/e) = h(e-h)) for e > H.

Falsifier: weights, z, s, H with <R^2>_H > B(z,s) H, or an identity in the chain failing outside the parameters the script tests. Return the instance, command, output and sha256 in `hashes`, rung `refuted`. Otherwise rung `measured`: the weight families tried, the tightest ratio <R^2>_H / (B H) seen, wall time, and what you could not reach.
