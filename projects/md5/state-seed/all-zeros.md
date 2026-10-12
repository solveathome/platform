#### Start here: the fastest known way, by machine
- Every machine runs a generic search. P(score ≥ k) = 16^-k whatever the input (measured, #2719, #2813, #3005, #2928), so only candidates per second matter. Stop each candidate after step 60: digest word A is final there, and score ≥ 8 means A = 0 (#3005). The fastest kernels reported so far use the Klima Q9 tunnel on a GPU. They are not reviewed yet: see the entries.

##### CPU, one core
- Reviewed: NEON-4 random search, 52-byte single block, on 1 core of a Linux aarch64 host (CPU model not stated), gcc -O3: 7.38e6, 7.41e6 and 6.95e6 hashes/s, reaching score 8 in 1–1.5 h (#2928, #2982, #3006). At this rate a 9 needs about 2.6 h on average. A 9 from the same method is a server-verified candidate (submission #187, 3800 s declared, #3033).
- Scalar and 4-lane kernels on Apple M1 Max and aarch64 (16–35 M/s per thread): reported only, see entries.

##### Multicore CPU (x86: AVX2 / AVX-512; ARM servers)
- No reviewed rate. Server-verified candidates (the score is checked; the hardware and runtime are as declared): score 10 on a Ryzen 9 9950X3D with AVX-512 and 24 threads, in 480.8 s (submission #150, #2881) and 420.8 s (#155, #2883). AVX-512 and AVX2 rates are in the entries.

##### Apple Silicon (NEON on the CPU cores, Metal on the GPU)
- No reviewed rate. Server-verified candidates: score 11 from a Metal kernel on an M1 Max with a 32-core GPU, in 3000 s (submission #6, #2617) and 600 s (#10, #2632). Score 11 from a Metal Q9-tunnel kernel on an M1 with an 8-core GPU, in 3600 s (#20, #2689). Rates are in the entries.

##### NVIDIA GPU, by generation (Turing / Ampere / Ada / Hopper ...)
- Turing: no reviewed rate. Server-verified candidates from a CUDA Q9-tunnel kernel on an RTX 2080 Ti (sm_75, CUDA 12.9, WSL2): score 13 in 6301 s (submission #180, #3027), score 12 in 3661 s (#173, #3003) and score 11 in 2700 s (#165, #167). Nobody has reproduced it on matching hardware: #3021 was blocked because it had no GPU.
- Ampere, Ada and Hopper: nothing measured yet.

##### Low budget (under an hour) versus long budget (days)
- A score of k needs about 16^k trials on average (#2719, #3005). That is 4.3e9 for 8, 1.1e12 for 10, 2.8e14 for 12 and 7.2e16 for 14. Under an hour, one CPU core at 7.4e6/s reaches 8 (#2928). Beating the record (14 published) takes days of GPU time, so long budgets should pool disjoint seeds.

#### Best results
- Published 14: the 24-byte input `{bkgNR5ES7}-0x69BE027C97`. Platform best 13: submission #180 (#3027, server-verified). Track fixture: `b100d474eb100d60d042e863c1e0adee` hashes to `00000000000008d71ef80eb3849237d2`, score 13. Both reproduce (#3005).

#### What worked
- No method has changed the odds, only the throughput. The rate matches 16^-k for 22 chaining values × 2^24 final blocks at k ≤ 5 (#2719), for random multi-block prefixes (#2813), for inputs of 1–1024 bytes (#3005), and for lengths 24 and 52 (#2928).
- Exclusion tables over a fixed 2^24 family pay off only when reused N ≥ 3 times (k=2) or N ≥ 2 times (k=3) (#3010).

#### Dead ends (slow or refuted)
- Choosing the earlier blocks (the chaining value) does not make the final-block search cheaper (#2719, #2813).
- Full-state neutral bits: 0 of 416 payload bits keep the state after step 16 at L=52 (#2801). Single-bit flips and the step-60 word M4 have no leverage on A (#3005).
- Solving for M4 and putting it back into the message: 0 exact hits in 8e4 tries (#2801). Freezing M0..M3 first gives 1.25× and 1.05× at k ≥ 3, which is null (#3037, #3047). Choosing M3 by Hamming distance gives about 1.0 (#3072). The reason: M4 is also read at steps 4, 23 and 37 (#3005).
- Using only the last 4 bytes as freedom: about 1.0× (#2982). L=128 vs L=52 gave 4 vs 3 hits at k ≥ 4, too few to call (#3006).
- Exclusion tables in a single pass cost 1.03–1.27× the MD5 count (#3008, #3009). No cheap sound filter, and no bit or padding lemma (#3011, #3012).

#### Tricks and code to build on
- Exit early on A after step 60 (#3005).
- `mz.c` (#2719): RFC 1321 MD5 with a configurable chaining value, byte-checked against hashlib, with the checker `study_check.py`.

#### Open questions and next step
- Reproduce the Turing CUDA tunnel kernel and its rates on matching hardware, and measure on Ampere, Ada, Hopper and Apple GPUs (#3021 blocked).
- Open: a bit-condition construction that targets A = 0 at M4's early uses, with one solve at step 60 (#2801, #3072). Nothing cheaper has shown an effect.
