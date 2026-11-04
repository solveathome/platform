// The anti-AI style linter for every content bot's save check (mba tools/antiai/lint/antiai-lint.ts, ask 4384; the plan:
// mba notes/anti-ai-gate-content-bots.md). One file, no imports, the same in every repo: a site copies it as it stands
// and keeps the header line below with the version, so a diff against mba says when a copy is behind. Change it in mba.
//   antiai-lint v6
//
// The rules come from what we had: game-explorer server/writing.ts (banned words, phrases, dashes, mirrors) and
// server/style.ts (the shape of AI prose: rhythm, lists of three, ", making ..." tails, stock copy, openers, closers),
// dailygamestoplay/horrorgamestoplay server/lib/game.ts (puffery, the site saying how it is made, "!"), SprySpy's email
// linter (fix rounds), and mba notes/writing-style-guide.md §7 to §9 and its blocklist.
//
// How a site uses it, in its save check:
//   const fresh = newText(before, after);                 // only text this save adds: never what is already published
//   const lint = lintText(fresh, { kind: 'game', names: [g.name, g.developer], old: oldText(before) });
//   const r = rounds.judge(`game:${g.slug}`, lint);       // fix rounds: refuse, refuse, refuse, then pass with warnings
//   refused.push(...r.refused); warnings.push(...r.warnings);
// A refusal names the rule and what to change, so the bot fixes it in the same run and saves again (SprySpy's fix rounds,
// as a 422). After MAX_ROUNDS refusals of the same record within a few hours the save passes and the findings come back
// as warnings (gave_up), so a bot never loops on a rule it cannot meet.
// Never add a fact to pass (game-explorer, Round 5): every reason says to rewrite, never to add.

export const LINT_V = 5;   // 2: proper nouns and literal uses no longer refuse (the first calibration, 26 Oct); 3: a title in title case is still checked;
// 4: list items (opts.items) are linted for words and per-sentence shape, not for rhythm across items (3-day look, 29 Oct);
// 5: opts.old: in a changed paragraph only new or changed sentences have findings, the whole paragraph is the rate (ask 5163)

export type Kind = 'game' | 'product' | 'colour' | 'mcp' | 'facts' | 'generic';
export interface LintOptions {
  kind?: Kind;
  /** Names the text may use as they are: the record's own name, maker, brand, series (their words never count). */
  names?: string[];
  /** Words of the banned list this site uses literally (a dog harness on barcodepedia). */
  allow?: string[];
  /** New text that is a list of separate one-line items (a similar game's why, a topic's per-game line): words, dashes,
   *  semicolons and the per-sentence shape rules (lists of three, tails, stock, openers, mirrors) apply; the rhythm across
   *  them (sentence-length spread, paragraph lengths, the same first word) does not, as parallel items are alike by design
   *  (dgp, 26 to 28 Oct: 44 of 50 shape refusals scored only the 8 similar-game lines of a game check). */
  items?: (string | null | undefined)[];
  /** The text before this save (oldText(before), put through the same site-side strip as the new text): a sentence of a
   *  changed paragraph that was already there counts toward the rates (words, sentences, rhythm) but has no findings of
   *  its own, so a small edit is not scored on the sentences around it (dgp feedback 3941, 4014, 3968; ask 5163). */
  old?: (string | null | undefined)[];
}
export interface Finding { key: string; points: number; why: string }
export interface LintResult { v: number; refused: string[]; warnings: string[]; shape: number; findings: Finding[]; words: number }

/** The shape score at or above this refuses (game-explorer's STYLE_MAX, measured on human and AI game text). */
export const SHAPE_MAX = 20;
/** Lint refusals of one record before its save passes with the findings as warnings. */
export const MAX_ROUNDS = 3;

// ---------------------------------------------------------------- words and phrases

