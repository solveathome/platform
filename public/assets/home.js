(function () {
  const root = document.querySelector('[data-community-project]');
  if (!root) return;
  const base = `/projects/${encodeURIComponent(root.dataset.communityProject)}`;
  const $ = s => root.querySelector(s);
  const C = SA.community;
  const running = SA.runningWork.create($('#home-running'), {base});
  running.refresh();
  const activityTimer = setInterval(() => { if (!document.hidden) running.refresh(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) running.refresh(); });
  let me = null, request = 0, last = null, sort = 'points';
  $('#home-sort').innerHTML = C.sortOptions();
  const identity = loadWho(document.querySelector('#who')).then(user => { me = user; if (last) render(last); });
  function render(st) {
    last = st;
    const people = st.active_people || st.people;
    const selectedSort = st.sort || 'points';
    $('#home-sort').value = selectedSort;
    $('#home-podium').innerHTML = C.podium(people, {me, sort: selectedSort});
    $('#home-leaders').innerHTML = C.rows(people, {me, sort: selectedSort});
    const person = st.me ? {...st.me, rank: st.me.active_rank ?? null} : people.find(p => me?.signed_in && p.handle.toLowerCase() === me.handle.toLowerCase());
    $('#home-progress').innerHTML = C.progress(person, me, base, {sort: selectedSort});
    $('#home-updated').textContent = `Ranked by ${C.sortLabel(selectedSort, true)} · updated ${new Date(st.as_of).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})} · refreshes every minute`;
    $('#home-community-state').textContent = `${SA.number(st.active_people_total ?? st.people_total)} contributors active in the last 7 days`;
  }
  async function refresh() {
    const version = ++request, selectedSort = sort;
    $('#home-board').setAttribute('aria-busy', 'true');
    $('#home-updated').textContent = `Loading contributors by ${C.sortLabel(selectedSort, true)}…`;
    try {
      await identity;
      if (version !== request) return;
      const [all, weekly] = await Promise.allSettled([
        SA.json(`${base}/standings?window=all&limit=10`),
        SA.json(`${base}/standings?window=7d&limit=10&sort=${encodeURIComponent(selectedSort)}${me?.signed_in ? `&me=${encodeURIComponent(me.handle)}` : ''}`)
      ]);
      if (version !== request) return;
      if (all.status === 'fulfilled') {
        $('#home-stats').innerHTML = C.metrics(all.value.totals);
        $('#home-stats-state').textContent = `All time · updated ${new Date(all.value.as_of).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})} · refreshes every minute`;
      } else $('#home-stats-state').textContent = 'Contribution totals are temporarily unavailable. Retrying in a minute.';
      if (weekly.status === 'fulfilled') render(weekly.value);
      else throw new Error('Standings unavailable');
      $('#home-retry').hidden = true;
    } catch {
      if (version !== request) return;
      $('#home-updated').textContent = last ? `Showing the last update, ranked by ${C.sortLabel(last.sort, true)}. Could not load contributors by ${C.sortLabel(selectedSort, true)}.` : 'Standings are temporarily unavailable.';
      if (last) $('#home-sort').value = last.sort || 'points';
      if (!last) { $('#home-leaders').innerHTML = '<li class="community-empty">The community will be back shortly. You can still explore the project.</li>'; $('#home-progress').innerHTML = C.progress(null, me, base); }
      $('#home-retry').hidden = false;
    } finally { if (version === request) $('#home-board').removeAttribute('aria-busy'); }
  }
  $('#home-sort').onchange = () => { sort = $('#home-sort').value; refresh(); };
  $('#home-retry').onclick = refresh;
  refresh();
  const timer = setInterval(() => { if (!document.hidden) refresh(); }, 60000);
  addEventListener('pagehide', event => { if (!event.persisted) { clearInterval(timer); clearInterval(activityTimer); } });
})();
