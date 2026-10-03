/**
 * The look of solveathome's emails (#sah-progress-emails; Chris, 3 Oct 2026: "Content looks great, but we need an awesome design").
 * The site's identity in mail: charcoal and paper, fine rules, generous space, the system font. Built for mail clients, not browsers:
 * tables for layout, every style inline (a client that strips <style> still gets the design), buttons as padded table cells so Outlook
 * draws them, 600 px wide and fluid below it, and a <style> block only for what inline styles cannot do (mobile stacking, dark mode).
 */
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const BASE = () => (process.env.BASE_URL ?? "http://localhost:8600").replace(/\/+$/, "");

/** The site's palette (public/assets/app.css), light first: most mail clients render light. */
export const C = { ink: "#171817", paper: "#fbfaf7", page: "#efeee8", soft: "#f5f4ef", line: "#d9d8d1", mut: "#6a6963", paperMut: "#aaa9a3", charLine: "#393a37" };
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;

/** A button that survives Outlook: the colour is on the table cell, the link fills it. */
export function button(href: string, label: string, kind: "paper" | "ink" | "outline" = "ink"): string {
  const bg = kind === "paper" ? C.paper : kind === "ink" ? C.ink : "transparent";
  const fg = kind === "paper" ? C.ink : kind === "ink" ? C.paper : C.ink;
  const border = kind === "outline" ? `1px solid ${C.ink}` : `1px solid ${bg}`;
  const cls = kind === "paper" ? "btn-paper" : kind === "ink" ? "btn-ink" : "btn-outline";
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate"><tr><td class="${cls}" bgcolor="${bg === "transparent" ? "" : bg}" style="background:${bg};border:${border};border-radius:2px">`
    + `<a class="${cls}" href="${esc(href)}" style="display:inline-block;padding:12px 22px;font:600 15px/1.2 ${FONT};color:${fg};text-decoration:none;letter-spacing:-.01em">${esc(label)}</a></td></tr></table>`;
}

const eyebrowStyle = (color: string) => `font:600 11px/1.4 ${FONT};letter-spacing:.12em;text-transform:uppercase;color:${color};margin:0 0 10px`;

/** The lead item: an inverted charcoal block, the one thing that matters most today. */
export function hero(o: { eyebrow: string; head: string; why: string; href: string; cta: string; note?: string }): string {
  return `<tr><td class="hero" bgcolor="${C.ink}" style="background:${C.ink};padding:36px 36px 34px;border-radius:2px">
    ${o.note ? `<p class="hero-note" style="font:italic 14px/1.5 ${FONT};color:${C.paperMut};margin:0 0 16px">${esc(o.note)}</p>` : ""}
    <p style="${eyebrowStyle(C.paperMut)}">${esc(o.eyebrow)}</p>
    <h1 class="hero-head" style="font:600 27px/1.22 ${FONT};letter-spacing:-.03em;color:${C.paper};margin:0 0 14px">${esc(o.head)}</h1>
    <p style="font:16px/1.6 ${FONT};color:#d6d5ce;margin:0 0 26px">${esc(o.why)}</p>
    ${button(o.href, o.cta, "paper")}
  </td></tr>`;
}

/** A question for the person: a ruled block with its own button, never lost in the list. */
export function askBlock(items: Array<{ head: string; why: string; href: string }>): string {
  if (!items.length) return "";
  return spacer(28) + `<tr><td style="border:1px solid ${C.ink};border-left:5px solid ${C.ink};padding:22px 24px 24px;background:${C.paper}" class="card ask">
    <p class="txt" style="${eyebrowStyle(C.ink)}">Needs your answer</p>
    ${items.map((it, i) => `<p class="txt" style="font:16px/1.55 ${FONT};color:${C.ink};margin:${i ? "18px" : "0"} 0 6px">${esc(it.head)}</p>
      <p class="mut" style="font:13px/1.5 ${FONT};color:${C.mut};margin:0 0 14px">${esc(it.why)}</p>${button(it.href, "Answer", "ink")}`).join("")}
  </td></tr>`;
}

