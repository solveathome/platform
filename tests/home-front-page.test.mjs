import { test } from "node:test";
import assert from "node:assert/strict";

// The front page holds every public problem and never a hidden one (Oct 9 2026): the same rule as /projects and the sitemap,
// so publishing a project puts it on the front page with no code change. The last entry always invites the next problem.
const { publicProjects, homeIndex, homeCards, homeSwarm, homeLeaders, siteHeaderHtml, PROPOSE_URL } = await import("../src/lib/home.ts");

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
  assert.match(cards, /data-project="md5" data-challenge /);
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

test("the live figures are in the first render: nothing says Loading, numbers and names come from the data", () => {
  // Client, Oct 2026: "agent stats ... just loaded as the page loaded": the server renders them, the page fetches nothing after load.
  const list = publicProjects(rows, []);
  const data = { at: Date.now(), by: {
    "twin-primes": { totals: { returns_accepted: "592", returns_pending: "53", agents_24h: "71", reviews: "691" }, people: [{ handle: "ada", display_name: "Ada L", points: "50073.8" }, { handle: "bo", points: "9.4" }], active: 17, tracks: null },
    md5: { totals: { returns_accepted: "0", returns_pending: "3", agents_24h: "4", reviews: "2" }, people: [{ handle: "bo", points: "38.9" }], active: 1,
      tracks: [{ id: "a", name: "Self match", better: "higher", max: 32, best: 9, published: 12 }, { id: "c", name: "Smallest collision", better: "lower", max: null, best: null, published: 128 }] } } };
  const html = homeIndex(list, data) + homeCards(list, data) + homeSwarm(list, data);
  assert.doesNotMatch(html, /Loading/);
  assert.match(html, /<dd>592<\/dd>/);
  assert.match(html, /71 agents/);
  assert.match(html, /<b>75<\/b><span>agents, 24 h<\/span>/);   // 71 + 4: sessions add up across problems
  assert.match(html, /here: 9 of 32 · published: 12 of 32/);
  assert.match(html, /here: none yet · published: 128 bytes/);
  // Every track has a bar in the first render (Chris, Oct 9 2026). Smaller is better on the collision track: the published 128 bytes is
  // the goal line at 66.7% of the log scale, the zone past it is overshoot, and nothing verified leaves the bar unfilled.
  const md5Card = html.slice(html.indexOf('id="p-md5"'));
  assert.equal((md5Card.match(/class="mf-bar[ "]/g) ?? []).length, 2);
  assert.match(md5Card, /<span class="mf-bar mf-bar-goal" aria-hidden="true"><b style="left:66\.7%"><\/b><s class="goal" style="left:66\.7%"><\/s><\/span>/);
  assert.match(md5Card, /goal 128 B/);
  assert.match(md5Card, /Smaller is better\. The bar fills toward the goal, the best published collision \(128 bytes\)/);
  const at = (best) => homeCards(list, { at: Date.now(), by: { md5: { ...data.by.md5, tracks: [{ id: "c", name: "Smallest collision", better: "lower", max: null, best, published: 128 }] } } });
  const short = at(256);
  assert.match(short, /<i style="width:50\.0%"><\/i><s class="goal"/, '256 bytes: three halvings of six, short of the goal');
  assert.doesNotMatch(short, /<u /);
  const past = at(64);
  assert.match(past, /<i style="width:66\.7%"><\/i><u style="left:66\.7%;width:calc\(83\.3% - 66\.7%\)"><\/u>/, '64 bytes: filled to the goal, then overshoot');
  assert.match(past, /This one is past the record\./);
  assert.match(html, /<span class="credit-name">Ada L<\/span> <span class="credit-handle">@ada<\/span><\/a><b>50,074<\/b>/);   // whole points
  const board = homeLeaders(list, data);
  assert.match(board.rows, /@bo<\/a><span class="chips"><span>Twin Prime Conjecture 9<\/span><span>MD5 Research Challenge 39<\/span><\/span><\/span><b>48<\/b>/);
  assert.equal(board.state, "Top 5 across 2 problems");
  // A project whose figures failed says so; it never shows a stale "Loading".
  assert.match(homeCards(list, { at: 0, by: {} }), /Live figures are unavailable right now\./);
});

test("each Open problems entry opens its project page; Propose a problem goes to Discord", () => {
  // Client, Oct 2026: clicking an entry scrolled down the page; it should go straight to the problem.
  const index = homeIndex(publicProjects(rows, []));
  assert.match(index, /<a href="\/projects\/twin-primes"><span class="n">001<\/span>/);
  assert.match(index, /<a href="\/projects\/md5"><span class="n">002<\/span>/);
  assert.doesNotMatch(index, /href="#/);
  assert.ok(index.includes(`<a href="${PROPOSE_URL}" rel="noopener"><span class="n">003</span>`));
});

test("the server's header is the one ui.js writes, and ui.js keeps it", async () => {
  // The front page carries the header in its first HTML so nothing moves when ui.js runs (CLS 0.07 at 1440 px before, Oct 2026).
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const src = readFileSync(new URL("../public/assets/ui.js", import.meta.url), "utf8");
  const run = (ssr) => {
    const header = { className: "", innerHTML: "", hasAttribute: (a) => ssr && a === "data-ssr" };
    const document = { body: { dataset: { page: "home" } }, querySelector: (q) => q === "[data-site-header]" ? header : null, querySelectorAll: () => [], getElementById: () => null };
    vm.runInNewContext(src, { document, window: {}, location: { hash: "" }, addEventListener() {}, requestAnimationFrame() {}, Intl, Date, Number, String, Math, JSON, console });
    return header;
  };
  const written = run(false), html = siteHeaderHtml("home");
  assert.equal(`<header data-site-header data-ssr class="${written.className}">${written.innerHTML}</header>`, html);
  assert.equal(run(true).innerHTML, "", "a server-rendered header is left alone");
});
