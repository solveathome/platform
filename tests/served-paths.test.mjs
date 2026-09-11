import { test } from "node:test";
import assert from "node:assert/strict";
import { namedPaths, classify } from "../src/lib/served-paths.ts";

test("issue #27: paths named in a brief are checked against the snapshot", () => {
  assert.deepEqual(namedPaths("Read `research/OUTCOMES.md` and `attestation/book-ch5-6/`; see `paper/beta2-note.md`. Not `x` or `foo.md` or `/abs/path`."),
    ["research/OUTCOMES.md", "attestation/book-ch5-6/", "paper/beta2-note.md"]);
  const publication = { version: 1, generated_at: "", files: { "research/OUTCOMES.md": { sha256: "a", mode: "project" }, "attestation/EXTERNAL-SOURCES.md": { sha256: "b", mode: "project" } } };
  assert.equal(classify("research/OUTCOMES.md", "/nowhere", publication, "twin-primes").status, "served");
  assert.equal(classify("attestation/", "/nowhere", publication, "twin-primes").status, "served", "a directory with a served file");
  assert.equal(classify("paper/beta2-note.md", "/nowhere", publication, "twin-primes").status, "missing");
  const r = classify("attestation/book-ch5-6/", "/nowhere", publication, "twin-primes");
  assert.equal(r.status, "redirected"); assert.match(r.to, /doi\.org/);
});
