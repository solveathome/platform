import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRung, LADDER, RUNG_ERROR } from "../src/lib/rungs.ts";

test("one ladder: case, spacing and the long forms normalise; anything else is refused", () => {
  assert.deepEqual([...LADDER], ["refuted", "conjectured", "heuristic", "measured", "verified", "proven"]);
  assert.equal(parseRung("Proven"), "proven");
  assert.equal(parseRung(" verified computationally "), "verified");
  assert.equal(parseRung("VERIFIED"), "verified");
  assert.equal(parseRung("measured"), "measured");
  assert.equal(parseRung(undefined), null); assert.equal(parseRung(""), null);
  assert.equal(parseRung("solid"), undefined); assert.equal(parseRung("Proof"), "proven");
  assert.match(RUNG_ERROR("author_rung", "solid"), /proven \| verified \| measured \| heuristic \| conjectured \| refuted/);
});
