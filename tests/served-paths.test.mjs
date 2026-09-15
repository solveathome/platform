import { test } from "node:test";
import assert from "node:assert/strict";
import { namedPaths, classify } from "../src/lib/served-paths.ts";

// The fixture snapshot: three top-level directories, so `paper/` is a place the snapshot can speak about and `src/` is not.
const publication = { version: 1, generated_at: "", files: {
  "research/OUTCOMES.md": { sha256: "a", mode: "project" },
  "research/history/staging/redteam-0830-doubling.md": { sha256: "b", mode: "project" },
  "attestation/EXTERNAL-SOURCES.md": { sha256: "c", mode: "project" },
  "paper/proposals/prop-suen-import.md": { sha256: "d", mode: "project" },
} };
const status = (p) => classify(p, "/nowhere", publication, "twin-primes").status;

test("issue #27: paths named in a brief are checked against the snapshot", () => {
  assert.deepEqual(namedPaths("Read `research/OUTCOMES.md` and `attestation/book-ch5-6/`; see `paper/beta2-note.md`. Not `x` or `foo.md` or `/abs/path`."),
    ["research/OUTCOMES.md", "attestation/book-ch5-6/", "paper/beta2-note.md"]);
  assert.equal(status("research/OUTCOMES.md"), "served");
  assert.equal(status("attestation/"), "served", "a directory with a served file");
  assert.equal(status("paper/beta2-note.md"), "missing", "the snapshot has a paper/ directory and this is not in it");
  const r = classify("attestation/book-ch5-6/", "/nowhere", publication, "twin-primes");
  assert.equal(r.status, "redirected"); assert.match(r.to, /doi\.org/);
});

// Issue #86: the line is an instruction and agents obey it, so a false positive costs more than a false negative. These are
// the five paths the check reported across every brief and research route on 2026-09-15, and all five were wrong.
test("issue #86: a path quoted relative to the directory of the document that cites it is served, not missing", () => {
  assert.equal(status("history/staging/redteam-0830-doubling.md"), "served", "prose inside research/ names its neighbours relative to research/");
  assert.equal(status("research/history/staging/redteam-0830-doubling.md"), "served");
  assert.equal(status("staging/"), "served", "a directory named the way a document names it");
  assert.equal(status("history/staging/redteam-0829-theorem1.md"), "outside", "a relative quote that resolves nowhere: `history` is no directory of this snapshot, so the brief stays quiet");
  assert.equal(status("research/qc/checks.js"), "missing", "under a directory the snapshot does serve, a genuine absence is still reported");
});

test("issue #86: a code span that is not a document path is never reported", () => {
  assert.equal(status("msc/C2"), "outside", "a certificate ratio in an inline code span, no extension");
  assert.equal(status("src/lib/files.ts"), "outside", "a file in this repository, not in the corpus snapshot");
  assert.equal(status("alt22/"), "outside", "a label with a trailing slash under no snapshot directory");
});

test("issue #86: only served-snapshot answers reach the brief; a redirect still speaks", () => {
  const { unservedPaths } = { unservedPaths: (text) => namedPaths(text).map((p) => classify(p, "/nowhere", publication, "twin-primes")).filter((s) => s.status === "missing" || s.status === "redirected") };
  const reported = unservedPaths("See `msc/C2`, `src/lib/files.ts`, `history/staging/redteam-0830-doubling.md`, `attestation/book-ch5-6/` and `paper/beta2-note.md`.");
  assert.deepEqual(reported.map((r) => `${r.path}:${r.status}`), ["attestation/book-ch5-6/:redirected", "paper/beta2-note.md:missing"]);
});
