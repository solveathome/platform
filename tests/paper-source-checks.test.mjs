// Claim-to-source map and reference lookup (Oct 16 2026, Sakana lessons #3 and #4): which claims a manuscript makes, which of them
// name a source that exists, and what Crossref and arXiv say about each reference. No database and no network: a fixture context
// stands in for the project's record and a fake fetcher for the indexes.
import test from "node:test";
import assert from "node:assert/strict";
process.env.NODE_ENV = "test";
const { checkClaimSources, parseSources, sameNumber } = await import("../src/lib/claim-sources.ts");
const { parseReferences, lookupReference } = await import("../src/lib/citations.ts");

const ctx = {
  returnStatus: async (id) => ({ 10: "accepted", 11: "rejected", 12: "pending" })[id] ?? null,
  receiptExists: async (id) => id === 5,
  jobExists: async () => true,
  fileExists: async (p) => p.endsWith("check.py"),
};

const paper = `# A note

**Theorem 1 (main).** Every gap exceeds 0.4162145 times the mean.

**Lemma 2.** The constant is 0.6601618.

**Proposition 3 (proven; return #10).** A fact named in its own heading.

**Corollary 4.** A corollary nobody mapped, with 1.2345678.

The value 4.26645 appears in prose, and 1,117,909 primes are sieved, in 2023 (a year, not a claim), section 5.2.

| level | count |
|---|---|
| 7 | 143 |
| 11 | 2310 |

| step | rung |
|---|---|
| Lemma 2 | proven |

## Claim sources

| Claim | Source |
|---|---|
| Theorem 1 | return #10 |
| Lemma 2 | receipt #6 |
| 4.26645 | [KK] Lemma 1 |
| Table 1 | \`check.py\` |
| 1,117,909 | hand count |

## References

- [KK] A. Kalmynin and S. Konyagin, *A polynomial analogue of Jacobsthal function*, Izv. Math. **88** (2024), DOI 10.4213/im9467e, arXiv:2302.00459v2.
- [HR] H. Halberstam and H.-E. Richert, *Sieve Methods*, Academic Press, 1974.
`;

