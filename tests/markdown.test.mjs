import { test } from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";
import { safeRenderer, headingSlug } from "../src/lib/markdown.ts";

test("headings carry GitHub-style ids so sections can be linked; duplicates are numbered", () => {
  assert.equal(headingSlug("Closed routes"), "closed-routes");
  assert.equal(headingSlug("Research outcomes — Closed routes"), "research-outcomes-closed-routes");
  assert.equal(headingSlug("§2. The `tile` T_x"), "2-the-tile-t_x");
  const html = marked.parse("## Closed routes\n\ntext\n\n## Closed routes\n\n### Zone (p, p′²)\n", { gfm: true, renderer: safeRenderer() });
  assert.match(html, /<h2 id="closed-routes">Closed routes<\/h2>/);
  assert.match(html, /<h2 id="closed-routes-1">Closed routes<\/h2>/);
  assert.match(html, /<h3 id="zone-p-p²">/);
  assert.match(marked.parse("# A [link](javascript:alert(1)) title\n"), /<h1 id="a-link-title">A link title<\/h1>/);
});
