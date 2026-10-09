import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../public/assets/lean-milestones.js',import.meta.url),'utf8');
function fixture(json,papers=['example'],document={hidden:false}){
  const root={innerHTML:'',hidden:true};const SA={json};
  runInNewContext(source,{SA,crypto:{randomUUID:()=> 'read-fixture'},AbortSignal,document});
  return {root,client:SA.leanMilestones.create(root,{base:'/projects/example-project',papers})};
}
const response=(url,html)=>({lean_milestone_request:new URL(url,'https://example.org').searchParams.get('lean_request'),lean_milestone_html:html});
const callout='<section>Main theorem verified in Lean</section>'; // UI fixture, not a proof receipt.

test('no designation candidates means no verdict requests or badge',async()=>{
  let calls=0;const {root,client}=fixture(async()=>{calls++;},[]);await client.refresh();assert.equal(calls,0);assert.equal(root.hidden,true);
});
test('current server callout is fetched without cache and cleared before each refresh',async()=>{
  let html=callout;const {root,client}=fixture(async(url,options)=>{assert.equal(options.cache,'no-store');assert.equal(root.innerHTML,'');return response(url,html);});
  await client.refresh();assert.equal(root.innerHTML,callout);html='';await client.refresh();assert.equal(root.hidden,true);assert.equal(root.innerHTML,'');
});
test('failed refresh clears an earlier positive badge',async()=>{
  let fail=false;const {root,client}=fixture(async url=>{if(fail)throw new Error('offline');return response(url,callout);});
  await client.refresh();fail=true;await client.refresh();assert.doesNotMatch(root.innerHTML,/Main theorem verified/);assert.match(root.innerHTML,/could not refresh/);
});
test('stale response echoes and author approval flags cannot create callouts',async()=>{
  for(const body of [{lean_milestone_request:'old-request',lean_milestone_html:callout},{approved:true,verified:true}]){
    const {root,client}=fixture(async()=>body);await client.refresh();assert.doesNotMatch(root.innerHTML,/Main theorem verified/);
  }
});
test('late positive responses never overwrite a newer revoked or unconfigured response',async()=>{
  const pending=[];const {root,client}=fixture(url=>new Promise(resolve=>pending.push({url,resolve})));
  const old=client.refresh(),latest=client.refresh();pending[1].resolve(response(pending[1].url,''));await latest;
  pending[0].resolve(response(pending[0].url,callout));await old;assert.equal(root.innerHTML,'');assert.equal(root.hidden,true);
});
test('late failures cannot erase a newer current response',async()=>{
  const pending=[];const {root,client}=fixture(url=>new Promise((resolve,reject)=>pending.push({url,resolve,reject})));
  const old=client.refresh(),latest=client.refresh();pending[1].resolve(response(pending[1].url,callout));await latest;
  pending[0].reject(new Error('old timeout'));await old;assert.equal(root.innerHTML,callout);
});

test('hiding the page invalidates in-flight positive replies and clears cached back-navigation state',async()=>{
  let pending;const {root,client}=fixture(url=>new Promise(resolve=>pending={url,resolve}));
  const refresh=client.refresh();client.clear();pending.resolve(response(pending.url,callout));await refresh;
  assert.equal(root.hidden,true);assert.equal(root.innerHTML,'');
});

test('hidden initial pages never request or paint a verification badge',async()=>{
  const document={hidden:true};let calls=0;
  const {root,client}=fixture(async url=>{calls++;return response(url,callout);},['example'],document);
  await client.refresh();assert.equal(calls,0);assert.equal(root.hidden,true);
  document.hidden=false;let pending;
  const second=fixture(url=>new Promise(resolve=>pending={url,resolve}),['example'],document);
  const request=second.client.refresh();document.hidden=true;pending.resolve(response(pending.url,callout));await request;
  assert.equal(second.root.innerHTML,'');assert.equal(second.root.hidden,true);
});
