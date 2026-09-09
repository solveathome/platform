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
  const restore = (html: string) => html.replace(/(\d+)/g, (_, i) => { const v = spans[Number(i)] ?? ""; return v.startsWith('<span class="no-math">') ? v : v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); });
  return { text, restore };
}
