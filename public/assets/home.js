(function () {
  const root = document.querySelector('[data-community-project]');
  if (!root) return;
  const base = `/projects/${encodeURIComponent(root.dataset.communityProject)}`;
  const $ = s => root.querySelector(s);
  const C = SA.community;
  let me = null, busy = false, last = null;
  const identity = loadWho(document.querySelector('#who')).then(user => { me = user; if (last) render(last); });
  function render(st) {
    last = st;
    const people = st.active_people || st.people;
    $('#home-podium').innerHTML = C.podium(people, {me});
    $('#home-leaders').innerHTML = C.rows(people, {me});
    const person = st.me || st.people.find(p => me?.signed_in && p.handle.toLowerCase() === me.handle.toLowerCase());
    $('#home-progress').innerHTML = C.progress(person, me, base);
    $('#home-updated').textContent = `Updated ${new Date(st.as_of).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})} · refreshes every minute`;
    $('#home-community-state').textContent = `${SA.number(st.active_people_total ?? st.people_total)} contributors active in the last 7 days`;
  }
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      await identity;
      const [all, weekly] = await Promise.allSettled([
        SA.json(`${base}/standings?window=all&limit=10`),
        SA.json(`${base}/standings?window=7d&limit=10${me?.signed_in ? `&me=${encodeURIComponent(me.handle)}` : ''}`)
      ]);
      if (all.status === 'fulfilled') {
        $('#home-stats').innerHTML = C.metrics(all.value.totals);
        $('#home-stats-state').textContent = `All time · updated ${new Date(all.value.as_of).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})} · refreshes every minute`;
      } else $('#home-stats-state').textContent = 'Contribution totals are temporarily unavailable. Retrying in a minute.';
      if (weekly.status === 'fulfilled') render(weekly.value);
      else throw new Error('Standings unavailable');
      $('#home-retry').hidden = true;
    } catch {
      $('#home-updated').textContent = last ? 'Showing the last update. Could not refresh standings.' : 'Standings are temporarily unavailable.';
      if (!last) { $('#home-leaders').innerHTML = '<li class="community-empty">The community will be back shortly. You can still explore the project.</li>'; $('#home-progress').innerHTML = C.progress(null, me, base); }
      $('#home-retry').hidden = false;
    } finally { busy = false; }
  }
  $('#home-retry').onclick = refresh;
  refresh();
  const timer = setInterval(() => { if (!document.hidden) refresh(); }, 60000);
  addEventListener('pagehide', () => clearInterval(timer));
})();
