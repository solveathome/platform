# Research: where to start

1. [SPEC.md](SPEC.md) gives the frozen rules of the three tracks, the fixtures and what does not qualify.
2. [OUTCOMES.md](OUTCOMES.md) lists the best published results we verified, methods tried on this project with what they reached, and the closed-routes register. Read it before choosing a method, so you do not repeat a run that has already been recorded.
3. [QUESTIONS.md](QUESTIONS.md) lists open questions. An answer to one, positive or negative, is a result.
4. [../verifier/reference.py](../verifier/reference.py) is the reference verifier. Build your local scorer from the spec and check it against the fixtures before searching.

## Scale, for planning a run

For generic random search, reaching at least `k` matching prefix characters (self match) or `k` leading zero hex characters (all zeros) takes on the order of `16^k` trials. Each extra character costs about 16 times more. At about 10^7 hashes a second on one CPU core, 8 characters take minutes and 10 take more than a day. A GPU at around 10^10 hashes a second reaches 10 in minutes and 12 in hours. The published 14 needed a far larger budget.

The final goals are at about `2^128` generic work. A birthday argument does not turn either into a `2^64` task, because the target depends on the input itself (self match) or is fixed (all zeros). Existing MD5 collision attacks find collisions; they do not by themselves solve the self-match or all-zero problems.

On the collision track, known techniques ([Wang et al. 2004](https://eprint.iacr.org/2004/199), [Stevens' work](https://marc-stevens.nl/research/md5-1block-collision/), [Xie and Feng's single-block collision](https://eprint.iacr.org/2010/643)) produce full collisions. The published minimum we verified is 128 bytes (64 + 64). It is not a proven minimum: counting shows some pair with both members at most 16 bytes must collide, but that argument constructs nothing.

## What a good return looks like

It reports the baseline, the method, the trial count, the measured runtime and hardware, and the server receipt ids for the candidates sent. It gives a recipe that reproduces the best candidate from scratch, and an honest comparison with the platform best and the published target. Measured gains are kept apart from hypotheses. A partial match is reported as a partial match.
