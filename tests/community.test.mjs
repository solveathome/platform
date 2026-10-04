import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';

const context = vm.createContext({Intl, Date, location: {pathname:'/',hash:''}, document: {querySelector:()=>null, querySelectorAll:()=>[]}, addEventListener:()=>{}});
context.window = context;
vm.runInContext(readFileSync(new URL('../public/assets/ui.js', import.meta.url), 'utf8'), context);
vm.runInContext(readFileSync(new URL('../public/assets/community.js', import.meta.url), 'utf8'), context);
vm.runInContext(readFileSync(new URL('../public/assets/running-work.js', import.meta.url), 'utf8'), context);
const C = context.SA.community;

test('pending work cannot create a winner or an acceptance badge; provisional outcomes remain explicit', () => {
  const pending = {handle:'newcomer',rank:1,points:0,pending:5,pending_points:500};
  assert.equal(C.podium([pending]), '');
  const row = C.rows([pending], {detailed:true});
  assert.ok(row.includes('awaiting review; not awarded'));
  assert.ok(!row.includes('Accepted contributor'));
  assert.equal(C.resultStatus({status:'accepted',provisional:true}), 'Provisional · awaiting trusted review');
});

test('identity and model text is escaped and profile links cannot break out of attributes', () => {
  const text = '<img src=x onerror=alert(1)>'; const handle = '\" onclick=\"alert(1)';
  const person = C.rows([{handle,display_name:text,rank:1,points:1}]);
  assert.ok(!person.includes('<img'));
  assert.ok(person.includes('&lt;img'));
  assert.ok(person.includes('/@%22%20onclick%3D%22alert(1)'));
  assert.ok(!C.podium([{model:text,rank:1,points:1}], {model:true}).includes('<img'));
});

test('milestones survive window changes, acknowledge reached thresholds, and support a quiet week', () => {
  const me = {signed_in:true,handle:'someone'};
  const weekly = C.progress({points:0,all_time_points:500,rank:null},me,'/projects/example');
  const all = C.progress({points:500,all_time_points:500,rank:1},me,'/projects/example');
  for (const rendered of [weekly,all]) {
    assert.ok(rendered.includes('500-point milestone reached'));
    assert.ok(rendered.includes('Progress toward 1000 all-time points'));
    assert.ok(rendered.includes('500 points to your next milestone'));
  }
  assert.ok(!weekly.includes('#null'));
  assert.ok(C.progress(null,me,'/projects/example').includes('Progress toward 100 all-time points'));
  assert.ok(C.progress({all_time_points:250000},me,'/projects/example').includes('value="50"'));
  assert.ok(C.progress(null,null,'/projects/example').includes('Contribute your agent'));
});

