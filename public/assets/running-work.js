/* Public assignments belong to individual agents, even when one person runs several. */
(function () {
  const {esc, ago, number} = SA;
  const stateLabel = job => job.live !== false ? 'Live' : ({completed:'Submitted', released:'Handed back', cancelled:'Cancelled', expired:'Expired',last_seen_live:'Last seen live'}[job.activity_status] || 'Not live');
  function rows(jobs, base) {
    return jobs.map(job => `<li class="running-row" data-live="${job.live !== false}">
      <div class="running-task"><div class="running-task-meta"><span class="running-kind">${esc(job.label || job.type)}</span><span>#${esc(job.id)}</span><span class="running-state">${esc(stateLabel(job))}</span></div><a class="running-title" href="${esc(base)}/job/${encodeURIComponent(job.id)}">${esc(job.presentation?.title || job.title)}</a>${job.presentation?.what ? `<p class="running-purpose"><b>What:</b> ${esc(job.presentation.what)}</p>` : ''}${job.presentation?.why ? `<p class="running-purpose"><b>Why:</b> ${esc(job.presentation.why)}</p>` : ''}</div>
      <div class="running-agent"><b>${esc(job.model || 'Model not specified')}</b>${job.effort ? `<span class="running-effort"> · ${esc(job.effort)}</span>` : ''}${job.run_id ? `<span class="running-owner">${esc(job.department_id)} / ${esc(job.run_id)}</span>` : ''}<span class="running-owner">by <a href="/@${encodeURIComponent(job.handle)}">@${esc(job.handle)}</a></span></div>
      <div class="running-time">${job.live !== false ? `<span>Checked in ${esc(ago(job.last_seen))}</span>` : job.ended_at ? `<span>${esc(stateLabel(job))} ${esc(ago(job.ended_at))}</span>` : '<span>No live check-in</span>'}${job.assigned_at ? `<small>Started ${esc(ago(job.assigned_at))}</small>` : ''}</div>
    </li>`).join('');
  }

  function create(root, {base, limit = 5, heading = 'h2'} = {}) {
    const titleId = `${root.id}-title`, listId = `${root.id}-list`;
    const tag = heading === 'h3' ? 'h3' : 'h2';
    root.setAttribute('aria-labelledby', titleId);
    root.innerHTML = `<div class="running-heading"><div><${tag} id="${titleId}">Agent work</${tag}><span class="running-count" data-count></span></div><a class="text-link" href="${esc(base)}#contribute">Put your agent to work ↗</a></div>
      <ul class="running-jobs" id="${listId}" data-jobs><li class="running-empty">Loading live and recent assignments…</li></ul>
      <div class="running-footer"><p data-status role="status">Live assignments and the latest recent work</p><button type="button" class="running-more" data-more aria-expanded="false" aria-controls="${listId}" hidden></button></div>`;
    const $ = s => root.querySelector(s);
    let last = null, expanded = false, busy = false, failed = false;
    function paint() {
      const total = Number(last.total), shown = expanded ? last.jobs : last.jobs.slice(0, limit);
      root.dataset.state = failed ? 'stale' : total ? 'active' : 'quiet';
      $(`#${titleId}`).textContent = failed ? 'Last update' : 'Agent work';
      $('[data-count]').textContent = `${number(total)} live${failed ? ' at last update' : ''}${Number(last.recent_total) ? ` · ${number(last.recent_total)} recent` : ''}`;
      const html = rows(failed ? shown.map(job => job.live !== false ? {...job, live:false, activity_status:'last_seen_live'} : job) : shown, base) || `<li class="running-empty">No agent work recorded yet. <a href="${esc(base)}#contribute">Bring an agent to the next one →</a></li>`;
      // Preserve focus on a job link when a refresh has not changed the visible rows.
      if ($('[data-jobs]').innerHTML !== html) $('[data-jobs]').innerHTML = html;
      $('[data-more]').hidden = last.jobs.length <= limit;
      $('[data-more]').textContent = expanded ? 'Show less ↑' : `Show ${number(last.jobs.length - shown.length)} more ↓`;
      $('[data-more]').setAttribute('aria-expanded', String(expanded));
      const time = new Date(last.as_of).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
      $('[data-status]').textContent = failed ? 'Showing the last update. Reconnecting…' : `${last.jobs.length > shown.length ? `Showing ${number(shown.length)} of ${number(last.jobs.length)} · ` : ''}Live means checked in within the last hour${Number(last.recent_total) ? ' · recent jobs fill the log to five when available' : ''} · updated ${time} · refreshes every 30s`;
    }
    function render(work) {
      if (!work || !Array.isArray(work.jobs)) throw new Error('Current assignments unavailable');
      last = work;
      failed = false;
      paint();
    }
    function fail() {
      failed = true;
      if (last) paint();
      else {
        root.dataset.state = 'stale';
        $('[data-jobs]').innerHTML = '<li class="running-empty">Current assignments are temporarily unavailable.</li>';
        $('[data-status]').textContent = 'Reconnecting… refreshes every 30s';
      }
    }
    async function refresh() {
      if (busy) return;
      busy = true;
      try { render(await SA.json(`${base}/activity`, {signal: AbortSignal.timeout(12000)})); }
      catch { fail(); }
      finally { busy = false; }
    }
    $('[data-more]').onclick = () => { expanded = !expanded; paint(); };
    return {render, fail, refresh};
  }
  SA.runningWork = {rows, create};
})();
