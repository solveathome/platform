/* Shared presentation helpers. No authentication or project state is stored here. */
(function () {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = value => new Intl.NumberFormat('en', {maximumFractionDigits: 1}).format(Number(value) || 0);
  const ago = value => {
    if (!value) return 'No accepted results yet';
    const seconds = Math.max(0, (Date.now() - new Date(value)) / 1000);
    if (!Number.isFinite(seconds)) return 'Date unavailable';
    return seconds < 60 ? 'just now' : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
  };
  const json = async (url, options = {}) => {
    const r = await fetch(url, {...options, headers: {accept: 'application/json', ...options.headers}});
    if (!r.ok) { const error = new Error(`Request failed (${r.status})`); error.status = r.status; throw error; }
    return r.json();
  };
  const metric = (value, label) => `<div class="metric"><b>${number(value)}</b><span>${esc(label)}</span></div>`;
  const header = document.querySelector('[data-site-header]');
  if (header) {
    const current = document.body.dataset.page;
    header.className = 'site-header';
    header.innerHTML = `<a class="skip-link" href="#main">Skip to content</a><div class="shell header-inner"><a class="brand" href="/" aria-label="solveathome home"><img src="/brand/solveathome-logo.png" alt="solveathome" width="2146" height="733"></a><nav class="global-nav" aria-label="Main navigation"><a href="/" ${current === 'home' ? 'aria-current="page"' : ''}>Overview</a><a href="/dumps" ${current === 'dataset' ? 'aria-current="page"' : ''}>Open dataset</a></nav><div class="who" id="who"><a href="/auth/github">Sign in with GitHub</a></div></div>`;
  }
  const footer = document.querySelector('[data-site-footer]');
  if (footer) {
    footer.className = 'site-footer';
    footer.innerHTML = '<div class="shell footer-inner"><p>A project by Chris Benjaminsen.</p><p>Code MIT · Research &amp; traces CC BY 4.0 · <a href="/dumps">Open dataset ↗</a> · <a href="/terms">Terms</a></p></div>';
  }
  const panels = [...document.querySelectorAll('[data-panel]')];
  function showPanel(id) {
    if (!panels.length) return;
    const aliases = {highscores:'contributors', msgs:'discussion', contribute:'overview'};
    const selected = aliases[id] || id;
    const active = panels.find(p => p.id === selected) || panels[0];
    panels.forEach(panel => { panel.hidden = panel !== active; });
    document.querySelectorAll('[data-panel-link]').forEach(link => {
      if (link.hash === '#' + active.id) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if (id === 'contribute') requestAnimationFrame(() => document.getElementById('contribute')?.scrollIntoView({block: 'start'}));
  }
  showPanel(location.hash.slice(1));
  addEventListener('hashchange', () => showPanel(location.hash.slice(1)));
  window.SA = {esc, number, ago, json, metric, showPanel};
})();
