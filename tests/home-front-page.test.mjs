import { test } from "node:test";
import assert from "node:assert/strict";

// The front page holds every public problem and never a hidden one (Oct 9 2026): the same rule as /projects and the sitemap,
// so publishing a project puts it on the front page with no code change. The last entry always invites the next problem.
const { publicProjects, homeIndex, homeCards, PROPOSE_URL } = await import("../src/lib/home.ts");

const rows = [{ slug: "twin-primes", name: "Twin Prime Conjecture" }, { slug: "md5", name: "MD5 Research Challenge" }];

test("a hidden project is on neither the index nor the cards", () => {
  const list = publicProjects(rows, ["md5"]);
  assert.deepEqual(list.map((p) => p.slug), ["twin-primes"]);
  assert.doesNotMatch(homeIndex(list) + homeCards(list), /md5/i);
});

test("MD5 is public (Oct 9 2026): the second card, a record challenge, before Propose a problem", () => {
  const list = publicProjects(rows, []);
  assert.deepEqual(list.map((p) => p.slug), ["twin-primes", "md5"]);
  const cards = homeCards(list), index = homeIndex(list);
  assert.match(cards, /Problem 002 · Cryptography · hash functions/);
  assert.match(cards, /data-project="md5" data-challenge=/);
  assert.match(cards, /href="\/projects\/md5#contribute"/);
  assert.match(index, /<span class="n">003<\/span><span><b>Propose a problem<\/b>/);
});

test("a public project gets a numbered card built from its folder, then Propose a problem", () => {
  const list = publicProjects(rows, ["md5"]);
  const cards = homeCards(list), index = homeIndex(list);
  assert.match(cards, /Problem 001 · Mathematics · number theory/);
  assert.match(cards, /data-project="twin-primes"/);
  assert.match(cards, /Why it matters\./);
  assert.match(cards, /class="prime-pair"/);
  assert.match(cards, /href="\/projects\/twin-primes#contribute"/);
  assert.match(cards, /Problem 002 · any field/);
  assert.ok(cards.includes(`href="${PROPOSE_URL}"`) && index.includes(`href="${PROPOSE_URL}"`));
  assert.match(PROPOSE_URL, /^https:\/\/discord\.gg\//);
  assert.match(index, /<span class="n">002<\/span><span><b>Propose a problem<\/b>/);
});

test("an unknown project still renders from its row, escaped", () => {
  const list = publicProjects([{ slug: "demo", name: "<Demo> & co", summary: "Is it?" }], []);
  assert.equal(list.length, 1);
  const html = homeCards(list);
  assert.match(html, /&lt;Demo&gt; &amp; co/);
  assert.match(html, /<p class="question">Is it\?<\/p>/);
});
