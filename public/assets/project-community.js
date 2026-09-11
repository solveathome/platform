/* Contributor leaderboard with period filters and personal progress. */
(function () {
  SA.createProjectCommunity = function ({base, getMe}) {
    const $ = s => document.querySelector(s), C = SA.community, esc = SA.esc;
    let period = '7d', kind = 'people', visible = 10, request = 0, current = null;
    const periodLabel = w => w === 'all' ? 'All time' : `Last ${w === '7d' ? '7' : '30'} days`;
    const query = (w, limit) => `${base}/standings?window=${w}&limit=${limit}${getMe()?.signed_in ? `&me=${encodeURIComponent(getMe().handle)}` : ''}`;
    function render() {
      if (!current) return;
      const st = current, model = kind === 'agents', list = st[kind] || [], total = Number(st[`${kind}_total`]);
      $('#st-podium').innerHTML = C.podium(list, {model, me: getMe()});
      const openDetails = new Set([...$('#st-ranking').querySelectorAll('details[open]')].map(el => el.closest('li')?.querySelector('.community-rank')?.textContent));
      $('#st-ranking').innerHTML = C.rows(list, {model, me: getMe(), limit: visible, detailed: true});
      $('#st-ranking').querySelectorAll('details').forEach(el => { el.open = openDetails.has(el.closest('li')?.querySelector('.community-rank')?.textContent); });
      $('#st-list-title').textContent = `${visible === 10 ? 'Top 10' : `Top ${Math.min(visible, total)}`} ${model ? 'AI models' : 'contributors'} · ${periodLabel(st.window).toLowerCase()}`;
      $('#st-expand').hidden = total <= 10;
      $('#st-expand').textContent = visible >= Math.min(500, total) ? 'Show top 10' : `Show more (${Math.min(visible, list.length)} of ${total})`;
      $('#st-progress').innerHTML = C.progress(st.me, getMe(), base);
      const mine = st.me && st.me.rank && Number(st.me.rank) > Math.min(visible, list.length);
      $('#st-my-rank').innerHTML = !model && mine ? `<div class="community-list-heading"><h3>Your position</h3></div><ol class="community-rows">${C.rows([st.me], {me: getMe()})}</ol>` : '';
    }
    function details(st) {
      const t = st.totals;
      $('#st-totals').innerHTML = C.metrics(t);
      const kinds = {result: 'Accepted work', breakthrough: 'Breakthrough credit', integrated: 'Integrated revisions', insight: 'Cited insights', direction: 'Research directions', review: 'Reviews that held', compute: 'Compute donated', tokens: 'Tokens donated'};
      $('#st-leaders').innerHTML = Object.entries(st.leaders || {}).filter(([,r]) => r && Number(r.points) > 0).map(([k,r]) => `<li><span>${esc(kinds[k] || k)}</span><a href="/@${encodeURIComponent(r.handle)}">@${esc(r.handle)}</a><b>${C.points(r.points)} pts</b></li>`).join('') || '<li class="community-empty">Recognition follows the first awarded contribution.</li>';
      $('#st-recent').innerHTML = (st.recent || []).slice(0, 6).map(r => `<li><a class="result-id" href="${base}/return/${Number(r.id)}">#${Number(r.id)}</a><span class="result-what">${esc(r.type)} by <a href="/@${encodeURIComponent(r.handle)}">@${esc(r.handle)}</a></span><span class="result-state">${esc(C.resultStatus(r))}</span><span class="result-when">${esc(SA.ago(r.created_at))}</span></li>`).join('') || '<li class="community-empty">No results in this period yet.</li>';
    }
    async function refresh() {
      const version = ++request, selected = period;
      $('#highscores').setAttribute('aria-busy', 'true');
      const main = SA.json(query(selected, Math.max(10, visible)));
      try {
        const st = await main;
        if (version !== request) return;
        current = st;
        $('#hs-window').textContent = `${periodLabel(st.window)} · ${SA.number(st.people_total)} contributors · updated ${new Date(st.as_of).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
        $('#standings-retry').hidden = true;
        document.querySelectorAll('[data-community-window]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.communityWindow === st.window)));
        details(st); render();
      } catch {
        if (version !== request) return;
        $('#hs-window').textContent = current ? `${periodLabel(current.window)} · showing the last successful update. Could not load ${periodLabel(selected).toLowerCase()}.` : 'Standings are temporarily unavailable.';
        if (!current) { $('#st-ranking').innerHTML = '<li class="community-empty">Please try again. You can still explore the project and contribute.</li>'; $('#st-progress').innerHTML = C.progress(null, getMe(), base); }
        $('#standings-retry').hidden = false;
      } finally {
        if (version === request) $('#highscores').removeAttribute('aria-busy');
      }
    }
    document.querySelectorAll('[data-community-window]').forEach(b => { b.onclick = () => { period = b.dataset.communityWindow; visible = 10; refresh(); }; });
    document.querySelectorAll('[data-community-kind]').forEach(b => { b.onclick = () => { kind = b.dataset.communityKind; visible = 10; document.querySelectorAll('[data-community-kind]').forEach(el => el.setAttribute('aria-pressed', String(el === b))); render(); }; });
    $('#st-expand').onclick = () => { const total = Number(current?.[`${kind}_total`] || 0); visible = visible >= Math.min(500, total) ? 10 : Math.min(500, visible + 50); if (visible > (current?.[kind]?.length || 0)) refresh(); else render(); };
    $('#standings-retry').onclick = () => refresh();
    return {refresh};
  };
})();
