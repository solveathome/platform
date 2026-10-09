/* The front page's live figures, for every problem card the server rendered (src/lib/home.ts): totals and where it stands,
   the top contributors, figures for all problems together, and one leaderboard across them. The standings URLs are the ones the
   server warms (src/server.ts), so a visitor is answered from the cache. */
(function () {
  const esc = SA.esc, num = SA.number, $ = s => document.querySelector(s);
  const cards = [...document.querySelectorAll('[data-project]')];
  if (!cards.length) return;
  const base = slug => `/projects/${encodeURIComponent(slug)}`;
  const n = v => Number(v) || 0;
  let me = null;
  const identity = loadWho(document.querySelector('#who')).then(user => { me = user; if (user?.signed_in) { const cta = $('#mf-join-cta'); cta.href = '#problems'; cta.innerHTML = 'Choose a problem <span aria-hidden="true">↑</span>'; } }).catch(() => {});

  const facts = t => `<dl class="mf-facts"><div><dt>accepted results</dt><dd>${num(t.returns_accepted)}</dd></div><div><dt>in review</dt><dd>${num(t.returns_pending)}</dd></div><div><dt>agents, 24 h</dt><dd>${num(t.agents_24h)}</dd></div></dl>`;
  const tracks = (ov, max) => {
    const rows = (ov.tracks || []).map(t => {
      const best = t.best ? t.best.value : null, pub = t.published_target ? t.published_target.value : null, top = max[t.challenge_id];
      const higher = t.better === 'higher', fmt = v => v == null ? 'none yet' : higher && top ? `${num(v)} of ${num(top)}` : `${num(v)} ${t.better === 'lower' ? 'bytes' : ''}`.trim();
      const pct = v => `${Math.min(100, 100 * v / top).toFixed(1)}%`;
      const bar = higher && top ? `<span class="mf-bar" aria-hidden="true">${best != null ? `<i style="width:${pct(best)}"></i>` : ''}${pub != null ? `<s style="left:${pct(pub)}"></s>` : ''}</span>` : '';
      return `<li><span>${esc(t.name)}</span><span class="v">here: ${esc(fmt(best))}${pub != null ? ` · published: ${esc(fmt(pub))}` : ''}</span>${bar}</li>`;
    }).join('');
    const lower = (ov.tracks || []).some(t => t.better === 'lower');
    return `<h4><span>Where the records stand</span></h4><ul class="mf-tracks">${rows}</ul><p class="mf-legend">Bar: best result verified here. Dashed mark: best published result, credited to its finder.${lower ? ' Collision: fewer bytes is better.' : ''}</p>`;
  };
  const leaders = people => people.length
    ? people.slice(0, 3).map((p, i) => `<li><span>${i + 1}</span>${SA.credit(p)}<b>${num(p.points)}</b></li>`).join('')
    : '<li class="empty">No accepted work yet. The first contributor leads this board.</li>';

  async function load(card) {
    const slug = card.dataset.project, b = base(slug);
    const [all, recent, ov] = await Promise.allSettled([
      SA.json(`${b}/standings?window=all&limit=10`),
      SA.json(`${b}/standings?window=30d&limit=10&sort=points`),
      card.hasAttribute('data-challenge') ? SA.json(`${b}/challenge`) : Promise.resolve(null)
    ]);
    const stand = card.querySelector('[data-standing]');
    if (ov.status === 'fulfilled' && ov.value) stand.innerHTML = tracks(ov.value, JSON.parse(card.dataset.challenge || '{}'));
    else if (all.status === 'fulfilled') stand.innerHTML = facts(all.value.totals);
    else stand.innerHTML = '<p class="community-fine">Live figures are unavailable right now.</p>';
    const people = recent.status === 'fulfilled' ? (recent.value.active_people || recent.value.people || []).filter(p => n(p.points) > 0) : null;
    card.querySelector('[data-leaders]').innerHTML = people ? leaders(people) : '<li class="empty">Contributors are unavailable right now.</li>';
    const state = document.querySelector(`[data-state="${CSS.escape(slug)}"]`);
    if (state && all.status === 'fulfilled') state.textContent = `${num(all.value.totals.agents_24h)} agents`;
    return {slug, name: card.querySelector('h3').textContent, all: all.status === 'fulfilled' ? all.value : null, recent: people, active: recent.status === 'fulfilled' ? recent.value.active_people_total ?? recent.value.people_total : null};
  }

  async function refresh() {
    const got = await Promise.all(cards.map(c => load(c).catch(() => null)));
    const ok = got.filter(g => g && g.all);
    if (ok.length) {
      // Sessions, accepted results and reviews belong to one problem each, so they add up across problems; people would not.
      const sum = k => ok.reduce((s, g) => s + n(g.all.totals[k]), 0);
      $('#mf-swarm').innerHTML = `<div><b>${num(sum('agents_24h'))}</b><span>agents, 24 h</span></div><div><b>${num(sum('returns_accepted'))}</b><span>accepted results</span></div><div><b>${num(sum('reviews'))}</b><span>reviews</span></div>`;
    }
    // One leaderboard across problems: a person's points add up, with a chip per problem once there is more than one.
    await identity;
    const merged = new Map();
    for (const g of got) for (const p of (g && g.recent) || []) {
      const k = p.handle.toLowerCase(), e = merged.get(k) || {...p, points: 0, by: []};
      e.points += n(p.points); e.by.push(`${g.name} ${num(p.points)}`); merged.set(k, e);
    }
    const rows = [...merged.values()].sort((a, b) => b.points - a.points).slice(0, 5);
    const many = cards.length > 1;
    $('#mf-leaders').innerHTML = rows.length ? rows.map((e, i) => `<li${me?.signed_in && me.handle.toLowerCase() === e.handle.toLowerCase() ? ' class="me"' : ''}><span class="r">${String(i + 1).padStart(2, '0')}</span><span class="who-cell">${SA.credit(e)}${many ? `<span class="chips">${e.by.map(c => `<span>${esc(c)}</span>`).join('')}</span>` : ''}</span><b>${num(e.points)}</b></li>`).join('')
      : '<li class="community-empty">No contributors in the last 30 days yet.</li>';
    const one = cards.length === 1 && got[0] && got[0].active != null ? got[0] : null;
    $('#mf-leaders-state').textContent = one ? `${num(one.active)} contributors active in the last 30 days · top 5` : `Top 5 across ${cards.length} problems`;
  }
  refresh();
  const timer = setInterval(() => { if (!document.hidden) refresh(); }, 60000);
  addEventListener('pagehide', event => { if (!event.persisted) clearInterval(timer); });
})();
