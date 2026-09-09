/* Prior-work records describe research and provenance, never platform credit or proof counts. */
(function () {
  const {esc, number} = SA;
  const date = value => {
    const d = new Date(value);
    return value && Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'}) : 'Not recorded';
  };
  const profile = handle => `<a href="/@${encodeURIComponent(handle)}">@${esc(handle)}</a>`;
  const modelHistory = c => Object.entries(c.model_commits || {}).filter(([model, count]) => Number(count) > 0 && !['claude-marked', 'claude-dispatched'].includes(model)).map(([model, count]) => `${esc(model)}: ${number(count)}`).join(' · ');
  const statusLabel = value => String(value || 'Unknown').toLowerCase().replace(/^./, c => c.toUpperCase());

  window.renderPriorWork = function (root, slug, data) {
    const $ = selector => root.querySelector(selector);
    const claims = data.claims || [], origins = data.by_origin || [];
    const notes = claims.filter(c => c.kind === 'note').length;
    const scripts = claims.filter(c => c.kind === 'script').length;
    const dates = claims.flatMap(c => [c.first_commit, c.last_commit]).filter(v => v && Number.isFinite(new Date(v).getTime())).sort();
    $('#prov-tiles').innerHTML = `<div class="metric"><b>${number(notes)}</b><span>Indexed research notes</span></div><div class="metric"><b>${number(scripts)}</b><span>Indexed research scripts</span></div><div class="archive-period"><span>Recorded Git history</span><p>${dates.length ? `${date(dates[0])} – ${date(dates.at(-1))}` : 'Dates not recorded'}</p><small>The indexed files include research, audits, and working instructions.</small></div>`;
    $('#prov-origin').innerHTML = origins.map(o => {
      const chris = slug === 'twin-primes' && o.origin_handle.toLowerCase() === 'benjaminsen';
      const models = chris && /claude/i.test(o.origin_model || '') && /gpt-6-astra/i.test(o.origin_model || '') ? 'Claude (Fable or Opus) and GPT-6 Astra' : o.origin_model || 'Models not recorded';
      return `<article class="origin-credit"><div class="origin-credit-heading"><h3>${chris ? 'Chris Moltke-Benjaminsen' : esc(o.origin_handle)}</h3>${profile(o.origin_handle)}</div><div class="research-roles"><div><p class="eyebrow">${chris ? 'Framework, questions & research direction' : 'Research contribution'}</p><p>${chris ? 'Developed the moiré/tile perspective and vocabulary through independent experiments, posed the driving questions, and directed and reviewed the agent-assisted work.' : esc(o.origin_role || 'Role not recorded.')}</p></div><div><p class="eyebrow">Agent-assisted development</p><h4>${esc(models)}</h4><p>${chris ? 'Contributed formal derivations, computational experiments, validators, literature audits, and drafting under the researcher’s direction. Review rounds also corrected proof gaps and narrowed claims.' : esc(o.origin_model_role || 'Agent roles not recorded.')}</p></div></div><details class="details attribution-detail"><summary>Attribution sources &amp; recording limits</summary><p>${esc(o.origin_note || 'No additional attribution statement is recorded.')}</p><dl class="attribution-facts"><div><dt>Recorded human role</dt><dd>${esc(o.origin_role)}</dd></div><div><dt>Recorded agent role</dt><dd>${esc(o.origin_model_role)}</dd></div><div><dt>Files present in the first repository snapshot</dt><dd>${number(o.corpus_claims)} indexed files. This marks their presence in that snapshot, not the date of each original insight.</dd></div><div><dt>File-history entries</dt><dd>${number(o.commits)} across these files. A commit touching several files is counted once for each file; this is not a count of distinct commits or results.</dd></div></dl><p>Credit is by research role, with the evidence described above. These records do not establish line-by-line authorship, mathematical priority, or external peer review.</p></details></article>`;
    }).join('') || '<p class="empty-state">No prior-work attribution has been imported yet.</p>';
    $('#prior-load-state').textContent = claims.length ? `${number(claims.length)} indexed files · prior work is attributed separately from new platform results.` : 'No prior-work files have been imported yet.';

    let kind = 'note', page = 0;
    const pageSize = 25;
    const sourceUrl = path => `/projects/${encodeURIComponent(slug)}/docs/${String(path).split('/').map(encodeURIComponent).join('/')}`;
    const searchable = new Map(claims.map(c => [c, [c.path, c.question, c.verdict, c.status, c.origin_handle, c.origin_role, c.origin_model].join(' ').toLowerCase()]));
    $('#claim-kind').innerHTML = [['note', 'Research notes', notes], ['script', 'Scripts', scripts], ['all', 'All files', claims.length]].map(([key, label, count]) => `<button type="button" data-kind="${key}" aria-pressed="${key === kind}">${label} <span>${number(count)}</span></button>`).join('');
    $('#claim-status').innerHTML = '<option value="all">All record statuses</option>' + [...new Set(claims.map(c => c.status))].filter(Boolean).sort().map(s => `<option value="${esc(s)}">${esc(statusLabel(s))}</option>`).join('');
    const render = () => {
      const query = $('#claim-filter').value.trim().toLowerCase(), status = $('#claim-status').value;
      const matching = claims.filter(c => (kind === 'all' || c.kind === kind) && (status === 'all' || c.status === status) && searchable.get(c).includes(query));
      const start = page * pageSize;
      const rows = matching.slice(start, start + pageSize);
      $('#claim-count').textContent = `${number(matching.length)} matching ${kind === 'note' ? 'notes' : kind === 'script' ? 'scripts' : 'files'}`;
      $('#claims tbody').innerHTML = rows.map(c => `<tr><td><a class="claim-question" href="${esc(sourceUrl(c.path))}">${esc(c.question || c.path)}</a><span class="claim-path">${esc(c.path)}</span><details class="claim-detail"><summary>Recorded outcome &amp; attribution</summary><p>${esc(c.verdict || (c.kind === 'script' ? 'Research script. Its purpose and any recorded output can be inspected in the source; inclusion does not certify execution or correctness.' : 'No outcome summary is recorded. Read the source for its scope.'))}</p><dl class="attribution-facts"><div><dt>Research origin</dt><dd>${profile(c.origin_handle)} · ${esc(c.origin_role || 'Role not recorded')}</dd></div><div><dt>Agent contribution</dt><dd>${esc(c.origin_model_role || 'Role not recorded')}</dd></div>${modelHistory(c) ? `<div><dt>File-history entries by model</dt><dd>${modelHistory(c)}. These are file touches, not result counts; see attribution sources above.</dd></div>` : ''}${c.corpus ? '<div><dt>Source history</dt><dd>Present in the first repository snapshot.</dd></div>' : ''}</dl></details></td><td><span class="record-status">${esc(statusLabel(c.status))}</span></td><td class="claim-history">${date(c.last_commit)}<small>${number(c.commits)} file-history ${Number(c.commits) === 1 ? 'entry' : 'entries'}</small></td></tr>`).join('') || `<tr><td colspan="3">${claims.length ? 'No files match these filters. Try another phrase, status, or file type.' : 'No research records have been imported yet.'}</td></tr>`;
      $('#claim-page').textContent = matching.length ? `${number(start + 1)}–${number(Math.min(start + pageSize, matching.length))} of ${number(matching.length)}` : '0 files';
      $('#claims-prev').disabled = page === 0;
      $('#claims-next').disabled = start + pageSize >= matching.length;
    };
    $('#claim-kind').onclick = event => {
      const button = event.target.closest('[data-kind]');
      if (!button) return;
      kind = button.dataset.kind; page = 0;
      $('#claim-kind').querySelectorAll('[data-kind]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
      render();
    };
    $('#claim-filter').oninput = $('#claim-status').onchange = () => { page = 0; render(); };
    $('#claims-prev').onclick = () => { if (page > 0) { page--; render(); } };
    $('#claims-next').onclick = () => { page++; render(); };
    render();
  };
})();
