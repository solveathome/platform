import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectNavItems, projectNavBarHtml, projectSectionNav, projectNavBar} from '../src/lib/project-nav.ts';
import {siteHeaderHtml} from '../src/lib/home.ts';

// The site header is site-wide; what belongs to one problem is in that project's own nav (#sah-nav-context-split, Oct 20 2026).
test('the site header carries no project link', () => {
  const header = siteHeaderHtml('home'), ui = readFileSync('public/assets/ui.js', 'utf8');
  assert.doesNotMatch(header, /visualizations|twin-primes|Replay/);
  assert.doesNotMatch(ui, /\/projects\/twin-primes/);
});

test('each project lists only what its own config and files carry', () => {
  const labels = slug => projectNavItems(slug).map(i => i.label);
  assert.ok(labels('twin-primes').includes('Proposed OEIS sequences'));
  assert.ok(labels('twin-primes').includes('The record'));
  assert.ok(!labels('md5').includes('Proposed OEIS sequences'));
  assert.ok(!labels('md5').includes('The record'));
  for (const slug of ['twin-primes', 'md5']) assert.ok(labels(slug).includes('Replay'));
  assert.deepEqual(projectNavItems('no-such-project'), []);
  assert.match(projectSectionNav('twin-primes'), /<a href="#work" data-panel-link><span>02<\/span>Work queue<\/a>/);
});

test('a sub-page gets the bar with its own item current; the project page and other projects do not', () => {
  const bar = projectNavBarHtml('twin-primes', '/papers/some-paper');
  assert.match(bar, /<a href="\/projects\/twin-primes#papers" aria-current="page">Proposed papers<\/a>/);
  assert.equal((bar.match(/aria-current/g) || []).length, 1);
  const run = (path, slug, body, type = 'text/html') => {
    let sent; const res = {getHeader: () => type, send: b => { sent = b; return res; }};
    projectNavBar({method: 'GET', params: {slug}, path}, res, () => {});
    res.send(body); return sent;
  };
  const shell = '<body><header data-site-header></header><main></main></body>';
  assert.match(run('/understanding', 'twin-primes', shell), /<\/header><nav class="project-nav"[^]*aria-current="page">The record</);
  assert.equal(run('/', 'twin-primes', shell), shell);
  assert.equal(run('/understanding', 'no-such-project', shell), shell);
  assert.equal(run('/board', 'twin-primes', '{"a":1}', 'application/json'), '{"a":1}');
  const twice = run('/understanding', 'twin-primes', run('/understanding', 'twin-primes', shell));
  assert.equal((twice.match(/class="project-nav"/g) || []).length, 1);
});
