import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {folderLaunchContract} from '../src/lib/launch.ts';

test('copied joining instructions stay short and fetch setup guidance before the assignment URL',async()=>{
  const origin='https://example.test',slug='twin-primes',token='sah_fixture_token_never_real';
  const settings={time:'continuous',subagents:'yes',share:'75',disk:'5',work:'all'},nodes=new Map();
  const node=selector=>{
    const field=/input\[name="([^"]+)"\]:checked/.exec(selector);
    if(field)return {value:settings[field[1]]};
    if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',value:'',events:{},classList:{remove(){}},setAttribute(){},querySelector:node,
      addEventListener(name,handler){this.events[name]=handler;}});
    return nodes.get(selector);
  };
  const contract=folderLaunchContract(origin,slug),requests=[];
  const replies={
    '/me':{signed_in:true,handle:'fixture'},'/me/token':{token},
    [`/projects/${slug}/joining-contract`]:contract,[`/projects/${slug}/sessions`]:{sessions:[]},
  };
  let copied;
  const window={renderTermsAccept(){},termsStatus:async()=>({signed_in:true,accepted:true,version:'fixture'})};
  const context={window,location:{origin,pathname:`/projects/${slug}`},document:{title:'Twin primes · solveathome'},
    navigator:{clipboard:{writeText:async value=>{copied=value;}}},setTimeout(){},requestAnimationFrame:fn=>fn(),
    fetch:async path=>{requests.push(path);assert.ok(Object.hasOwn(replies,path),`unexpected request: ${path}`);return {ok:true,json:async()=>replies[path]};}};
  vm.runInNewContext(readFileSync(new URL('../public/assets/start-field.js',import.meta.url),'utf8'),context);
  await window.renderStartField({querySelector:node},slug);
  assert.doesNotMatch(node('#sf-instr').innerHTML,new RegExp(token),'rendered credential stays masked');
  await node('.sf-copy').onclick();
  const check=()=>{
    assert.ok(copied.startsWith(`First read ${contract.protocol_url}`));
    assert.ok(copied.indexOf('follow its setup instructions')<copied.indexOf('After readiness passes, use this exact joining URL:'));
    assert.ok(!copied.includes(contract.guidance),'detailed instructions belong in the protocol response');
    assert.doesNotMatch(copied,/all-complete check|thinking-level lookup|publication_safety|model ID|self-review/);
    assert.doesNotMatch(copied,/Freebuff|desktop-v2\.db|threads\.reasoning_effort/);
    assert.ok(copied.includes(`SOLVEATHOME_TOKEN=${token}`));assert.doesNotMatch(copied,/workspace=1/);
  };
  check();assert.ok(copied.includes(`joining URL: ${origin}/projects/${slug}/start.`));
  assert.ok(copied.length<550,`default instruction is ${copied.length} characters`);
  assert.match(copied,/Start in general mode/);
  settings.time='2h';node('.sf-settings').events.change({target:{name:'time'}});
  const direction='Study “alpha” exactly.\nKeep this direction across assignments.';
  node('.sf-dir').value=direction;node('.sf-dir').events.input();await node('.sf-copy').onclick();
  check();assert.ok(copied.includes(`/start?time=2h&directions=1.`));assert.ok(copied.includes(JSON.stringify(direction)));
  settings.work='reviews';node('.sf-settings').events.change({target:{name:'work'}});await node('.sf-copy').onclick();
  check();assert.ok(copied.includes(`/start?time=2h&work=reviews&directions=1.`),'reviews only rides on the joining URL');settings.work='all';
  assert.doesNotMatch(copied,/Start in general mode/);
  assert.ok(!requests.some(path=>path.includes('/start')),'the joining form never requests an assignment');
});
