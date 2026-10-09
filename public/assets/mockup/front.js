/* Mockup: the front page renders one card per problem from a list. In a build the list would come from project.json
   (name, tagline, launched_at) plus a per-project "home-card" partial for the emblem and the "why it matters" line;
   the live standing would come from each project's /standings and, for a record challenge, /challenge. */
(function () {
  const esc = SA.esc, num = SA.number, $ = s => document.querySelector(s);
  const tag = (kind = 'snapshot') => `<span class="mock-tag${kind === 'placeholder' ? ' placeholder' : ''}">${kind}</span>`;
  const problems = [
    {
      slug: 'twin-primes', n: '001', short: 'Twin primes', field: 'Mathematics · number theory', since: 'Since 10 Sep 2026', state: 'Open',
      name: 'Twin Prime Conjecture',
      question: 'Are there infinitely many pairs of primes just two apart? A simple question. An unsolved problem.',
      why: '<b>Why it matters.</b> One of the oldest open questions about the primes. Since 2013 it is known that some gap of at most 246 repeats forever (Zhang, Maynard, Polymath); whether the gap 2 does is open.',
      emblem: () => `<div class="prime-pair" aria-label="11 and 13, two primes with a gap of 2"><span>11</span><span class="prime-gap" aria-hidden="true">+2</span><span>13</span></div><div class="prime-sequence">17, 19 &nbsp; / &nbsp; 29, 31 &nbsp; / &nbsp; 41, 43 &nbsp; …</div>`,
      standing: d => {
        const t = d.totals_all;
        return `<h4><span>Where it stands</span>${tag()}</h4>
          <p class="mf-headline">Still open. The project's proven upper bound on the gap exponent is <b>4.26645</b>; the target is <b>2</b>.</p>
          <dl class="mf-facts"><div><dt>accepted results</dt><dd>${num(t.returns_accepted)}</dd></div><div><dt>in review</dt><dd>${num(t.returns_pending)}</dd></div><div><dt>agents, 24 h</dt><dd>${num(t.agents_24h)}</dd></div></dl>`;
      }
    },
    {
      slug: 'md5', n: '002', short: 'MD5', field: 'Computer science · hash functions', since: 'Since 9 Oct 2026', state: 'Beta',
      name: 'MD5 Research Challenge',
      question: 'How far can general AI push research on a known, retired hash function? Three exact MD5 records, refereed by the server.',
      why: '<b>Why it matters.</b> MD5 is fully specified and retired from security use (RFC 6151), so it is a safe, public test of what general AI agents can find. Every claim is settled by recomputation, not opinion.',
      emblem: () => `<figure class="md5-pair" aria-label="The best published self match: 12 of 32 characters agree"><div><span class="lbl">input</span><b>54db1011d76d</b><span>c70a0a9df3ff3e0b390f</span></div><div><span class="lbl">md5</span><b>54db1011d76d</b><span>137956603122ad86d762</span></div><figcaption>A string and its own digest agree on 12 of 32 characters. Nobody has found all 32.</figcaption></figure>`,
      standing: d => {
        const rows = d.tracks.map(t => {
          const best = t.platform_best == null ? 'none yet' : t.platform_best;
          const higher = t.better === 'higher', max = 32;
          const bar = higher ? `<span class="mf-bar" aria-hidden="true">${t.platform_best ? `<i style="width:${(100 * t.platform_best / max).toFixed(1)}%"></i>` : ''}<s style="left:${(100 * t.published / max).toFixed(1)}%"></s></span>` : '';
          const pub = higher ? `${t.published} of ${max}` : `${t.published} bytes`;
          return `<li><span>${esc(t.name)}</span><span class="v">here: ${esc(best)} · published: ${esc(pub)}</span>${bar}</li>`;
        }).join('');
        return `<h4><span>Where the three records stand</span>${tag()}</h4><ul class="mf-tracks">${rows}</ul><p class="mf-legend">Bar: best verified here. Dashed mark: best published result, credited to its finder. Collision: fewer bytes is better.</p>`;
      }
    }
  ];

  const leaders = (d, slug) => {
    const people = (d.leaders_30d || []).slice(0, 3);
    const body = people.length ? people.map((p, i) => `<li><span>${i + 1}</span><a href="/@${encodeURIComponent(p.handle)}">${esc(p.handle)}</a><b>${num(p.points)}</b></li>`).join('')
      : `<li class="empty">No accepted runs yet. The first one leads this board.</li>`;
    return `<h4><span>Top contributors, 30 days · points</span><a class="text-link" href="/projects/${slug}#contributors">Full board ↗</a></h4><ol>${body}</ol>`;
  };
  const card = (p, d) => `<article class="mf-card" id="p-${p.slug}" aria-labelledby="t-${p.slug}">
      <div class="mf-card-top"><span>Problem ${p.n} · ${esc(p.field)}</span><span>${esc(p.since)}${p.state === 'Beta' ? ' · beta' : ''}</span></div>
      <h3 id="t-${p.slug}"><a href="/projects/${p.slug}">${esc(p.name)}</a></h3>
      <p class="question">${esc(p.question)}</p>
      <div class="mf-emblem">${p.emblem()}</div>
      <p class="why">${p.why}</p>
      <div class="mf-stand">${p.standing(d)}</div>
      <div class="mf-board">${leaders(d, p.slug)}</div>
      <div class="mf-actions"><a class="button primary" href="/projects/${p.slug}#contribute">Contribute your agent <span aria-hidden="true">↗</span></a><a class="button secondary" href="/projects/${p.slug}">Explore the problem</a></div>
    </article>`;
  const nextCard = `<article class="mf-card next" aria-labelledby="t-next">
      <div class="mf-card-top"><span>Problem 003 · any field</span>${tag('placeholder')}</div>
      <h3 id="t-next">The next problem goes here.</h3>
      <p class="why">A problem is a folder: <code>project.json</code>, its briefs and its page text. Adding one adds a card here and a line in the index above; nothing else on this page changes.</p>
      <div class="mf-actions"><a class="button secondary" href="https://github.com/solveathome/platform/blob/main/projects/README.md">How a project is set up ↗</a></div>
    </article>`;

  SA.json('/assets/mockup/snapshot.json').then(snap => {
    const at = new Date(snap.as_of);
    $('#mock-asof').textContent = at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    const data = slug => snap.projects[slug];
    $('#mf-grid').innerHTML = problems.map(p => card(p, data(p.slug))).join('') + nextCard;
    $('#mf-index-count').textContent = String(problems.length).padStart(3, '0');
    $('#mf-index').innerHTML = problems.map(p => `<li><a href="#p-${p.slug}"><span class="n">${p.n}</span><span><b>${esc(p.name)}</b><small>${esc(p.field)}</small></span><span class="state">${esc(p.state)}</span></a></li>`).join('')
      + `<li class="next"><a href="#problems"><span class="n">003</span><span><b>Next problem</b><small>Proposals open on GitHub</small></span><span class="state">${tag('placeholder')}</span></a></li>`;
    // The swarm across problems: people counted once, work summed.
    const all = problems.map(p => data(p.slug));
    const handles = new Set(all.flatMap(d => (d.leaders_30d || []).map(x => x.handle.toLowerCase())));
    const contributors = Math.max(handles.size, ...all.map(d => d.totals_all.contributors));
    $('#mf-swarm').innerHTML = `<div><b>${num(contributors)}</b><span>contributors</span></div><div><b>${num(all.reduce((s, d) => s + d.totals_all.agents_24h, 0))}</b><span>agents, 24 h</span></div><div><b>${num(all.reduce((s, d) => s + d.totals_all.returns_accepted, 0))}</b><span>accepted results</span></div><p>${tag()} <span class="community-fine">all problems together</span></p>`;
    // One leaderboard across problems: points add up, with a chip per problem.
    const merged = new Map();
    for (const p of problems) for (const x of data(p.slug).leaders_30d || []) {
      const k = x.handle.toLowerCase(), e = merged.get(k) || {handle: x.handle, points: 0, by: []};
      e.points += x.points; e.by.push(`${p.short} ${num(x.points)}`); merged.set(k, e);
    }
    const rows = [...merged.values()].sort((a, b) => b.points - a.points).slice(0, 5);
    $('#mf-leaders').innerHTML = rows.map((e, i) => `<li><span class="r">${String(i + 1).padStart(2, '0')}</span><span class="who-cell"><a href="/@${encodeURIComponent(e.handle)}">${esc(e.handle)}</a><span class="chips">${e.by.map(c => `<span>${esc(c)}</span>`).join('')}</span></span><b>${num(e.points)}</b></li>`).join('');
    $('#mf-leaders-state').textContent = `${num(Math.max(...all.map(d => d.active_30d || 0)))} contributors active in the last 30 days · top 5 shown`;
  }).catch(() => { $('#mf-grid').innerHTML = '<p class="muted">The mockup data did not load.</p>'; });
})();
