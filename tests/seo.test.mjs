import { test } from "node:test";
import assert from "node:assert/strict";

// #sah-seo-optimize: what a search engine reads. A page rendered without a path used to get the home page as its canonical,
// which told search engines every such page was a copy of the home page.
process.env.BASE_URL = "https://example.org";
const { shareMeta } = await import("../src/lib/share.ts");
const { page } = await import("../src/lib/page.ts");
const { jsonLd, plainDescription, demoteHeadings, crumbsFromHtml, notFoundPage } = await import("../src/lib/seo.ts");

test("a page without a path gets no canonical and no og:url, never the home page's", () => {
  const html = shareMeta({ title: "Asks" });
  assert.ok(!html.includes('rel="canonical"'));
  assert.ok(!html.includes("og:url"));
  assert.match(shareMeta({ title: "x", path: "/projects/p/docs/a b.md" }), /<link rel="canonical" href="https:\/\/example\.org\/projects\/p\/docs\/a%20b\.md">/);
  assert.match(shareMeta({ title: "x", path: "/x", robots: "noindex, follow" }), /<meta name="robots" content="noindex, follow">/);
});

test("page(): one h1, a title that leads with the heading, robots and breadcrumbs", () => {
  const html = page({ title: "Return #7", heading: "Test the $G_2$ bound", path: "/projects/p/return/7", robots: "noindex", crumbs: `<a href="/projects/p">P</a><span>/ results /</span>#7`, body: "<h1>Report</h1><h2>Step</h2>" });
  assert.match(html, /<title>Test the G₂ bound · Return #7 · solveathome<\/title>/);
  assert.equal((html.match(/<h1/g) ?? []).length, 1, "the report's own # heading is demoted under the page heading");
  assert.match(html, /<meta name="robots" content="noindex">/);
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.deepEqual(ld["@graph"][0].itemListElement.map((i) => i.item), ["https://example.org/projects/p", "https://example.org/projects/p/return/7"]);
  assert.equal(page({ title: "Who holds what · P", heading: "Who holds what", crumbs: "", body: "" }).match(/<title>([^<]*)/)[1], "Who holds what · P · solveathome");
});

test("JSON-LD cannot close its script element", () => {
  const out = jsonLd({ name: "</script><script>alert(1)</script>" });
  assert.equal(out.match(/<\/script>/g).length, 1);
  assert.equal(JSON.parse(out.replace(/^<script[^>]*>|<\/script>$/g, "")).name, "</script><script>alert(1)</script>");
});

test("descriptions read as text: TeX becomes symbols, Markdown goes, long text is cut at a word", () => {
  assert.equal(plainDescription("Let $A \\subset \\mathbb{Z}_P$ with $x \\le \\sqrt{n}$, *twin candidates*."), "Let A ⊂ Z_P with x ≤ √n, twin candidates.");
  assert.equal(plainDescription("# Title\n\nSee [the note](/x)."), "Title See the note.");
  const long = plainDescription("word ".repeat(200), 50);
  assert.ok(long.length <= 50 && long.endsWith("…"));
});

test("headings demote one level, closing tags included; crumbs read back from HTML skip fragments", () => {
  assert.equal(demoteHeadings('<h1 id="a">A</h1><h2>B</h2><h6>C</h6>'), '<h2 id="a">A</h2><h3>B</h3><h6>C</h6>');
  const t = crumbsFromHtml(`<a href="/projects/p">P &amp; Q</a> / <a href="/projects/p#papers">Papers</a>`, { name: "Doc", path: "/projects/p/docs/d.md" });
  assert.deepEqual(t.itemListElement.map((i) => i.name), ["P & Q", "Doc"]);
  assert.match(notFoundPage("<x>"), /noindex[\s\S]*&lt;x&gt;/);
});