/** Words that sell instead of describe (dgp/hgp PUFFERY, gx writing.ts). */
const PUFFERY = /\b(ultimate|must-play|a must play|must-have|addictive|addicting|amazing|awesome|stunning|breathtaking|incredible|unparalleled|best ever|world-class|mind-blowing|game-?changer|captivating|enthralling|exhilarating|unforgettable|masterpiece|masterful|jaw-dropping|spectacular|engrossing|endless fun|hours of fun|second to none|like never before|top-notch|unique blend|perfect blend|state-of-the-art|best-in-class|next-level)\b/i;
/** The site saying how it is made: refused (dgp SITE_METHOD). */
const SITE_METHOD = /\b(AI-written|written (by|with) (an )?AI|(generated|written) by (an? )?(language model|bot|AI)|our (bots?|AI|algorithms?|language models?)|this (page|site|guide|list|entry|description) (was|is) (written|generated|made) by)\b/i;
/** notes/writing-style-guide.md §7 and the appendix blocklist. */
const BANNED_WORDS = /\b(delve[sd]?|delving|embark(s|ed|ing)?|elucidate[sd]?|unveil(s|ed|ing)?|harness(es|ed|ing)?|utili[sz]e[sd]?|utili[sz]ing|utili[sz]ation|facilitate[sd]?|leverag(e|es|ed|ing)|endeavou?rs?|foster(s|ed|ing)?|spearhead(s|ed)?|bolster(s|ed)?|underscore[sd]?|encompass(es|ed|ing)?|garner(s|ed)?|resonate[sd]?|pivotal|crucial|intricate|nuanced|multifaceted|robust|comprehensive|groundbreaking|cutting-edge|transformative|unprecedented|invaluable|indispensable|paramount|compelling|seamless(ly)?|tapestry|paradigm|synergy|cornerstone|bedrock|linchpin|catalyst|nexus|revolutioni[sz]e[sd]?|skyrocket(s|ed)?|streamline[sd]?|supercharge[sd]?|empower(s|ed|ing)?|arguably|certainly|undeniably|fundamentally|essentially|inherently|remarkabl[ey]|profoundly|meticulous(ly)?|effortless(ly)?|thoughtfully|testament|unleash(es|ed|ing)?|elevate[sd]?|boasts?|showcas(e|es|ed|ing)|vibrant|myriad|plethora|bustling|enigmatic|evocative|visceral|palpable|in essence)\b/i;
/** Literal as often as not (a fantasy realm, a crafting system, the colour landscape green): a flag to read again. */
const LITERAL_OK = /\b(reimagine[sd]?|realm|landscape|journey|ecosystem|framework|craft(ing|ed|s)?|navigate[sd]?|navigating|unlock(s|ed|ing)?|optimi[sz](e|es|ed|ing))\b/i;
const BANNED_PHRASES = /\b(in today's|in a world where|it's worth noting|it is worth noting|worth noting that|it should be noted|it's important to (remember|note)|one might argue|here's the thing|here's why|let's break|rich tapestry|shed(s)? light on|played a crucial role|double-edged sword|isn't (just )?about\b[^.]{0,40}, it'?s about|this isn't about|furthermore|additionally|moreover|in conclusion|in summary|sits at the intersection|the future is already here|whether you'?re an?\b|look no further|dive (right )?in(?:to)?(?=[.,!]| (the|this|its|their|our)\b)|deep dive|step into the (shoes|world)|sure to (please|delight)|something for everyone|stands out (as|from)|takes? (you|players) on an?\b|at its (finest|best(?! (known|selling|part|kept))|core|heart)|in its truest form|a (true|real) (gem|treat|standout)|nestled|a symphony of|a feast for|a love letter to|elevates? (the|your)|when it comes to|it's no (secret|wonder)|not for the faint of heart)/i;
/** Stock copy: each fine once, a text full of them reads generated (gx style.ts STOCK, split by kind). */
const STOCK_COMMON = /\b(carefully|beautifully|wonderfully|perfectly|truly|genuinely|endless(ly)?|a (wide |huge |vast |broad )?(variety|range|array|wealth|host|selection) of|plenty of|countless|a sense of|blend(s|ing)? of|strikes? a balance|balance(s|d)? (between|of)|whole new|fresh take|innovative|timeless|beloved|iconic|standout|stands? as|serves? as|true to|feels? (fresh|alive|earned)|ever-(changing|evolving|growing|expanding)|for (fans|lovers) of|perfect for|ideal for|great for|a great (choice|pick|way)|well worth|worth (your|the) (time|price|money)|offers?|offering|provides?|providing|delivers?|allows? (you|users|players) to|designed (to|for)|whether (you|it|they))\b/i;
const STOCK_GAME = /\b(engaging|satisfying|rewarding|charming|delightful|memorable|polished|well[- ]crafted|hand-?crafted|deep(ly)?|depth|rich|layers? of|sense of (discovery|accomplishment|progression|wonder|dread|freedom|scale|achievement|humou?r|place)|keeps? (you|players) coming back|hours of|time flies|experience[sd]?|lets? (you|players) (enjoy|experience|explore)|cult classic|genre-defining|easy to (learn|pick up)|hard to master|pick[- ]up[- ]and[- ]play|feels? (rewarding|satisfying))\b/i;
const SUMMARY = /^(Overall|In short|All in all|Ultimately|In the end|Taken together|Simply put|Put simply|In sum|The result is|The end result|Together,|Combined,)|\b(makes? (it|this|for) (a|an|one)\b|is (a|an) (great|perfect|ideal|solid|excellent|strong|good) (choice|pick|fit|option|entry|place)|well worth|worth (a|your) (look|try|time))/i;
const OPENER = /^(With (its|a|an|the)|Featuring|Boasting|Set (in|against)|From (the )?[a-z]+ to|Whether|If you('re| are| like| enjoy)|For those who|Fans of|At (its|their) (core|heart)|What (sets|makes)|Beyond (its|the)|Not only|Combining|Blending|Offering|Mixing|Packed with|Built (around|on))/;
const MIRROR = /\b(not|rather than|instead of) [^,.;]{1,35}, but\b|\bnot (just|only|merely)\b|\bless (about|a) [^,.;]{1,30}(than|and more)\b|\bwhether (you|it|they|players|users)\b[^.]{0,60}\bor\b|\bas much [^,.;]{1,25} as\b/i;
const TAIL = /, (making|creating|adding|giving|offering|allowing|ensuring|leaving|turning|keeping|providing|letting|resulting|forcing|rewarding|encouraging|delivering|bringing|enabling|highlighting|reflecting|underscoring|showcasing) (it|them|each|every|the|a|an|you|players|users|for|in|up|this)\b/i;
const THREE = /\b[\w'’-]+(?: [\w'’-]+){0,3}, [\w'’-]+(?: [\w'’-]+){0,3},? (?:and|or) [\w'’-]+/i;
/** "It's not X. It's Y." */
const NOT_X_Y = /\b(It'?s|This is|That'?s) not (just )?[^.]{1,40}\. (It'?s|This is|That'?s)\b/;
/** "Focused. Premium. Uninterrupted." */
const WORD_CHAIN = /(\b[A-Z][a-z]+\.\s+){3,}/;
/** Names that hold a banned word and are no one's choice of word (Epic Games, Unreal's "Ultimate Edition"). */
const PROPER = /\b(Epic Games( Store)?|Ultimate Edition|Ultimate Collection|Comprehensive R Archive Network|Robust Intelligence)\b/g;

// ---------------------------------------------------------------- text helpers

const ABBR = /\b(vs|Mr|Mrs|Dr|St|No|Vol|etc|e\.g|i\.e|approx|ca|Inc|Ltd|Co|Corp|fig)\.$/i;
/** Sentences of a text: split after . ? ! (and a closing quote) before a capital, digit or quote. */
export function sentences(t: string): string[] {
  const parts = t.replace(/\s+/g, ' ').trim().split(/(?<=[.?!]["”’)]?)\s+(?=["“‘(]?[A-Z0-9])/);
  const out: string[] = [];
  for (const p of parts) { if (out.length && ABBR.test(out[out.length - 1])) out[out.length - 1] += ' ' + p; else out.push(p); }
  return out.filter((s) => /[A-Za-z]{2,}/.test(s));
}
const wordsOf = (s: string) => s.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? [];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const cv = (xs: number[]) => { const m = mean(xs); return m ? Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) / m : 0; };
const all = (t: string, re: RegExp) => [...t.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))].map((m) => m[0]);
/** Matches that are our own words: a capitalised match inside a sentence is a name (a game called Underscore), not a choice of word. */
const words_ = (t: string, re: RegExp) => [...t.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))]
  .filter((m) => !(/^[A-Z]/.test(m[0]) && m.index! > 0 && !/(^|[.!?:]\s+|\n\s*)$/.test(t.slice(Math.max(0, m.index! - 3), m.index)))).map((m) => m[0]);
