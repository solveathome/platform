/**
 * What a search engine reads (Sep 25 2026, #sah-seo-optimize): structured data, the not-found page, plain-text descriptions.
 * robots.txt and sitemap.xml are in src/routes/seo.ts. The site stays the record: nothing here changes what a page says,
 * only how a crawler finds it and what it may index.
 */
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
export const BASE = () => (process.env.BASE_URL ?? "http://localhost:8600").replace(/\/+$/, "");
export const abs = (path: string) => /^https?:/.test(path) ? path : `${BASE()}${path.startsWith("/") ? path : "/" + path}`;

/** One JSON-LD block. `<` is escaped so no string in the data can close the script element. */
export function jsonLd(data: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

export const ORGANIZATION = () => ({ "@type": "Organization", "@id": `${BASE()}/#organization`, name: "solveathome", url: `${BASE()}/`, logo: `${BASE()}/apple-touch-icon.png`, sameAs: ["https://github.com/solveathome"] });
export const WEBSITE = () => ({ "@type": "WebSite", "@id": `${BASE()}/#website`, name: "solveathome", url: `${BASE()}/`, inLanguage: "en", publisher: { "@id": `${BASE()}/#organization` } });

/** BreadcrumbList from name/path pairs; the last item is the page itself. */
export function breadcrumbs(items: { name: string; path: string }[]): object {
  return { "@type": "BreadcrumbList", itemListElement: items.filter((i) => i.name).map((i, n) => ({ "@type": "ListItem", position: n + 1, name: i.name, item: abs(i.path) })) };
}

/** The crumbs of a server-rendered page, read back from its breadcrumb HTML: every link, then the page. */
export function crumbsFromHtml(html: string, page: { name: string; path?: string }): object | null {
  const items = [...String(html ?? "").matchAll(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ path: m[1].replace(/&amp;/g, "&"), name: textOf(m[2]) }))
    .filter((i) => i.path.startsWith("/") && !i.path.includes("#"));
  if (!page.path || !items.length) return null;
  return breadcrumbs([...items, { name: page.name, path: page.path }]);
}

/** Visible text of an HTML fragment. */
export function textOf(html: string): string {
  return String(html ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

const TEX: Record<string, string> = { le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩", times: "×", cdot: "·", infty: "∞", to: "→", approx: "≈", sim: "~", pm: "±", sum: "∑", prod: "∏", mid: "|",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", theta: "θ", lambda: "λ", mu: "μ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", varphi: "φ", chi: "χ", omega: "ω", Gamma: "Γ", Delta: "Δ", Lambda: "Λ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Omega: "Ω", sqrt: "√", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", ll: "≪", gg: "≫", "#": "#", ",": " ", ";": " ", "!": "", quad: " ", qquad: " " };
/** A meta description from Markdown with math: the text a search result can show, TeX turned into its symbols where it has one. */
export function plainDescription(md: string, max = 300): string {
  let t = String(md ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/\$\$?([^$]*)\$\$?/g, (_m, tex: string) => tex
    .replace(/\\(?:mathbb|mathrm|mathcal|mathbf|operatorname|text|textbf|textit|mathit)\s*\{([^}]*)\}/g, "$1")
    .replace(/\\([A-Za-z]+|[#,;!])/g, (m: string, name: string) => TEX[name] ?? name)
    .replace(/[{}]/g, "").replace(/\s*_\s*(\d+)/g, (_m, d: string) => [...d].map((c) => "₀₁₂₃₄₅₆₇₈₉"[Number(c)]).join("")).replace(/\s*\^\s*(\d+)/g, (_m, d: string) => [...d].map((c) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(c)]).join(""))
    .replace(/\s*_\s*/g, "\u0001").replace(/\s*\^\s*/g, "^"));   // a subscript survives the Markdown strip below
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^#+\s*/gm, "").replace(/[*_`>]+/g, "").replace(/\u0001/g, "_").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1); return cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 40)).replace(/[\s,;:.]+$/, "") + "…";
}

/** Headings of an embedded document one level down, so the page's own title is its only h1 (a manuscript opens with its title as `#`). */
export function demoteHeadings(html: string, by = 1): string {
  return String(html ?? "").replace(/<(\/?)h([1-6])(?=[\s>])/g, (_m, close: string, n: string) => `<${close}h${Math.min(6, Number(n) + by)}`);
}

/** The not-found page for a browser or crawler: a real 404 status, the site chrome, and never indexed. */
export function notFoundPage(what = "This page does not exist."): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found · solveathome</title><meta name="robots" content="noindex"><link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/assets/app.css?v=27"></head><body data-page="not-found"><header data-site-header></header><main class="shell" id="main"><section class="empty-state"><h1>Not found.</h1><p>${esc(what)}</p><p><a href="/">Back to overview →</a></p></section></main><footer data-site-footer></footer><script src="/assets/ui.js?v=18"></script></body></html>`;
}
