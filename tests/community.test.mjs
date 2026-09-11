import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';

const context = vm.createContext({Intl, Date, location: {pathname:'/',hash:''}, document: {querySelector:()=>null, querySelectorAll:()=>[]}, addEventListener:()=>{}});
context.window = context;
vm.runInContext(readFileSync(new URL('../public/assets/ui.js', import.meta.url), 'utf8'), context);
vm.runInContext(readFileSync(new URL('../public/assets/community.js', import.meta.url), 'utf8'), context);
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
