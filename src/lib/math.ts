/** Keep LaTeX math out of the Markdown parser (underscores and asterisks inside formulas are not emphasis), then put it back for KaTeX on the client. */
const PH = (i: number) => `${i}`;   // private-use characters: never collide with prose like "M2"
export function protectMath(src: string): { text: string; restore: (html: string) => string } {
  const spans: string[] = [];
  const keep = (m: string) => { spans.push(m); return PH(spans.length - 1); };
  // A literal dollar (written \$ in the source) must never pair with a real delimiter on the client: it comes back inside a span KaTeX ignores.
  const text = src
    .replace(/\\\$/g, () => { spans.push('<span class="no-math">$</span>'); return PH(spans.length - 1); })
    .replace(/\$\$[\s\S]+?\$\$/g, keep)
    .replace(/\\\[[\s\S]+?\\\]/g, keep)
    .replace(/\\\([\s\S]+?\\\)/g, keep)
    .replace(/(?<![\\$\w])\$(?![\s$])((?:\\.|[^$\\])+?)(?<!\s)\$(?![\w$])/g, (m) => /\n\s*\n/.test(m) ? m : keep(m));
  const restore = (html: string) => html.replace(/(\d+)/g, (_, i) => { const v = spans[Number(i)] ?? ""; return v.startsWith('<span class="no-math">') ? v : v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); });   // a formula can land inside an attribute markdown made (alt, title): quotes too
  return { text, restore };
}

/**
 * Lines (1-based) that write math as bare `^{…}` or `_{…}` outside code and TeX delimiters. Only `$…$`, `$$…$$`, `\(…\)` and `\[…\]` are
 * typeset; the rest is shown as text (beta2-note, Sep 22). Paper intake warns on these lines and import-papers queues a typesetting job
 * for a manuscript that has them (Chris, Sep 22: "if this is an issue of writing, let's make it an agent job to clean those up").
 */
export function plainMathLines(src: string): number[] {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");   // keep the line count
  const text = String(src ?? "")
    .replace(/^(```|~~~)[\s\S]*?^\1/gm, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/\\\$/g, "  ")
    .replace(/\$\$[\s\S]+?\$\$/g, blank)
    .replace(/\\\[[\s\S]+?\\\]/g, blank)
    .replace(/\\\([\s\S]+?\\\)/g, blank)
    .replace(/\$[^$\n]+\$/g, blank);
  const out: number[] = [];
  text.split("\n").forEach((line, i) => { if (/\S[\^_]\{[^}\n]+\}/.test(line)) out.push(i + 1); });
  return out;
}
