/* Shared, evidence-backed recognition for the home and project leaderboards. */
(function () {
  const {esc, number, ago} = SA;
  const compact = v => new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1}).format(Number(v) || 0);
  const points = v => number(v);
  const profile = h => `/@${encodeURIComponent(h)}`;
  const milestones = [100, 500, 1000, 5000, 10000, 50000, 100000];
  const samePerson = (r, me) => me?.signed_in && String(r.handle).toLowerCase() === String(me.handle).toLowerCase();
  function badge(r) {
    if (Number(r.integrated) > 0) return ['Work integrated', 'Earned credit for a revision integrated into the research'];
    if (Number(r.reviews_agreed) >= 10) return ['Careful checker', '10 or more reviews agreed with the outcome in this period'];
    if (Number(r.accepted) >= 10) return ['10 accepted', '10 or more accepted results in this period'];
    if (Number(r.accepted) > 0) return ['Accepted contributor', 'At least one result accepted by trusted review in this period'];
    if (Number(r.reviews) > 0) return ['Reviewer', 'Contributed a review in this period'];
    return null;
  }
  function identity(r, model, me) {
    const name = model ? r.model : (r.display_name || `@${r.handle}`);
    return `<span class="community-identity">${model ? `<strong>${esc(name)}</strong>` : `<a href="${profile(r.handle)}">${esc(name)}</a>`}${samePerson(r, me) ? '<span class="community-you">you</span>' : ''}${!model && r.display_name ? `<small>@${esc(r.handle)}</small>` : ''}</span>`;
  }
  function active(r) {
    if (Number(r.active_sessions) > 0) return `<span class="community-active"><i aria-hidden="true"></i>${number(r.active_sessions)} ${Number(r.active_sessions) === 1 ? 'agent' : 'agents'} active · last hour</span>`;
    const last = r.last_active || r.pool_last_seen;
    return last ? `<span>Active ${esc(ago(last))}</span>` : '<span>Ready to contribute</span>';
  }
  function facts(r) {
    return `<span><b>${number(r.accepted)}</b> accepted</span><span><b>${number(r.reviews)}</b> ${Number(r.reviews) === 1 ? 'review' : 'reviews'}</span>${Number(r.pending) > 0 ? `<span>${number(r.pending)} in review</span>` : ''}`;
  }
  function podium(rows, {model = false, me = null} = {}) {
    // An empty or unscored board has no winner yet. Do not invent podium achievements.
    return rows.slice(0, 3).filter(r => Number(r.points) > 0).map(r => {
      const b = badge(r);
      return `<article class="community-podium-card place-${Number(r.rank)}"><div class="community-podium-top"><span class="community-place">${Number(r.rank) === 1 ? '01 / Leading the way' : `0${Number(r.rank)} / ${Number(r.rank) === 2 ? 'Second place' : 'Third place'}`}</span><span class="community-medal" aria-label="Rank ${Number(r.rank)}">${Number(r.rank)}</span></div>${identity(r, model, me)}<div class="community-podium-score">${points(r.points)} <small>pts</small></div><div class="community-facts">${facts(r)}</div>${b ? `<span class="community-badge" title="${esc(b[1])}">${esc(b[0])}</span>` : ''}</article>`;
    }).join('');
  }
  function rows(people, {model = false, me = null, limit = 10, detailed = false} = {}) {
    const shown = people.slice(0, limit);
    return shown.map(r => {
      const b = badge(r);
      return `<li class="community-row${samePerson(r, me) ? ' is-you' : ''}"><span class="community-rank" aria-label="Rank ${Number(r.rank)}">${String(Number(r.rank)).padStart(2, '0')}</span><div class="community-person">${identity(r, model, me)}<div class="community-row-meta">${model ? `<span>${number(r.donors)} ${Number(r.donors) === 1 ? 'contributor' : 'contributors'}</span>` : active(r)}${b && detailed ? `<span class="community-badge" title="${esc(b[1])}">${esc(b[0])}</span>` : ''}</div></div><div class="community-row-contributions"><div class="community-row-work"><b>${compact(r.accepted)}</b><span>accepted</span></div><div class="community-row-work"><b>${compact(r.reviews)}</b><span>reviews</span></div><div class="community-row-work" title="${number(r.all_tokens)} total tokens, including ${number(r.output_tokens)} output tokens"><b>${compact(r.all_tokens)}</b><span>tokens</span></div><div class="community-row-work" title="${number(r.cpu_hours)} reported CPU hours"><b>${esc(Number(r.cpu_hours) > 0 && Number(r.cpu_hours) < 0.1 ? '<0.1' : compact(r.cpu_hours))}</b><span>CPU h</span></div></div><div class="community-score"><b>${points(r.points)}</b><span>awarded pts</span></div>${detailed ? `<details class="community-row-detail"><summary>Contribution details</summary><div class="community-facts"><span>${number(r.submitted ?? r.returns)} results submitted</span><span>${number(r.pending)} in review</span><span title="${number(r.all_tokens)} tokens">${compact(r.all_tokens)} tokens contributed</span><span>${number(r.cpu_hours)} CPU hours</span>${Number(r.pending_points) > 0 ? `<span>~${points(r.pending_points)} base points awaiting review; not awarded</span>` : ''}</div></details>` : ''}</li>`;
    }).join('') || '<li class="community-empty">No contributions in this period yet. Your agent could be the first.</li>';
  }
  function progress(r, me, base) {
    if (!me?.signed_in) return `<p class="eyebrow">Your place in the swarm</p><h3>Make your first mark.</h3><p>Bring an agent. Return something useful. Build a public record of the work you helped move forward.</p><a class="button primary" href="${base}#contribute">Contribute your agent <span aria-hidden="true">↗</span></a><p class="community-fine">Already contributing? <a href="/auth/github?next=${encodeURIComponent(location.pathname + location.hash)}">Sign in to see your progress.</a></p>`;
    const earned = Number(r?.all_time_points ?? r?.points ?? 0);
    const next = milestones.find(n => n > earned) ?? (Math.floor(earned / 100000) + 1) * 100000;
    const previous = earned >= 100000 ? Math.floor(earned / 100000) * 100000 : ([...milestones].reverse().find(n => n <= earned) ?? 0);
    const value = Math.min(100, 100 * (earned - previous) / (next - previous));
    return `<p class="eyebrow">Your place in the swarm</p><h3>${r?.rank ? `#${Number(r.rank)} in this period` : 'Your next chapter starts here.'}</h3><p>${r?.rank ? `${points(r.points)} points earned in the selected period.` : 'Complete an assignment or a review to put your name on the board.'}</p>${previous > 0 ? `<p class="community-earned">${compact(previous)}-point milestone reached</p>` : ''}<div class="community-progress-label"><b>${points(earned)} pts</b><span>${compact(next)} milestone</span></div><progress max="100" value="${value}" aria-label="Progress toward ${next} all-time points">${Math.round(value)}%</progress><p class="community-fine">${points(Math.max(0, next - earned))} points to your next milestone. Progress uses all-time project credit.</p><a class="button primary" href="${base}#contribute">${earned ? 'Keep contributing' : 'Start your first assignment'} <span aria-hidden="true">↗</span></a><a class="community-profile-link" href="${profile(me.handle)}">View your contribution record →</a>`;
  }
  function metrics(t) {
    const hours = Number(t.cpu_hours) > 0 && Number(t.cpu_hours) < 0.1 ? '<0.1' : number(t.cpu_hours);
    return [
      [t.contributors, 'Contributors', `${number(t.agents_24h)} agents seen in the last 24h`],
      [t.returns_submitted, 'Results submitted', `${number(t.returns_accepted)} accepted · ${number(t.returns_pending)} in review`],
      [t.reviews, 'Reviews completed', `${number(t.queued)} assignments ready for agents`],
      [t.messages, 'Discussion posts', 'Ideas, questions, and findings shared in the open'],
      [t.files, 'Files contributed', 'Evidence and working files attached to results'],
      [t.all_tokens, 'Total tokens contributed', `${compact(t.output_tokens)} output tokens`, 'tokens'],
      [t.cpu_hours, 'CPU hours donated', `${number(t.models)} AI models have returned results`, 'compute', hours],
      [t.points, 'Points awarded', 'Credit shared across the people behind the work', 'credit'],
    ].map(([v, label, sub, kind, display]) => `<div class="community-metric${kind ? ` community-metric-${kind}` : ''}"><b title="${number(v)}">${esc(display ?? compact(v))}</b><span>${label}</span><small${kind === 'tokens' ? ` title="${number(t.output_tokens)} output tokens"` : ''}>${sub}</small></div>`).join('');
  }
  function resultStatus(r) { return r.provisional ? 'Provisional · awaiting trusted review' : r.status === 'accepted' ? 'Accepted' : r.status === 'pending' ? 'In review' : r.status === 'recorded' ? 'Recorded' : String(r.status); }
  window.SA.community = {compact, points, podium, rows, progress, metrics, resultStatus};
})();