/** Everything else that happened, one ruled row each, a small label on the left. */
export function rows(title: string, items: Array<{ label: string; head: string; href: string }>, more?: { label: string; href: string }): string {
  if (!items.length) return "";
  const row = (label: string, head: string, href: string) => `<tr>
      <td class="row-label" valign="top" width="112" style="width:112px;padding:14px 12px 14px 0;border-top:1px solid ${C.line};font:600 10px/1.9 ${MONO};letter-spacing:.08em;text-transform:uppercase;color:${C.mut}">${esc(label)}</td>
      <td valign="top" style="padding:13px 0;border-top:1px solid ${C.line}"><a class="txt" href="${esc(href)}" style="font:15px/1.5 ${FONT};color:${C.ink};text-decoration:none">${esc(head)}&nbsp;<span style="color:${C.mut}">&rarr;</span></a></td>
    </tr>`;
  return spacer(36) + `<tr><td><p style="${eyebrowStyle(C.mut)}">${esc(title)}</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${items.map((i) => row(i.label, i.head, i.href)).join("")}
    ${more ? `<tr><td colspan="2" style="padding:13px 0;border-top:1px solid ${C.line}"><a href="${esc(more.href)}" style="font:14px/1.5 ${FONT};color:${C.mut};text-decoration:underline">${esc(more.label)}</a></td></tr>` : ""}
    <tr><td colspan="2" style="border-top:1px solid ${C.line};font-size:0;line-height:0">&nbsp;</td></tr></table></td></tr>`;
}

