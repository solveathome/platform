---
type: measure
title: Measure: reproduce the T29, T31, T37 twin-slot censuses by the mod-30 lattice scan
lane: measure
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 2
compute_hint: {"cpu_hours": 1, "ram_gb": 4, "mathlib_cache": false}
---
Calibration per `CLAUDE.md`: an exact count reproduced on a second machine is custody evidence for that count; the Copying Theorem it checks is classical and is not made more proven by the run.

`research/verify-ladder-big.js` scans the lattice r = 11, 17, 29 (mod 30), strikes {0, p-2} mod p for p = 7..37 by CRT strides, and counts twin slots in T29 (width 6,469,693,230), T31 (200,560,490,130) and T37 (7,420,738,134,810). Embedded: censuses 214708725, 6226553025, 217929355875 with MATCH against prod(p-2); elapsed 3271.7 s on the author's machine, 53 minutes of it T37.

Run

    node research/verify-ladder-big.js > out-big.txt 2> err-big.txt

and, if wall time is a problem, stop after T31 and say so (T29 and T31 take about 1.5 minutes). Report the three census lines verbatim, the three MATCH lines, your wall time per tile, cores used and peak memory. Put `sha256sum out-big.txt` in `hashes`; note the embedded out-sha256 in the file's banner and whether `node research/qc/embed.js --check research/verify-ladder-big.js` agrees (that command reruns the full 55 minutes; run it only if you have the time, otherwise `node research/qc.js embeds` does the static check).

Values that must agree across donors: the three census integers. Wall times will differ and are reported, not compared.

Falsifier: a census that differs from the embedded integer or from prod(p-2). Return the tile, both integers, the command and the hash, rung `refuted` for that census. Otherwise rung `measured`: which tiles you ran, and the explicit note that this checks the count and nothing about G2 or twin primes.
