// The lint and voice core of mba tools/bin/mail-gate, for a site's own save check of mail text (ask 6366; rules #r1, #r63, #r913).
// One file beside antiai-lint.ts, copied with it as they stand into a site (e.g. server/@mba/email/services/). Change it in mba.
//   mail-lint v1 (antiai-lint v6)
//
// What it checks, as mail-gate --no-detect does: the anti-AI linter (banned words and phrases, dashes, the shape of AI prose;
// "!" is a warning, once is fine), and the mail voice of notes/writing-style-guide.md §3 and §13: "I", never "we" (a site
// mail can say neither and name the site), no dashes or semicolons, plain links with no tracking, no line break inside a
// sentence in the plain-text body. Template variables ({{name}}, {{#if x}}) are read as a plain word, so they never count.
// The detectors are not run here: they send the text to public services. mail-gate runs them on the fixed templates.
//
//   const r = checkMail({ subject, text: text_body, html: html_body, names: ['DailyPlay'] });
//   if (r.refused.length) -> refuse the save and show r.refused to whoever saved it
import { lintText } from './antiai-lint.js';

export const MAIL_LINT_V = 1;
export interface MailCheck { refused: string[]; warnings: string[]; shape: number }

const URL_RE = /https?:\/\/[^\s<>()"']+/g;
const TRACKING = /[?&](utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|ref|ref_src|igshid|yclid)=/i;

/** Template variables and block helpers read as a plain word: {{user.name}} -> Sam, {{#if x}} and {{/if}} -> nothing. */
export function stripVars(t: string): string {
  return t
    .replace(/\{\{[#/^!>][^}]*\}\}\}?/g, '')
    .replace(/\{\{\{?\s*else\s*\}?\}\}/g, '')
    .replace(/\{\{\{?[^}]*\}\}\}?/g, 'Sam')
    .replace(/\$\{[^}]*\}/g, 'Sam');
}

/** The reader's text of an HTML mail: no head or style, a paragraph per block, entities decoded, links kept as their URLs. */
export function htmlText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>/gi, ' $1 ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|td|blockquote)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&mdash;|&#8212;|&#x2014;/gi, '—').replace(/&ndash;|&#8211;|&#x2013;/gi, '–').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'")
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function voice(body: string, names: string[], plain: boolean): string[] {
  const out: string[] = [];
  let own = body.replace(URL_RE, ' ').replace(/\S+@\S+\.\w+/g, ' ');
  for (const n of names) own = own.split(n).join(' ');
  const we = [...own.matchAll(/\b(we|we're|we've|we'll|we'd|our|ours|ourselves|us)\b/gi)]
    .filter((m) => !(/^[A-Z]/.test(m[0]) && /[\w,][ \t]+$/.test(own.slice(Math.max(0, (m.index ?? 0) - 3), m.index)))).map((m) => m[0]).filter((w) => w !== 'US');
  if (we.length) out.push(`"${[...new Set(we.map((w) => w.toLowerCase()))].join('", "')}": "I", never "we" (or name the site)`);
  if (/—|[ \t]–[ \t]|[ \t]-[ \t]|[ \t]--[ \t]/.test(own)) out.push('a dash as a joiner: use a comma, a colon or two sentences');
  if (own.includes(';')) out.push('a semicolon: split it into two sentences');
  const tracked = (body.match(URL_RE) ?? []).filter((l) => TRACKING.test(l));
  if (tracked.length) out.push(`tracking in a link (${tracked[0]}): links are plain, no UTMs`);
  if (plain) {
    const lines = body.replace(/\r/g, '').split('\n');
    for (let i = 1; i < lines.length; i++) {
      const cur = lines[i].trim();
      if (lines[i - 1].trim() && /^[a-z]/.test(cur) && /\s/.test(cur) && !/^(https?:\/\/|www\.)/.test(cur)) { out.push(`a line break inside a sentence before "${cur.slice(0, 30)}"`); break; }
    }
  }
  return out;
}

/** Lint and voice of one mail: subject, plain-text body and HTML body (any may be empty). refused blocks the save. */
export function checkMail(m: { subject?: string | null; text?: string | null; html?: string | null; names?: string[] }): MailCheck {
  const names = m.names ?? [];
  const parts: { body: string; plain: boolean }[] = [];
  if (m.subject) parts.push({ body: stripVars(m.subject), plain: false });
  if (m.text) parts.push({ body: stripVars(m.text), plain: true });
  if (m.html) parts.push({ body: stripVars(htmlText(m.html)), plain: false });
  const refused = new Set<string>(); const warnings = new Set<string>(); let shape = 0;
  for (const p of parts) {
    const lint = lintText(p.body.split(/\n\s*\n/), { kind: 'generic', names });
    shape = Math.max(shape, lint.shape);
    for (const r of lint.refused) (r.startsWith('exclamation') ? warnings.add('an exclamation mark: fine once, never two') : refused.add(`lint: ${r}`));
    for (const w of lint.warnings) warnings.add(w);
    for (const v of voice(p.body, names, p.plain)) refused.add(`voice: ${v}`);
  }
  return { refused: [...refused], warnings: [...warnings], shape };
}