/** Big numbers, small labels: two by two, so it reads the same on a phone and in Outlook. */
export function statCards(title: string, cards: Array<{ value: string; label: string; sub?: string }>, details: string[], link?: { href: string; label: string }): string {
  if (!cards.length) return "";
  const cell = (c: { value: string; label: string; sub?: string } | undefined, side: "l" | "r") => c ? `<td class="stat" width="50%" valign="top" style="width:50%;padding:${side === "l" ? "0 6px 12px 0" : "0 0 12px 6px"}">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td class="card" style="background:${C.soft};border:1px solid ${C.line};padding:18px 18px 16px;border-radius:2px">
        <p class="mut" style="font:600 10px/1.4 ${MONO};letter-spacing:.1em;text-transform:uppercase;color:${C.mut};margin:0 0 8px">${esc(c.label)}</p>
        <p class="txt stat-num" style="font:600 32px/1.05 ${FONT};letter-spacing:-.04em;color:${C.ink};margin:0">${esc(c.value)}</p>
        ${c.sub ? `<p class="mut" style="font:13px/1.45 ${FONT};color:${C.mut};margin:8px 0 0">${esc(c.sub)}</p>` : ""}
      </td></tr></table></td>` : `<td class="stat" width="50%" style="width:50%"></td>`;
  const pairs: string[] = [];
  for (let i = 0; i < cards.length; i += 2) pairs.push(`<tr>${cell(cards[i], "l")}${cell(cards[i + 1], "r")}</tr>`);
  return spacer(36) + `<tr><td><p style="${eyebrowStyle(C.mut)}">${esc(title)}</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${pairs.join("")}</table>
    ${details.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${details.map((d) => `<tr><td class="mut" style="padding:9px 0;border-top:1px solid ${C.line};font:13px/1.5 ${FONT};color:${C.mut}">${d}</td></tr>`).join("")}</table>` : ""}
    ${link ? `<p style="margin:18px 0 0"><a class="txt" href="${esc(link.href)}" style="font:600 14px/1.5 ${FONT};color:${C.ink};text-decoration:underline">${esc(link.label)}</a></p>` : ""}
  </td></tr>`;
}

/** The monthly letter or project news inside an email: a quieter, ruled section. */
export function letterBlock(title: string | null, subject: string, bodyHtml: string): string {
  return spacer(36) + `<tr><td style="border-top:2px solid ${C.ink};padding-top:22px">
    ${title ? `<p style="${eyebrowStyle(C.mut)}">${esc(title)}</p>` : ""}
    <h2 class="txt" style="font:600 21px/1.3 ${FONT};letter-spacing:-.02em;color:${C.ink};margin:0 0 12px">${esc(subject)}</h2>
    <div class="txt" style="font:16px/1.65 ${FONT};color:${C.ink}">${bodyHtml.replace(/<p>/g, `<p style="margin:0 0 14px">`)}</div>
  </td></tr>`;
}

export const paragraph = (html: string) => `<tr><td class="txt" style="font:16px/1.6 ${FONT};color:${C.ink};padding:0 0 16px">${html}</td></tr>`;
export const spacer = (h: number) => `<tr><td style="height:${h}px;font-size:0;line-height:0">&nbsp;</td></tr>`;

/** The whole email: a preheader, the branded header, the content rows, a quiet footer that keeps the unsubscribe links. */
export function shell(o: { title: string; preheader: string; eyebrow: string; body: string; footerWhy: string; footerLinks: Array<[string, string]> }): string {
  const base = BASE();
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(o.title)}</title>
<!--[if mso]><style>table,td,p,a,h1,h2{font-family:Arial,sans-serif!important}</style><![endif]-->
<style>
  body{margin:0!important;padding:0!important;width:100%!important}
  a{text-decoration:none}
  .logo-paper{display:none!important;max-height:0;overflow:hidden;mso-hide:all}
  @media (max-width:620px){
    .wrap{padding:16px 10px!important}
    .inner{padding:26px 20px 30px!important}
    .hero{padding:28px 22px 26px!important}
    .hero-head{font-size:23px!important}
    .stat-num{font-size:27px!important}
    .row-label{width:84px!important}
  }
  @media (prefers-color-scheme:dark){
    .page,.wrap{background:#0f100f!important}
    .inner{background:${C.ink}!important;border-color:${C.charLine}!important}
    .txt,.txt a,a.txt{color:#efeee8!important}
    .mut,.row-label{color:${C.paperMut}!important}
    .card{background:#222321!important;border-color:${C.charLine}!important}
    .hero{background:#000000!important;border:1px solid ${C.charLine}!important}
    td.btn-ink{background:#efeee8!important;border-color:#efeee8!important} a.btn-ink{color:${C.ink}!important}
    .logo-ink{display:none!important} .logo-paper{display:block!important;max-height:none!important}
    td,p{border-color:${C.charLine}!important}
    td.ask{border-color:#efeee8!important}
  }
  [data-ogsc] .logo-ink{display:none!important} [data-ogsc] .logo-paper{display:block!important;max-height:none!important}
</style></head>
<body class="page" style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.page}">${esc(o.preheader)}${"&#847;&zwnj;&nbsp;".repeat(60)}</div>
<table role="presentation" class="wrap" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${C.page}" style="background:${C.page};padding:32px 16px">
<tr><td align="center">
  <!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;margin:0 auto">
    <tr><td style="padding:4px 4px 22px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
        <td valign="middle"><a href="${base}/" style="text-decoration:none"><img class="logo-ink" src="${base}/brand/email-logo-ink.png" width="168" height="57" alt="solveathome" style="display:block;border:0;width:168px;height:auto"><img class="logo-paper" src="${base}/brand/email-logo-paper.png" width="168" height="57" alt="" style="border:0;width:168px;height:auto"></a></td>
        <td class="mut" valign="middle" align="right" style="font:600 11px/1.4 ${FONT};letter-spacing:.12em;text-transform:uppercase;color:${C.mut}">${esc(o.eyebrow)}</td>
      </tr></table>
    </td></tr>
    <tr><td class="inner" bgcolor="${C.paper}" style="background:${C.paper};border:1px solid ${C.line};padding:36px 36px 40px;border-radius:2px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${o.body}</table>
    </td></tr>
    <tr><td class="mut" style="padding:22px 8px 8px;font:12px/1.6 ${FONT};color:${C.mut};text-align:center">
      ${esc(o.footerWhy)}<br>
      ${o.footerLinks.map(([href, label]) => `<a class="mut" href="${esc(href)}" style="color:${C.mut};text-decoration:underline">${esc(label)}</a>`).join(` &nbsp;&middot;&nbsp; `)}
      <br><a href="${base}/" style="color:${C.mut};text-decoration:none">solveathome.org</a>
    </td></tr>
  </table>
  <!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`;
}
