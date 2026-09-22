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

test("plain-text math renders as sub- and superscripts, never in code, file names or snake_case", async () => {
  const { plainNotation, documentRenderer, escapeSource } = await import("../src/lib/markdown.ts");
  assert.equal(plainNotation("pₙ^{β₂+ε}"), "pₙ<sup>β₂+ε</sup>");
  assert.equal(plainNotation("(log y)^{1/(2κ+2)}"), "(log y)<sup>1/(2κ+2)</sup>");
  assert.equal(plainNotation("Σ_{m|P(z),m&lt;y} 4^{ν(m)}|r_A(m)|"), "Σ<sub>m|P(z),m&lt;y</sub> 4<sup>ν(m)</sup>|r<sub>A</sub>(m)|");
  assert.equal(plainNotation("(log w/log w₁)^κ(1+A) ≪_ε x"), "(log w/log w₁)<sup>κ</sup>(1+A) ≪<sub>ε</sub> x");
  assert.equal(plainNotation("z^{k^{2}}"), "z<sup>k<sup>2</sup></sup>");
  for (const s of ["snake_case", "run_2.log", "a_b-c", "__init__", "x ^ y", "a_ b", "x^{unclosed", "x^{}"]) assert.equal(plainNotation(s), s);
  const { protectMath } = await import("../src/lib/math.ts");
  const m = protectMath("Define\n\n  G₂(n) = the largest gap\n          (cyclically).\n\n`a_{b}` and [f_x](https://e.org/a_b) and $x^{2}$\n\n## The tile T_x\n");
  const html = m.restore(marked.parse(escapeSource(m.text), { gfm: true, renderer: documentRenderer() }));
  assert.match(html, /<p class="display">G₂\(n\) = the largest gap\n        \(cyclically\)\.<\/p>/);
  assert.match(html, /<code>a_\{b\}<\/code>/);
  assert.match(html, /href="https:\/\/e\.org\/a_b">f<sub>x<\/sub><\/a>/);
  assert.match(html, /\$x\^\{2\}\$/);
  assert.match(html, /<h2 id="the-tile-t_x">The tile T_x<\/h2>/);
});

test("document sources keep blockquotes and still never pass raw HTML", async () => {
  const { escapeSource, documentRenderer } = await import("../src/lib/markdown.ts");
  const html = marked.parse(escapeSource("> **Theorem.** x > 1 and <script>alert(1)</script>\n>\n>   **G₂(n) ≤ C · pₙ^{β₂+ε}**\n\na -> b\n"), { gfm: true, renderer: documentRenderer() });
  assert.match(html, /<blockquote>/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /x &gt; 1/);
  assert.match(html, /<p class="display"><strong>G₂\(n\) ≤ C · pₙ<sup>β₂\+ε<\/sup><\/strong><\/p>/);
  assert.match(html, /a -&gt; b/);
});

test("plainMathLines names the lines whose math is outside TeX, and typesetBrief tells the agent to change notation only", async () => {
  const { plainMathLines } = await import("../src/lib/math.ts");
  const { typesetBrief } = await import("../src/lib/typeset.ts");
  const src = "# T\n\nG₂(n) ≤ C · pₙ^{β₂+ε}\n\n$p_n^{\\beta_2}$ and $$\\sum_{m}$$ and \\(x_{1}\\)\n\n`a_{b}` code\n\n```\nx^{2}\n```\n\n  Σ_{m|P(z)} 4^{ν(m)}\nsnake_case and a price of \\$5 and x^2\n";
  assert.deepEqual(plainMathLines(src), [3, 13]);
  assert.deepEqual(plainMathLines("All in $x^{2}$ and\n$$\ny_{1}\n$$\n"), []);
  const brief = typesetBrief("twin-primes", "beta2-note", "An upper bound", [3, 13]);
  assert.match(brief, /^paper\.slug: beta2-note\n/);
  assert.match(brief, /on lines 3, 13\./);
  assert.match(brief, /Change the notation and nothing else/);
  assert.match(brief, /GET \/projects\/twin-primes\/papers\/beta2-note/);
  assert.match(brief, /\\\(…\\\) and \\\[…\\\]/);
  assert.doesNotMatch(brief, /hour|deadline|minute/i, "no brief states a time allowance");
});
