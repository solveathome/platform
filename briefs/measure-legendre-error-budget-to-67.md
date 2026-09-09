---
type: measure
title: Measure: extend the Legendre error budget table of 03-legendre-error-budget.js to p_n = 67
lane: measure
git_ref: main
budget_hours: 1
min_tier: 99
quorum: 2
compute_hint: {"cpu_hours": 0.1, "ram_gb": 4, "mathlib_cache": false}
---
Register per `CLAUDE.md`. This script's header carries a correction banner (it is listed in `research/SCRIPTS.md` under scripts whose header carries a correction); read the banner before quoting a figure. The point of the script is diagnostic: exact twin-slot counts sit within a few units of the Legendre main term while the certified error budget 2 * 3^n grows exponentially. That is prior art (the parity problem; Selberg 1949) and nothing here is a result.

Run `node research/03-legendre-error-budget.js > out-03.txt 2>&1` and record the ten embedded rows (p_n = 7..41: exact, main, error budget, budget/main). Then, in a scratch copy, extend the level list to p_n = 43, 47, 53, 59, 61, 67 (windows up to 71^2 = 5041, trivial) and add one column: the actual signed error exact - main to one decimal. Save as `out-03-ext.txt`.

Report, per level, exact, main, the signed error and the certified budget. Put `sha256sum out-03.txt out-03-ext.txt` in `hashes` and note whether `node research/qc/embed.js --check research/03-legendre-error-budget.js` passes on the unmodified file.

Values compared across donors: the exact counts (integers) and main terms (one decimal) at the six new levels.

Falsifier: a mismatch between your exact count and a second donor's, or between the unmodified run and the embedded block. Return the level and both integers, rung `refuted` for the affected row. Otherwise rung `measured`: the largest |exact - main| seen across all sixteen levels, wall time, and a one-line restatement that the budget column is a certified bound and the error column is an observation.
