import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import vm from 'node:vm';

// No page scrolls sideways on a phone (Oct 6 2026: display formulas on the kk-lower-bound paper pushed a 390 px page to 746 px).
const css = readFileSync('public/assets/app.css', 'utf8');

test('a display formula scrolls inside its own box and KaTeX\'s hidden MathML is held by its formula', () => {
  const rule = sel => (new RegExp(`(^|\\n)${sel.replace(/[.*]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css) || [])[2] || '';
  assert.match(rule('.katex-display'), /max-width:\s*100%/);
  assert.match(rule('.katex-display'), /overflow-x:\s*auto/);
  assert.match(rule('.katex'), /position:\s*relative/);
  assert.match(rule('.katex.katex-wide'), /overflow-x:\s*auto/);
  assert.match(rule('.katex.katex-wide'), /max-width:\s*100%/);
});

test('a page title that is one long file path wraps instead of widening the page', () => {
  assert.match(css, /\.page-heading h1 \{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.page-heading > \* \{[^}]*min-width:\s*0/);
});

test('the return and paper side panels never let a long file name widen a one-column grid', () => {
  const page = readFileSync('src/lib/page.ts', 'utf8');
  assert.match(page, /\.doc-side\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.doesNotMatch(page, /\.doc-side\{grid-template-columns:1fr\}/);
  assert.match(page, /\.doc-side>\*\{min-width:0/);
});

test('math.js marks an inline formula with a piece wider than its line, and only that one', () => {
  const el = (cls, props = {}) => ({classList: {set: new Set(cls), contains(c) { return this.set.has(c); }, toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); }}, ...props});
  const box = el([], {clientWidth: 358});
  const katex = (widths, display) => { const k = el(['katex'], {parentElement: box, closest: s => s === '.katex-display' && display ? {} : null}); k.querySelectorAll = () => widths.map(w => ({offsetWidth: w})); return k; };
  const wide = katex([500]), narrow = katex([120, 200, 300]), shown = katex([900], true);
  const root = {querySelectorAll: () => [wide, narrow, shown]};
  const document = {head: {appendChild: s => s.onload && s.onload()}, body: root, createElement: () => ({})};
  const window = {addEventListener() {}};
  const context = {window, document, getComputedStyle: () => ({display: 'block'}), setTimeout() {}, clearTimeout() {},
    MutationObserver: class { observe() {} }, renderMathInElement() {}};
  vm.runInNewContext(readFileSync('public/assets/math.js', 'utf8'), context);
  window.renderMath(root);
  assert.equal(wide.classList.contains('katex-wide'), true);
  assert.equal(narrow.classList.contains('katex-wide'), false);   // several pieces wrap on their own
  assert.equal(shown.classList.contains('katex-wide'), false);    // display math scrolls in .katex-display
});

test('every page asks for the same app.css and math.js versions, so a changed rule reaches every page', () => {
  const files = ['src/lib/page.ts', 'src/lib/seo.ts', 'src/routes/docs.ts', 'src/routes/dumps.ts', 'src/routes/email.ts', ...readdirSync('public').filter(f => f.endsWith('.html')).map(f => `public/${f}`)];
  for (const asset of ['app.css', 'math.js']) {
    const versions = new Set(files.flatMap(f => [...readFileSync(f, 'utf8').matchAll(new RegExp(`/assets/${asset.replace('.', '\\.')}\\?v=(\\d+)`, 'g'))].map(m => m[1])));
    assert.equal(versions.size, 1, `${asset} versions: ${[...versions].join(', ')}`);
  }
});
