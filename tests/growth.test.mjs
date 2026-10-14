import { test } from "node:test";
import assert from "node:assert/strict";

// The growth cap (mba #mba-bot-sites-growth-cap; src/lib/growth.ts): the cap from a scan's baseline and the site's rate, the order
// held units are let in, and how many go in under the cap. The database half (the gate in a save, the scan) is tests/growth-db.test.mjs.
const { capOf, choose, releaseOrder, unitIndexable, INDEXABLE_SQL, GROWTH_RATE } = await import("../src/lib/growth.ts");

const unit = (id, popularity, day, extra = {}) => ({ kind: "return", id, popularity, created_at: `2026-10-${day}T12:00:00Z`, first_indexed_at: null, index_held_at: null, index_ok: null, ...extra });

test("the cap is floor(baseline x (1 + rate)): 15 % by default, under 2 % for a site Google dropped", () => {
  assert.equal(GROWTH_RATE, 0.15);
  assert.equal(capOf(1000, 0.15), 1150);
  assert.equal(capOf(2705, 0.15), 3110);
  assert.equal(capOf(2705, 0.0199), 2758);
  assert.equal(capOf(100, 0.0199), 101);
  assert.equal(capOf(0, 0.15), 0);
});

test("release order: the most reviewed and cited first, then the newest first public", () => {
  const order = [unit(1, 0, "10"), unit(2, 3, "10"), unit(3, 0, "12"), unit(4, 3, "11"), unit(5, 0, "11", { first_indexed_at: "2026-10-13T00:00:00Z" })].sort(releaseOrder).map((u) => u.id);
  assert.deepEqual(order, [4, 2, 5, 3, 1]);
});

test("choose lets units in while the count stays at or under the cap, one URL each, and holds the rest in order", () => {
  const c = [unit(1, 0, "10"), unit(2, 5, "10"), unit(3, 1, "12"), unit(4, 0, "13")];
  const { release, hold } = choose(98, c, 100);
  assert.deepEqual(release.map((u) => u.id), [2, 3]);
  assert.deepEqual(hold.map((u) => u.id), [4, 1]);
  assert.deepEqual(choose(100, c, 100).release, []);
  assert.equal(choose(0, c, 100).hold.length, 0);
  assert.equal(choose(105, c, 100).release.length, 0, "over the cap already: nothing goes in");
});

test("indexable means let in, not held, and not sent as index:false; the SQL says the same", () => {
  assert.equal(unitIndexable({ first_indexed_at: "2026-10-01", index_held_at: null, index_ok: null }), true);
  assert.equal(unitIndexable({ first_indexed_at: "2026-10-01", index_held_at: null, index_ok: true }), true);
  assert.equal(unitIndexable({ first_indexed_at: "2026-10-01", index_held_at: "2026-10-12", index_ok: null }), false);
  assert.equal(unitIndexable({ first_indexed_at: "2026-10-01", index_held_at: null, index_ok: false }), false);
  assert.equal(unitIndexable({ first_indexed_at: null, index_held_at: null, index_ok: null }), false, "not yet gated");
  assert.equal(unitIndexable({ first_indexed_at: "2026-10-01" }), true, "a research route has no index judgement of its own");
  assert.equal(INDEXABLE_SQL("r"), "(r.first_indexed_at IS NOT NULL AND r.index_held_at IS NULL AND r.index_ok IS DISTINCT FROM false)");
  assert.equal(INDEXABLE_SQL("x", false), "(x.first_indexed_at IS NOT NULL AND x.index_held_at IS NULL)");
});