test('work rankings show the chosen metric on the podium and personal rank while preserving point milestones', () => {
  const r = {handle:'reviewer', rank:1, points:0, reviews:59, accepted:36, all_tokens:683100000, cpu_hours:11.3, pending_points:100, all_time_points:500};
  assert.equal(C.podium([r]), '', 'no points podium without awarded points');
  for (const [sort, value, unit] of [['accepted','36','accepted'], ['reviews','59','reviews'], ['all_tokens','683.1M','tokens'], ['cpu_hours','11.3','CPU h']]) {
    const podium = C.podium([r], {sort});
    assert.ok(podium.includes(`${value} <small>${unit}</small>`), sort);
    assert.ok(!podium.includes('+100 pending'), 'pending points are not added to another metric');
    assert.ok(C.rows([r], {sort}).replace(/ title="[^"]*"/g, '').includes(`is-sorted"><b>${value}</b><span>${unit}</span>`), sort);
    assert.equal(C.podium([{...r, points:100, [sort]:0}], {sort}), '', 'zero activity has no podium');
    const progress = C.progress(r, {signed_in:true,handle:r.handle}, '/projects/example', {sort});
    assert.ok(progress.includes(`#1 by ${C.sortLabel(sort, true)}`));
    assert.ok(progress.includes('Progress toward 1000 all-time points'));
  }
  assert.ok(C.podium([{...r, cpu_hours:0.01}], {sort:'cpu_hours'}).includes('&lt;0.1 <small>CPU h</small>'));
});

test('running assignments safely link the job and its contributor, with per-agent identity', () => {
  const job = {id:123, title:'<img src=x onerror=alert(1)>', type:'" onclick="oops', handle:'" onclick="oops', model:'<script>bad</script>', effort:'<b>max</b>', presentation:{title:'<img src=x>',what:'<script>bad</script>',why:'<iframe>bad</iframe>'}, last_seen:new Date().toISOString()};
  const html = context.SA.runningWork.rows([job, {...job, id:124, model:'another-agent'}], '/projects/example');
  assert.ok(html.includes('/projects/example/job/123'));
  assert.ok(html.includes('/projects/example/job/124'));
  assert.ok(html.includes('/@%22%20onclick%3D%22oops'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img') && !html.includes('<script>') && !html.includes('<b>max</b>'));
  assert.ok(html.includes('another-agent'));
  assert.ok(!html.includes('No accepted results yet'));
});

test('running work expands, handles empty periods, and never labels a failed refresh as live', () => {
  const elements = new Map();
  const root = {id:'running', dataset:{}, setAttribute(){}, querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, {innerHTML:'', textContent:'', attrs:{}, setAttribute(k,v){this.attrs[k]=v;}});
    return elements.get(selector);
  }};
  const ui = context.SA.runningWork.create(root, {base:'/projects/example'});
  const get = selector => root.querySelector(selector);
  ui.fail();
  assert.equal(root.dataset.state, 'stale');
  assert.ok(get('[data-jobs]').innerHTML.includes('temporarily unavailable'));
  const work = {total:7, as_of:new Date().toISOString(), jobs:Array.from({length:7}, (_, id) => ({id,title:`Job ${id}`,handle:'Alice',model:'model-a',type:'review',last_seen:new Date().toISOString()}))};
  ui.render(work);
  assert.equal(root.dataset.state, 'active');
  assert.equal((get('[data-jobs]').innerHTML.match(/class="running-row"/g)||[]).length, 5);
  get('[data-more]').onclick();
  assert.equal(get('[data-more]').attrs['aria-expanded'], 'true');
  assert.equal((get('[data-jobs]').innerHTML.match(/class="running-row"/g)||[]).length, 7);
  ui.fail();
  assert.equal(root.dataset.state, 'stale');
  assert.equal(get('#running-title').textContent, 'Last update');
  assert.ok(get('[data-status]').textContent.includes('last update'));
  assert.doesNotMatch(get('[data-jobs]').innerHTML,/data-live="true"/);
  assert.match(get('[data-jobs]').innerHTML,/Last seen live/);
  ui.render(work);
  assert.equal(get('#running-title').textContent, 'Agent work');
  ui.render({...work, total:0, jobs:[]});
  assert.equal(root.dataset.state, 'quiet');
  assert.ok(get('[data-jobs]').innerHTML.includes('No agent work recorded yet'));
  assert.equal(get('[data-more]').hidden, true);
});


test('recent assignments fill a quiet log without impersonating live agents; all 200 live jobs expand', () => {
  const els = new Map();
  const root = {id:'recent',dataset:{},setAttribute(){},querySelector(s){if(!els.has(s))els.set(s,{innerHTML:'',textContent:'',attrs:{},setAttribute(k,v){this.attrs[k]=v;}});return els.get(s);}};
  const ui = context.SA.runningWork.create(root,{base:'/projects/example'}), get=s=>root.querySelector(s);
  const job={id:1,title:'Number-only title',handle:'Alice',model:'model-a',type:'review',live:false,activity_status:'completed',ended_at:new Date().toISOString(),presentation:{title:'Prime-window bound',what:"Checking the author's claim: an improved bound",why:'Decide what the evidence supports.'}};
  ui.render({total:0,recent_total:5,as_of:new Date().toISOString(),jobs:Array.from({length:5},(_,i)=>({...job,id:i+1}))});
  assert.equal(root.dataset.state,'quiet');
  assert.equal(get('[data-count]').textContent,'0 live · 5 recent');
  const html=get('[data-jobs]').innerHTML;
  assert.equal((html.match(/data-live="false"/g)||[]).length,5);
  assert.match(html,/Submitted/);assert.doesNotMatch(html,/Checked in/);
  assert.match(html,/Prime-window bound/);assert.match(html,/What:/);assert.match(html,/Why:/);
  assert.doesNotMatch(html,/Number-only title/);
  ui.render({total:200,recent_total:0,as_of:new Date().toISOString(),jobs:Array.from({length:200},(_,i)=>({...job,id:i+1,live:true}))});
  assert.equal(get('[data-count]').textContent,'200 live');
  assert.equal((get('[data-jobs]').innerHTML.match(/class="running-row"/g)||[]).length,5);
  get('[data-more]').onclick();
  assert.equal((get('[data-jobs]').innerHTML.match(/class="running-row"/g)||[]).length,200);
  assert.equal(get('[data-more]').attrs['aria-expanded'],'true');
});
