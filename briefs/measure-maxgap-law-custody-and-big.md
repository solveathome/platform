---
type: measure
title: Measure: reproduce maxgap-law.js (default and --big) and its three-engine custody block
lane: measure
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 2
compute_hint: {"cpu_hours": 0.3, "ram_gb": 8, "mathlib_cache": false}
---
Register per `CLAUDE.md`. The script's own banner records a forced embed on 2026-08-21 with 30 of 1389 figures in the replaced block not reproduced; read that banner and the READINGS before quoting. The law maxgap ~ c mbar lnD is a measured reading; the Maier-Pomerance comparison it tests is against a conjecture, and the Kourbatov maximal-twin-gap law is prior art (`research/SEARCH-CONVENTIONS.md` section 3).

Run first the default invocation `node research/maxgap-law.js > out-mg.txt 2>&1` and then the embedded one, `node --max-old-space-size=8192 research/maxgap-law.js --big > out-mg-big.txt 2>&1` (embedded elapsed 148 s). Report section S1 verbatim: the c1, c2, c2' custody lines (mean, sd, cv, range) with their MATCH verdicts, the reconciliation lines, and the exact-tile table of (x, mode, period, slots, mbar, max gap, published, MATCH) for x = 7..23 and whatever the --big run adds at x = 29 and 31. Then report the headline fit lines of the later sections as printed, without rounding them yourself.

Put `sha256sum out-mg.txt out-mg-big.txt` in `hashes`, and record what `node research/qc.js embeds` says about the file's static hashes.

Values compared across donors: every integer in the exact-tile table, and the c1/c2/c2' means to four decimals.

Falsifier: a MATCH verdict reading otherwise, or an exact-tile max gap differing from the repo ladder (10, 30, 14, 42, 22, 66, 26, 108, 34, 150, 40, 204 embedded for x = 7..23 in mode order). Return the row, rung `refuted`. Otherwise rung `measured`: which figures of the 30 "not reproduced" you could and could not reproduce, wall time and memory.
