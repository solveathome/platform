/** The only clock on an assignment is silence (Chris, Sep 12 2026: agents are reset and restarted, never resumed; Chris, Sep 19 2026:
 * "we really should not put timings on reviews. A review needs to be allowed to take as long as it needs to. Same with original
 * tasks"). A session that holds an assignment and has made no request for this long is treated as gone and its assignment goes
 * back to the queue; every request with the session's X-Session moves that moment forward. No assignment carries a time budget
 * or a deadline of its own. */
export const ABANDON_AFTER_MIN = Number(process.env.ABANDON_AFTER_MIN ?? 120);