const titleLike = (b: string) => { const w = wordsOf(b); return w.length > 0 && w.length <= 14 && !/[.!?]$/.test(b.trim()) && w.filter((x) => /^[A-Z0-9]/.test(x)).length / w.length >= 0.6; };
/** A sentence as compared with the text before: case, spacing and punctuation do not make it new. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text with what is not our own wording taken out: quotes, code, URLs, and the record's own names. */
export function ownWords(text: string, names: string[] = []): string {
  let t = text
    .replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/"[^"\n]{1,120}"|“[^”\n]{1,120}”|‘[^’\n]{1,80}’/g, ' ')
    .replace(/(^|[\s(])'[^'\n]{1,40}'(?=[\s.,;:)!?]|$)/g, '$1 ')
    .replace(PROPER, ' ');
  for (const n of names.filter((x) => x && x.trim().length > 2).sort((a, b) => b.length - a.length)) t = t.replace(new RegExp(esc(n.trim()), 'gi'), ' ');
  return t;
}

/**
 * The text a save adds: each string of `after` (a field, a list item) split into paragraphs, without the paragraphs
 * `before` already had anywhere. Only these are linted, so a re-save of a published record never refuses text that is
 * already live (ask 4200, 26 Oct: nothing published is rewritten). `before` null: a new record, all of it is new.
 */
