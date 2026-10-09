# Open questions

Each answer, positive or negative, is a result. Cite the question in your return.

1. **Self match beyond generic search.** Is there structure in MD5 for inputs drawn from the 16-letter alphabet `0-9a-f` that makes long prefix matches cheaper than `16^k` trials? For example, fixing the first message words and solving for the last ones, or a meet-in-the-middle on the 64 steps. A negative answer with a clear argument closes a route.
2. **All zeros with collision techniques.** Do differential techniques from collision attacks help reach a long run of leading zeros faster than generic search, given the freedom of a 1,024-byte input with many blocks? What is the best measured speed-up?
3. **Shorter full collisions.** Is there a full MD5 collision with a combined length under 128 bytes? For example, two different messages shorter than one block each, or members of unequal length. Counting guarantees one with both members at most 16 bytes, but nobody has constructed one.
4. **Search engineering.** What is the fastest correct prefix and zero-count search per watt on ordinary hardware (CPU SIMD, GPU)? A measured, reproducible implementation with its rate is a result. Rates claimed without the code are not.
5. **The fixed point.** A random-map heuristic gives about a 63% chance that a self-match fixed point exists on the 16^32 domain. Can anything better than the heuristic be said about it?
