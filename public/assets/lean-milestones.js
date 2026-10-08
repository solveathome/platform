/* Verdicts are fetched from current uncached paper evidence, never embedded in cached project HTML. */
(function () {
  function create(root, {base, papers = []}) {
    let generation = 0;
    const instance = crypto.randomUUID();
    async function refresh() {
      const current = ++generation;
      root.innerHTML = '';
      root.hidden = true;
      if (document.hidden) return;
      if (!Array.isArray(papers) || !papers.length || papers.length > 100 ||
          papers.some(p => typeof p !== 'string' || !/^[a-z0-9][a-z0-9-]{0,100}$/.test(p))) return;
      try {
        const html = await Promise.all(papers.map(async (paper, i) => {
          const request = `${instance}-${current}-${i}`;
          const result = await SA.json(`${base}/papers/${encodeURIComponent(paper)}?lean_request=${encodeURIComponent(request)}`,
            {cache: 'no-store', signal: AbortSignal.timeout(12000)});
          if (result.lean_milestone_request !== request || typeof result.lean_milestone_html !== 'string')
            throw new Error('Current Lean milestone unavailable');
          return result.lean_milestone_html;
        }));
        if (current !== generation || document.hidden) return;
        root.innerHTML = html.join('');
        root.hidden = !root.innerHTML;
      } catch {
        if (current !== generation || document.hidden) return;
        root.innerHTML = '<p class="panel-note">Lean milestone status could not refresh. No verification badge is shown.</p>';
        root.hidden = false;
      }
    }
    function clear() { ++generation; root.innerHTML = ''; root.hidden = true; }
    return {refresh, clear};
  }
  SA.leanMilestones = {create};
})();