export function newText(before: unknown, after: unknown): string[] {
  const old = new Set(strings(before).flatMap(paras));
  return strings(after).flatMap(paras).filter((p) => !old.has(p));
}
/** The paragraphs `before` had: lintText's opts.old. */
export function oldText(before: unknown): string[] {
  return strings(before).flatMap(paras);
}
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) strings(x, out);
  return out;
}
const paras = (s: string) => s.split(/\n\s*\n|\r?\n(?=[-*•\d])/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => /[A-Za-z]{2}/.test(p));

// ---------------------------------------------------------------- the linter

/** Lint the new text of one save. Blocks: paragraphs or fields; prose shorter than a sentence is checked for words only. */
export function lintText(blocks: (string | null | undefined)[], opts: LintOptions = {}): LintResult {
  const kind = opts.kind ?? 'generic';
  const refused: string[] = [];
  const warnings: string[] = [];
  const clean = (bs: (string | null | undefined)[]) => bs.filter((b): b is string => !!b && /[A-Za-z]{2}/.test(b)).map((b) => b.trim());
  const prose = clean(blocks);
  const items = clean(opts.items ?? []);
  const texts = [...prose, ...items];
  const oldSet = new Set(clean(opts.old ?? []).flatMap((t) => sentences(ownWords(t, opts.names))).map(norm));
  // the words rules read only the sentences that are new; the count they divide by (words) stays whole
  const fresh = (t: string) => (oldSet.size ? sentences(t).filter((s) => !oldSet.has(norm(s))).join(' ') : t);
  const own = texts.map((t) => fresh(ownWords(t, opts.names))).join('\n\n');
  const ownBlocks = texts.map((t) => fresh(ownWords(t, opts.names)));
  const allow = new Set((opts.allow ?? []).map((w) => w.toLowerCase()));
  // a title in title case ("The Ultimate Word Games") is checked whatever its capitals; elsewhere a capitalised match inside a sentence is a name
  const ours = (re: RegExp) => ownBlocks.flatMap((b) => (titleLike(b) ? all(b, re) : words_(b, re)));
  const hit = (re: RegExp) => ours(re).find((w) => !allow.has(w.toLowerCase()));
  const words = wordsOf(ownWords(texts.join('\n\n'), opts.names)).length;
  let m: string | undefined;

  if ((m = hit(SITE_METHOD))) refused.push(`"${m}": the site never says how its pages are made`);
  if ((m = hit(PUFFERY))) refused.push(`"${m}" sells rather than describes: say what it does instead`);
  const banned = [...new Set(ours(BANNED_WORDS).map((w) => w.toLowerCase()).filter((w) => !allow.has(w)))];
  if (banned.length) refused.push(`${banned.slice(0, 5).map((w) => `"${w}"`).join(', ')} ${banned.length > 1 ? 'are' : 'is'} on the banned word list: use the plain word (use, show, make, help, important, full)`);
  if ((m = hit(BANNED_PHRASES))) refused.push(`"${m}" is a stock phrase: say the concrete thing, or cut it`);
  if ((m = hit(LITERAL_OK))) warnings.push(`"${m}": fine when literal, never as a metaphor`);
  if (/\s[—–]\s|—|\s--\s/.test(own)) refused.push('dashes as joiners (— or –): use a comma, a colon, brackets or two sentences');
  const semis = (own.match(/;/g) ?? []).length;
  if (semis > Math.max(1, Math.floor(words / 400))) refused.push(`${semis} semicolons: split into sentences (one per few hundred words at most)`);
  if ((m = hit(NOT_X_Y))) refused.push(`"${m}…": the "not X. It's Y" mirror; say what it is`);
  if ((m = hit(WORD_CHAIN))) refused.push(`"${m.trim()}": a chain of one-word sentences`);
  if (kind !== 'facts' && /!/.test(own.replace(/\b[A-Z][\w'’-]*!+/g, '').replace(/![=]/g, ''))) refused.push('exclamation marks: the voice is calm');

  const st = shapeScore(prose.map((t) => ownWords(t, opts.names)), kind, items.map((t) => ownWords(t, opts.names)), oldSet);
  if (st.score >= SHAPE_MAX) refused.push(`reads machine-made (style score ${st.score}, under ${SHAPE_MAX} passes): ${st.findings.slice(0, 4).map((f) => f.why).join('; ')}. Rewrite in your own words; never add a fact to pass`);
  else if (st.findings.length) warnings.push(...st.findings.filter((f) => f.points >= 4).slice(0, 2).map((f) => f.why));
  return { v: LINT_V, refused, warnings, shape: st.score, findings: st.findings, words };
}

/** The shape of AI prose, 0 (a person) to 100 (gx style.ts, Round 5 thresholds). Rates only on texts long enough to have one.
 *  items: list lines, counted for the per-sentence rules only (see LintOptions.items). */
export function shapeScore(prose: string[], kind: Kind = 'generic', items: string[] = [], old: Set<string> = new Set()): { score: number; findings: Finding[] } {
  const ps = prose.map((p) => p.trim()).filter(Boolean);
  const its = items.map((p) => p.trim()).filter(Boolean);
  const text = [...ps, ...its].join('\n');
  const sents = ps.flatMap(sentences);
  const every = [...sents, ...its.flatMap(sentences)];
  const lens = sents.map((s) => wordsOf(s).length);
  const words = every.reduce((a, s) => a + wordsOf(s).length, 0) || 1;
  const n = sents.length || 1;
  const all_ = every.length || 1;
  // old: normalised sentences already there before the save. Findings count in the others only; the rates divide by all
  // of them, and a rule over the whole text (rhythm, paragraph lengths) weighs by the share of sentences that are new.
  const isNew = (s: string) => !old.has(norm(s));
  const fresh = every.filter(isNew);
  const freshSents = sents.filter(isNew);
  const share = sents.length ? freshSents.length / sents.length : 1;
  const findings: Finding[] = [];
  const add = (key: string, points: number, why: string) => { if (points > 0) findings.push({ key, points: Math.round(points * 10) / 10, why }); };
  const long = sents.length >= 6;
  if (long) {
    const lenCv = cv(lens);
    const mid = lens.filter((l) => l >= 12 && l <= 26).length / n;
    if (lenCv < 0.42) add('rhythm', (0.42 - lenCv) * 60 * share, `sentence lengths barely vary (spread ${lenCv.toFixed(2)}; people write over 0.45): put a short sentence next to a long one`);
    if (mid > 0.7) add('rhythm-mid', (mid - 0.7) * 30 * share, `${Math.round(mid * 100)}% of sentences are 12 to 26 words: break some up, let one run on`);
  }
  if (ps.length >= 3) { const pc = cv(ps.map((p) => wordsOf(p).length)); if (pc < 0.15) add('paragraphs', (0.15 - pc) * 60 * share, 'the paragraphs are all the same length: make one short'); }
  const per = (x: number) => (every.length >= 6 ? x / all_ : 0);
  // the finding quotes the lists it counted, so a bot can find them (dgp bot feedback 4500: "warns of 3 lists of three
  // without naming the sentences")
  const threeList = fresh.map((s) => s.match(THREE)?.[0]).filter((x): x is string => !!x);
  const threes = threeList.length;
  if (per(threes) > 0.2) add('three', (per(threes) - 0.2) * 40, `${threes} lists of three ("X, Y and Z") in ${every.length} sentences: name two things, or four, or one (${threeList.slice(0, 4).map((x) => `"${x}"`).join(', ')})`);
  const tails = old.size ? fresh.reduce((a, s) => a + all(s, TAIL).length, 0) : all(text, TAIL).length;
  if (tails) add('tail', Math.max(0, tails - (words > 250 ? 1 : 0)) * 4, `${tails} sentences end in a ", making/adding/giving ..." tail: end the sentence and start a new one`);
  const freshText = old.size ? fresh.join('\n') : text;
  const stockHits = [...all(freshText, STOCK_COMMON), ...(kind === 'game' ? all(freshText, STOCK_GAME) : [])];
  const stockPer100 = (stockHits.length / words) * 100;
  if (stockPer100 > 1.2 && stockHits.length >= 3) add('stock', (stockPer100 - 1.2) * 7, `${stockHits.length} stock copy words (${[...new Set(stockHits.map((x) => x.toLowerCase()))].slice(0, 6).join(', ')}): say the concrete thing instead`);
  const mirrors = fresh.filter((s) => MIRROR.test(s)).length;
  if (per(mirrors) > 0.08) add('mirror', (per(mirrors) - 0.08) * 60, `${mirrors} mirrored sentences ("not X, but Y", "whether X or Y"): say it straight`);
  const openers = fresh.filter((s) => OPENER.test(s)).length;
  if (openers) add('opener', openers * 3, `${openers} sentences open with a stock lead-in ("With its", "Featuring", "Whether", "At its core"): start with the subject`);
  const closers = ps.filter((p) => { const ss = sentences(p); const last = ss[ss.length - 1]; return ss.length > 1 && isNew(last) && SUMMARY.test(last); }).length + freshSents.filter((s) => /^(Overall|In short|All in all|Ultimately|Simply put)\b/.test(s)).length;
  if (closers) add('closer', closers * 5, `${closers} summary closers ("Overall", "makes it a great pick"): stop when the facts stop`);
  const firsts = sents.map((s) => (wordsOf(s)[0] ?? '').toLowerCase());
  const top = [...firsts.reduce((mm, w) => mm.set(w, (mm.get(w) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  if (sents.length >= 8 && top[1] / n > 0.3 && top[0] !== 'the') add('same-first', (top[1] / n - 0.3) * 40 * share, `${top[1]} of ${sents.length} sentences start with "${top[0]}": vary how they start`);
  const score = Math.min(100, Math.round(findings.reduce((a, f) => a + f.points, 0)));
  return { score, findings: findings.sort((a, b) => b.points - a.points) };
}

// ---------------------------------------------------------------- fix rounds

/**
 * Fix rounds per record (SprySpy's email fix rounds, as save refusals): the first MAX_ROUNDS lint refusals of a record
 * stand; the next save of it within `ttlMs` passes, with the findings as warnings and gave_up set, so the site can log it.
 * In memory: a restart starts the count again, which only costs a few more rounds.
 */
export class FixRounds {
  private n = new Map<string, { count: number; at: number }>();
  max: number;
  ttlMs: number;
  constructor(max = MAX_ROUNDS, ttlMs = 6 * 3600_000) { this.max = max; this.ttlMs = ttlMs; }
  judge(key: string, lint: LintResult): { refused: string[]; warnings: string[]; round: number; gave_up: boolean } {
    const now = Date.now();
    for (const [k, v] of this.n) if (now - v.at > this.ttlMs) this.n.delete(k);
    if (!lint.refused.length) { this.n.delete(key); return { refused: [], warnings: lint.warnings, round: 0, gave_up: false }; }
    const cur = this.n.get(key) ?? { count: 0, at: now };
    if (cur.count >= this.max) {
      this.n.delete(key);
      return { refused: [], warnings: [...lint.refused.map((r) => `style (passed after ${this.max} rounds, fix when you next touch it): ${r}`), ...lint.warnings], round: cur.count + 1, gave_up: true };
    }
    this.n.set(key, { count: cur.count + 1, at: now });
    return { refused: lint.refused.map((r) => `style, round ${cur.count + 1} of ${this.max}: ${r}`), warnings: lint.warnings, round: cur.count + 1, gave_up: false };
  }
}
