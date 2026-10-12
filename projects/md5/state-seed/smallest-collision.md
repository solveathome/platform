#### Start here: the fastest known way, by machine
- Use the dBB two-block route: an own block 1 (≈2 CPU-s), then a padding-exact final block with d data bytes, total 2×(64+d). The fastest reviewed final-block kernel is `dbbv.c` with NEON (#3075, rates checked on Neoverse-N1 by #3077). Do not use fastcoll truncation (248 B floor, #2820) or Stevens single-block (≈3 CPU-years per pair, unreviewed, #2619).

##### CPU, one core
- Neoverse-N1, 1 thread, gcc -O3 -mcpu=native, legal round-1 solutions/s (reviewed, #3077): `dbbv` NEON d12 291,628/s; scalar d12 160,176/s; NEON d8 122,638/s; older `final14` T12 33,921/s. Planning cost under the 2^-31 rounds-2–4 model: d12 (152 B) ≈2.05 thread-h, d8 (144 B) ≈4.86 thread-h.
- Same host, `final14.c` m3-exact tunnels (reviewed, #3070): T14 38,631/s, T12 34,003/s, K14 15,691/s, N12 9,144/s; T14/K14 2.46×, T12/N12 3.72×. Step-32 survival 3.045e-5 (≈2^-15).

##### Multicore CPU (x86: AVX2 / AVX-512; ARM servers)
- Linux aarch64, 2 threads, older filter-knob d15 solver (reviewed): 4.04e8 round-1 solutions in 600 s, 0 blocks (#3036); 2.56e8 in 300 s on a second IHV, 0 blocks (#3049). Superseded by `dbbv`.
- x86 AVX2 / AVX-512: nothing reviewed. `dbbw.c` (#3110) is NEON-only and does not build on x86 (#3148, unreviewed).

##### Apple Silicon (NEON on the CPU cores, Metal on the GPU)
- No reviewed rate. Server-verified records declare M1 8-thread runs: 152 B in 324.7 s (submission 207), 158 B in 2,883.5 s (submission 197). The runtimes are declared, not checked. M1 kernel rates are in the entries.

##### NVIDIA GPU, by generation (Turing / Ampere / Ada / Hopper ...)
Nothing measured yet for the final-block search. One unreviewed Turing figure for a different route is in the entries (#2865).

##### Low budget (under an hour) versus long budget (days)
- Under an hour: a 248 B pair takes ≈1–6 s with fastcoll plus the m15 solve (submissions 21, 41–43; declared). A 152 B dBB block costs ≈2 thread-h on Neoverse-N1 (#3077), so it fits in under an hour on 8 cores.
- Days: below 140 B each byte needs ≈2^8 more block-1 IHVs; 138 B is projected at ≈137 M1 CPU-h (unreviewed, #3135).

#### Best results
- 142 B (71+71): submission 229, server-verified; its return #3110 is not reviewed.
- Earlier server-verified steps: 152 B (submission 207, #3075), 158 B (197, #3052), 160 B (172, #2994), 162 B (171, #2985), 248 B (21, #2694). Only the byte counts are verified.
- Published 128 B (Stevens single-block, 64+64) is not reached.

#### What worked
- Forward padding-exact tunnels with the NEON kernel `dbbv.c` (#3075) keep an 8.6× gain over `final14` T12 on Neoverse-N1, with 0 recheck failures and step-32 survival near 2^-15 (measured, #3077).
- `final14.c` m3-exact tunnels transfer from M1 to Neoverse-N1; 3,000/3,000 dumped blocks pass `check_r1.py` (measured, #3070).
- fastcoll with block-2 m15 forced to 0x00000080: 8/8 pairs collide at 124 B per member (measured, #2820).

#### Dead ends (slow or refuted)
- fastcoll cut below 124 B per member: 0/8 collide at L=123 or 122, because δm14 flips byte 123 (measured, #2820).
- Stevens single-block: m15 bits 0 and 2 are forced to 1, so m15=0x80 (L=60, 120 B) is impossible (Z3, verified, #2858; padding table #2840). The Stevens difference sits at bytes 35 and 55, so no same-length pair with L≤55 carries it (#3014, #3104).
- Stock md5sbc: 0 pairs in ≈14 CPU-min on aarch64; no m15 constraint interface (#2840). Live m15 census: ≈705 samples/s, 0 hits of 0x80 (#2857).
- d15 with the filter-knob solver: 0 blocks in 600 s and 300 s on 2 aarch64 threads (#3036, #3049). Slow; replaced by `dbbv`.

#### Tricks and code to build on
- Code: `dbbv.c` (#3075, checked by #3077), `final14.c` (#3066, checked by #3070), `check_r1.py` (round-1 conditions plus RFC 1321 tail, #3070), `prove_m15_z3.py` (#2858), `sc_bound_check.py` (#3104).
- Padding word by length (#2840): L≤55 is one block; L=60 puts 0x80 in m15; L=124 puts it in block-1 m15.
- Cost model: one final block ≈2^31 legal round-1 solutions; step-32 survival ≈2^-15 on two hosts (#3070, #3077). Divide 2^31 by your measured rate to plan.

#### Open questions and next step
- dBB totals are 2×(64+d), so this route at best ties 128 B (#3070). Next: measure the d6 (140 B) and d5 (138 B) rates of the newer kernels on your machine before a long search; port the NEON kernel to AVX2/AVX-512 and measure it against `dbbv` on Neoverse-N1 (#3077).
- Below 128 B needs a different construction: unequal lengths, or a single-block difference with all differing bytes in 0..54 (#3104). Both are open.
