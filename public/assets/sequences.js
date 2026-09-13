/* The proposal list follows the same research-document presentation as Papers. */
(() => {
  const {esc} = SA;
  function row(sequence, full = false) {
    return `<li><a class="paper-title" href="${esc(sequence.url)}">${esc(sequence.title)}</a><span class="paper-status">${esc(sequence.status_label)}</span>
      <p class="paper-summary-line">${esc(sequence.definition)}</p>
      ${sequence.terms.length ? `<p class="paper-summary-line"><b>Initial terms:</b> <code>${sequence.terms.slice(0, 20).map(esc).join(', ')}${sequence.terms.length > 20 ? ', …' : ''}</code></p>` : ''}
      <span class="paper-facts">${sequence.terms.length ? `${sequence.terms.length} terms in the draft${sequence.offset !== null ? ` · offset ${esc(sequence.offset)}` : ''} · ` : ''}<a href="${esc(sequence.url)}">Read the proposal →</a>${full ? ` · <a href="${esc(sequence.history_url)}">Revision history</a>` : ''}</span>
      ${full && sequence.status_note ? `<p class="paper-summary-line">${esc(sequence.status_note)}</p>` : ''}</li>`;
  }
  SA.createSequences = ({base, front, active, retired, retiredPanel, retry}) => {
    function render(sequences) {
      const candidates = sequences.filter(s => s.status !== 'retired');
      const archive = sequences.filter(s => s.status === 'retired');
      const empty = '<li class="muted">No active sequence proposals yet.</li>';
      front.innerHTML = candidates.slice(0, 6).map(s => row(s)).join('') || empty;
      active.innerHTML = candidates.map(s => row(s, true)).join('') || empty;
      retired.innerHTML = archive.map(s => row(s, true)).join('');
      retiredPanel.hidden = archive.length === 0;
      retry.hidden = true;
    }
    async function refresh() {
      retry.disabled = true;
      try {
        const data = await SA.json(`${base}/sequences`, {signal: AbortSignal.timeout(12000)});
        render(data.sequences ?? []);
      } catch {
        for (const list of [front, active]) list.innerHTML = '<li class="muted">Sequence proposals are temporarily unavailable. Try again from the Proposed OEIS sequences section.</li>';
        retiredPanel.hidden = true;
        retry.hidden = false;
      } finally { retry.disabled = false; }
    }
    retry.onclick = refresh;
    return {refresh, render};
  };
})();
