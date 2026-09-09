import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import express from 'express';
import {needsSourceReview, externalSources, readPublication, publishedDocument, BOOK_SOURCE} from '../src/lib/document-publication.ts';
import {checkUpload} from '../src/lib/files.ts';

// Synthetic text only; these fixtures reproduce no external publication.
const quotation = '# Literature note\n\nSource: https://example.org/paper\n\n> ' + Array.from({length: 32}, (_, i) => `fixture${i}`).join(' ');

const extract = 'BEGIN THIRD-PARTY SOURCE\n\n' + quotation;

test('source screening permits quotations and local citations while withholding explicit full copies', () => {
  assert.equal(needsSourceReview(quotation), false);
  assert.equal(checkUpload('quoted-research.md', quotation).ok, true);
  assert.equal(needsSourceReview('Local data — experiment-notes, commit abc1234, data/run-17.csv, rows 20–35; access: local-only.'), false);
  assert.equal(needsSourceReview('The source says “All rights reserved”; see https://example.org/paper.'), false);
  assert.equal(needsSourceReview('# Full transcription of a published paper\n' + quotation), true);
  assert.equal(needsSourceReview('%PDF-1.7'), true);
  assert.equal(needsSourceReview(extract), true);
  assert.equal(needsSourceReview('Section 4, p. 278, verbatim:\n> fixture text'), false);
  assert.equal(needsSourceReview(JSON.stringify({tool: {content: extract}})), true);
  assert.equal(needsSourceReview([JSON.stringify({usage: {input_tokens: 10}}), JSON.stringify({content: extract})].join('\n')), true);
  assert.equal(needsSourceReview('Report the script output verbatim: the measured values and hashes.'), false);
  assert.equal(needsSourceReview('Status is copied verbatim from the repo README at each dump.'), false);
  assert.equal(needsSourceReview('Our check found no counterexample. See https://example.org/paper.'), false);
  assert.equal(needsSourceReview(JSON.stringify({content: 'Our own analysis has many words. '.repeat(40), url: 'https://example.org/paper'})), false);
  assert.equal(checkUpload('note.md', extract).ok, false);
  assert.equal(checkUpload('check.py', 'print(2 + 2)\n').ok, true);
  assert.ok(externalSources('DOI 10.2307/3212998.').includes('https://doi.org/10.2307/3212998'));
  assert.ok(!externalSources('http://127.0.0.1/private https://user:password@example.org/').length);
});

test('prepared portfolio serves exact admitted bytes and redirects former book scans', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sah-publication-'));
  const source = join(root, 'private'), repos = join(root, 'repos'), out = join(repos, 'twin-primes');
  mkdirSync(source); mkdirSync(repos);
  writeFileSync(join(source, 'README.md'), '# Original research\n\nA finite measurement, with no claim of a proof.\n');
  writeFileSync(join(source, 'literature.md'), extract);
  writeFileSync(join(source, 'quoted-research.md'), quotation);
  writeFileSync(join(source, 'source.jsonl'), JSON.stringify({content: extract}));
  writeFileSync(join(source, 'book.png'), Buffer.from([137,80,78,71,13,10,26,10]));
  writeFileSync(join(source, 'disguised.txt'), '%PDF-1.7 fixture');
  writeFileSync(join(root, 'private.md'), '# Outside the portfolio');
  symlinkSync(join(root, 'private.md'), join(source, 'escape.md'));
  try {
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/prepare-document-portfolio.ts', source, out]);
    const manifest = readPublication(out);
    assert.equal(manifest.files['literature.md'].mode, 'source-links');
    assert.equal(manifest.files['quoted-research.md'].mode, 'project');
    assert.equal(readFileSync(join(out, 'quoted-research.md'), 'utf8'), quotation);
    assert.match(readFileSync(join(out, 'literature.md'), 'utf8'), /SHA-256 of the original working note/);
    assert.match(readFileSync(join(out, 'literature.md'), 'utf8'), /https:\/\/example.org\/paper/);
    assert.doesNotMatch(readFileSync(join(out, 'literature.md'), 'utf8'), /fixture0/);
    for (const path of ['source.jsonl', 'book.png', 'disguised.txt', 'escape.md']) assert.equal(existsSync(join(out, path)), false, path);
    assert.equal(publishedDocument(out, 'README.md', manifest), true);
    writeFileSync(join(out, 'unlisted.md'), 'Unreviewed material');
    symlinkSync(join(root, 'private.md'), join(out, 'escape.md'));
    assert.equal(publishedDocument(out, 'unlisted.md', manifest), false);
    assert.equal(publishedDocument(out, '../private.md', manifest), false);
    assert.equal(publishedDocument(out, 'escape.md', manifest), false);
    process.env.DOCS_DIR = repos;
    const {docs} = await import('../src/routes/docs.ts');
    const app = express(); app.use('/projects/:slug', docs);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/projects/twin-primes/docs/`;
    try {
      assert.equal((await fetch(base+'README.md')).status, 200);
      assert.equal((await fetch(base+'unlisted.md')).status, 404);
      assert.equal((await fetch(base+'escape.md')).status, 404);
      const listing = await (await fetch(base)).text();
      assert.doesNotMatch(listing, /unlisted|escape/);
      const scan = await fetch(base+'attestation/book-ch5-6/Screenshot.png', {redirect: 'manual'});
      assert.equal(scan.status, 303); assert.equal(scan.headers.get('location'), BOOK_SOURCE);
      writeFileSync(join(out, 'README.md'), 'changed since publication');
      assert.equal((await fetch(base+'README.md')).status, 404);
      rmSync(join(out, 'PUBLICATION.json'));
      assert.equal((await fetch(base+'literature.md')).status, 503);
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { rmSync(root, {recursive: true, force: true}); }
});