test("each theorem, numeric table and result number is a claim; the map, a heading source and a table's numbers map them", async () => {
  const c = await checkClaimSources(paper, ctx);
  const by = Object.fromEntries(c.claims.map((x) => [x.label, x]));
  assert.equal(c.has_map, true);
  assert.equal(by["Theorem 1"].mapped, true, "a map row naming an accepted return maps the theorem");
  assert.equal(by["Lemma 2"].mapped, false, "receipt #6 does not exist");
  assert.match(by["Lemma 2"].flag, /receipt #6 does not exist/);
  assert.equal(by["Proposition 3"].mapped, true, "a source in the result's own heading counts");
  assert.match(by["Corollary 4"].flag, /Corollary 4 \(line \d+\) has no row/);
  assert.equal(by["4.26645"].mapped, true, "a reference key in the list is a source");
  assert.equal(by["1,117,909"].mapped, false, "a row that names no source fails");
  assert.match(by["1,117,909"].flag, /names no return, receipt, Lean package, file or reference/);
  assert.equal(by["1.2345678"].mapped, false);
  assert.ok(!c.claims.some((x) => x.label === "2023" || x.label === "5.2"), "years and section numbers are not claims");
  assert.ok(c.claims.some((x) => x.kind === "table" && x.mapped), "the numeric table is mapped by its Table 1 row");
  assert.equal(c.claims.filter((x) => x.kind === "table").length, 1, "a table with no numbers in it (labels only) is not a claim");
  assert.ok(!c.claims.some((x) => x.label === "0.4162145"), "a number inside a mapped theorem's block belongs to that theorem");
  assert.ok(c.claims.some((x) => x.label === "0.6601618" && !x.mapped), "a number inside an unmapped lemma is still listed");
});

test("a manuscript without a map says so first, and lists every claim", async () => {
  const c = await checkClaimSources("**Theorem 1.** A result.\n\nThe ratio is 2.0123.\n", ctx);
  assert.equal(c.has_map, false);
  assert.equal(c.counts.claims, 2);
  assert.equal(c.counts.unmapped, 2);
  assert.match(c.flags[0], /no Claim sources table, so none of its 2 claims/);
  const one = await checkClaimSources("**Theorem 1 (proven; return #10).** A result.\n\n## Data\n\nThe ratio is 2.0123.\n", ctx);
  assert.match(one.flags[0], /no Claim sources table; 1 of its 2 claims name no source/, "a heading source is counted in the summary line");
});

test("a map row's sources: returns, receipts, Lean, files, reference keys, and pointers inside the paper", () => {
  const kinds = (s) => parseSources(s).map((r) => `${r.kind}:${r.id}`);
  assert.deepEqual(kinds("`mertens-check-out.txt` (return #32)"), ["return:32", "file:mertens-check-out.txt"]);
  assert.deepEqual(kinds("returns #3 and #4; receipt 7"), ["return:3", "return:4", "receipt:7"]);
  assert.deepEqual(kinds("Lean package `KKLowerBound`, `SelbergFinite.lean`"), ["lean:SelbergFinite.lean", "lean:KKLowerBound"]);
  assert.deepEqual(kinds("[KK, Lemma 1]; [RECORD]"), ["reference:KK"]);
  assert.deepEqual(kinds("proved in §4"), ["internal:this paper"]);
  assert.deepEqual(kinds("hand and sieve, referee pass"), []);
});

test("a number written to fewer decimals is the same value", () => {
  assert.ok(sameNumber("1.98156", "1.9816"));
  assert.ok(!sameNumber("1.98156", "1.9817"));
  assert.ok(!sameNumber("2.1", "2.13"), "one decimal is too coarse to match");
});

test("references: list entries with their key, title and identifiers, and identifiers cited in running text", () => {
  const refs = parseReferences(paper.replace("## Claim sources", "As shown in arXiv:1908.08613, the gaps are large.\n\n## Claim sources"));
  assert.equal(refs.length, 3);
  const listed = refs.filter((r) => !r.inline);
  assert.deepEqual([listed[0].key, listed[0].title, listed[0].dois, listed[0].arxiv], ["KK", "A polynomial analogue of Jacobsthal function", ["10.4213/im9467e"], ["2302.00459"]]);
  assert.deepEqual([listed[1].key, listed[1].title, listed[1].years], ["HR", "Sieve Methods", [1974]]);
  assert.equal(refs.filter((r) => r.inline).length, 1);
});

// A fake index: Crossref knows one DOI and one bibliographic match, doi.org one DataCite DOI, arXiv one id.
const fake = async (url) => {
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (url.includes("api.crossref.org/works/10.4213%2Fim9467e")) return json({ message: { DOI: "10.4213/im9467e", title: ["A polynomial analogue of Jacobsthal function"], issued: { "date-parts": [[2024]] } } });
  if (url.includes("api.crossref.org/works/10.9999")) return json({ message: { DOI: "10.9999/x", title: ["Unrelated thermodynamics of soap films"] } });
  if (url.includes("api.crossref.org/works/")) return json({}, 404);
  if (url.includes("api.crossref.org/works?")) return json({ message: { items: decodeURIComponent(url).includes("Jacobsthal") ? [{ DOI: "10.4213/im9467e", title: ["A polynomial analogue of Jacobsthal function"], issued: { "date-parts": [[2024]] }, author: [{ family: "Kalmynin" }] }] : [] } });
  if (url.includes("doi.org/api/handles/10.5281")) return json({ responseCode: 1 });
  if (url.includes("doi.org/api/handles/")) return json({ responseCode: 100 }, 404);
  if (url.includes("export.arxiv.org")) return new Response(url.includes("2302.00459") ? `<feed><entry><id>http://arxiv.org/abs/2302.00459v2</id><title>A polynomial analogue of
  Jacobsthal function</title></entry></feed>` : "<feed></feed>", { status: 200 });
  return json({}, 404);
};
const ref = (line) => parseReferences(`## References\n\n${line}\n`)[0];

test("lookups: resolved, wrong identifier, typo with a suggestion, registered outside Crossref, and not found", async () => {
  assert.equal((await lookupReference(ref("- A. Kalmynin, *A polynomial analogue of Jacobsthal function*, 2024, DOI 10.4213/im9467e."), fake)).status, "resolved");
  const wrong = await lookupReference(ref("- A. Kalmynin, *A polynomial analogue of Jacobsthal function*, 2024, DOI 10.9999/x."), fake);
  assert.equal(wrong.status, "mismatch");
  assert.match(wrong.note, /belongs to a different work, "Unrelated thermodynamics of soap films".*Crossref has this reference as DOI 10\.4213\/im9467e/);
  const typo = await lookupReference(ref("- A. Kalmynin, *A polynomial analogue of Jacobsthal function*, 2024, DOI 10.4213/im9476e."), fake);
  assert.equal(typo.status, "unresolved");
  assert.match(typo.note, /not registered.*Crossref has this reference as DOI 10\.4213\/im9467e: probably a typo/);
  assert.equal((await lookupReference(ref("- B. Data, *A dataset of gaps*, 2025, DOI 10.5281/zenodo.123."), fake)).source, "doi.org");
  assert.equal((await lookupReference(ref("- A. Kalmynin, *A polynomial analogue of Jacobsthal function*, 2023, arXiv:2302.00459."), fake)).status, "resolved");
  assert.match((await lookupReference(ref("- X. Nobody, *An invented theorem on primes*, 2021, arXiv:2101.99999."), fake)).note, /arXiv id 2101\.99999 does not exist/);
  const found = await lookupReference(ref("- A. Kalmynin and S. Konyagin, *A polynomial analogue of Jacobsthal function*, Izv. Math. 2024."), fake);
  assert.deepEqual([found.status, found.found_doi], ["found", "10.4213/im9467e"]);
  const book = await lookupReference(ref("- H. Halberstam and H.-E. Richert, *Sieve Methods*, Academic Press, 1974."), fake);
  assert.equal(book.status, "unresolved");
  assert.match(book.note, /check it by hand at the page/);
  const inline = parseReferences("The nearest hits do not match the *survivor progressions* of arXiv:2302.00459 at all.\n")[0];
  assert.equal((await lookupReference(inline, fake)).status, "resolved", "a word in italics in running text is not a title to compare (first run, Oct 16: three false mismatches)");
  assert.equal((await lookupReference(ref("- OEIS A144311, the maximal gap between twin-admissible residues, 2008."), fake)).status, "skipped");
  assert.match((await lookupReference(ref("- L. Lu and L. A. Székely, Electron. J. Combin. 14 (2007) #R63."), fake)).note, /gives no title/);
  const down = await lookupReference(ref("- A. Kalmynin, *A polynomial analogue of Jacobsthal function*, 2024, DOI 10.4213/im9467e."), async () => new Response("", { status: 503 }));
  assert.equal(down.status, "error", "an index that does not answer leaves the reference pending, never flagged");
});
