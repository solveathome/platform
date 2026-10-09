import assert from'node:assert/strict';import{test}from'node:test';import{readFileSync}from'node:fs';import{runInNewContext}from'node:vm';
import{PAPER_RESEARCH_ORDER,paperResearchStatus,comparePaperResearchStatus}from'../src/lib/paper-list-status.ts';
const entry=(research_status,slug,updated_at='2026-10-09T12:00:00Z')=>({research_status,slug,updated_at});
test('one canonical paper status order places eligible main Lean proof highest, then actual current reviewed rungs',()=>{
 const cases=[['reviewed','proven','reviewed',false,'proven'],['reviewed','verified','reviewed',false,'verified'],['reviewed','heuristic','reviewed',false,'heuristic'],['reviewed',null,'reviewed',false,'reviewed'],['corrections_required','proven','reviewed',false,'corrections_required'],['under_reassessment','proven','under_review',false,'under_reassessment'],['unreviewed','proven','under_review',false,'under_review'],['earlier_version_reviewed','proven','draft',false,'earlier_version_reviewed'],['unreviewed','proven','draft',false,'draft'],['unreviewed','proven','proposed',false,'proposed']];
 for(const[state,rung,status,main,want]of cases)assert.equal(paperResearchStatus({state,rung},status,main),want);
 assert.equal(paperResearchStatus({state:'unreviewed',rung:null},'draft',true),'proven_with_lean');
 const actual=[...PAPER_RESEARCH_ORDER].reverse().map(key=>entry(key,key));assert.deepEqual(actual.sort(comparePaperResearchStatus).map(x=>x.research_status),[...PAPER_RESEARCH_ORDER]);
});
test('highest status depends on the current resolver, never registry prose, model or checking-method labels',()=>{
 const gate=(main)=>paperResearchStatus({state:'reviewed',rung:'proven'},'reviewed',main);
 const main=entry(gate(true),'main','2020-01-01'),newer=entry('verified','newer','2026-10-09');assert.equal([newer,main].sort(comparePaperResearchStatus)[0].slug,'main');
 for(const reason of ['revoked execution','reopened judgment','stale manuscript','pending acceptance','helper-only','missing designation'])assert.notEqual(gate(false),'proven_with_lean',reason);
 assert(comparePaperResearchStatus(entry('Proven with Lean','foreign'),entry('proven_with_lean','real'))>0,'a display label is not a recognized highest status');
 const a={...entry('proven_with_lean','a'),profile:'lean-kernel-v1',label:'Proven with Lean',model:'gpt-6.1-sol'},b={...entry('proven_with_lean','b'),profile:'lean-comparator-v2',label:'Independent exports',model:'claude-opus-5-5'};assert(comparePaperResearchStatus(a,b)<0,'profile/model detail never creates another higher rank');
});
test('equal current statuses preserve newest-first ordering with deterministic slug/identity ties',()=>{
 const items=[entry('verified','z','2025-01-01'),entry('verified','b','2026-01-01'),entry('verified','a','2026-01-01'),entry('verified','old',null)];assert.deepEqual(items.sort(comparePaperResearchStatus).map(x=>x.slug),['a','b','z','old']);
 assert(comparePaperResearchStatus({...entry('verified','same'),id:'1'},{...entry('verified','same'),id:'2'})<0);
});
const page=readFileSync(new URL('../public/project.html',import.meta.url),'utf8'),source=page.slice(page.indexOf('let papersGeneration'),page.indexOf('async function refreshBoard'));
function client(json){const elements=Object.fromEntries(['#papers-front','#papers-all'].map(id=>[id,{innerHTML:'Old badge',get textContent(){return this.innerHTML;},set textContent(v){this.innerHTML=v;}}])),document=new EventTarget();document.hidden=false;const context={document,SA:{json,dates:()=>''},BASE:'/projects/fixture',$:id=>elements[id],esc:s=>String(s??''),AbortSignal};runInNewContext(source+'\nglobalThis.load=loadPapers;globalThis.clear=clearPaperLists;',context);return{elements,document,load:context.load,clear:context.clear};}
test('both project paper indexes respect server status order and refresh without cached positive badges',async()=>{
 let high=true;const c=client(async(url,options)=>{assert.equal(options.cache,'no-store');assert.equal(c.elements['#papers-all'].textContent,'Loading current paper status…');return{papers:high?[{slug:'main',url:'/main',title:'Main',status:'reviewed',status_label:'Main theorem proven with Lean',reviewed_pdf:{url:'/projects/fixture/papers/main/expositions/7/pdf'}},{url:'/new',title:'New draft',status:'draft',status_label:'draft'}]:[{url:'/new',title:'New draft',status:'draft',status_label:'draft'},{url:'/main',title:'Main',status:'draft',status_label:'draft'}]};});
 await c.load();for(const el of Object.values(c.elements)){assert(el.innerHTML.indexOf('Main')<el.innerHTML.indexOf('New draft'));assert(el.innerHTML.includes('View PDF'));assert(el.innerHTML.includes('/expositions/7/pdf'));}
 high=false;await c.load();for(const el of Object.values(c.elements)){assert(el.innerHTML.indexOf('New draft')<el.innerHTML.indexOf('Main'));assert(!el.innerHTML.includes('Main theorem proven with Lean'));assert(!el.innerHTML.includes('View PDF'));}
});
test('an older paper response cannot restore a revoked highest badge and the project ladder includes verified',async()=>{
 let first;let calls=0;const c=client(()=>++calls===1?new Promise(resolve=>first=resolve):Promise.resolve({papers:[]}));const old=c.load();await c.load();first({papers:[{url:'/main',title:'Old',status:'reviewed',status_label:'Main theorem proven with Lean'}]});await old;for(const el of Object.values(c.elements))assert(!el.innerHTML.includes('Main theorem proven with Lean'));
 assert(page.includes('["proven","verified","measured","heuristic","conjectured","refuted"]'));assert(page.includes("loadBoard(), safeLoad(loadPapers, '#papers-front')"));assert(!page.includes('lean-milestones'));assert(!page.includes('leanMilestones'));assert(!page.includes('__LEAN_CANDIDATES__'));
});

test('failed fresh paper reads clear prior highest badges in both lists',async()=>{
 let fail=false;const c=client(async()=>{if(fail)throw new Error('offline');return{papers:[{url:'/main',title:'Main',status:'reviewed',status_label:'Main theorem proven with Lean',reviewed_pdf:{url:'/projects/fixture/papers/main/expositions/7/pdf'}}]};});
 await c.load();fail=true;await assert.rejects(c.load(),/offline/);for(const el of Object.values(c.elements))assert(!el.innerHTML.includes('Main theorem proven with Lean'));
});

test('actual pagehide and visibility-hidden handlers invalidate pending paper reads before cached navigation',async()=>{
 for(const name of ['pagehide','visibilitychange']){let pending;const c=client(()=>new Promise(resolve=>pending=resolve)),window=new EventTarget();const start=page.lastIndexOf('(async () => {'),end=page.indexOf('})();',start)+5,noop=async()=>{};
 const initialization=runInNewContext(page.slice(start,end),{document:c.document,addEventListener:window.addEventListener.bind(window),leanMilestones:{clear(){},refresh:noop},clearPaperLists:c.clear,loadMe:noop,refreshBoard:noop,renderStartField:noop,$:()=>({}),SLUG:'fixture',safeLoad:noop,loadPapers:c.load,loadDocuments:noop,loadProvenance:noop,loadHighscores:noop,sequenceList:{refresh:noop},openChannel:noop,polling:null,channelRequest:null,setInterval:()=>0,clearInterval(){}});
 await initialization;const reading=c.load();const event=new Event(name);if(name==='pagehide'){event.persisted=true;window.dispatchEvent(event);}else{c.document.hidden=true;c.document.dispatchEvent(event);c.document.hidden=false;}
 for(const el of Object.values(c.elements))assert.equal(el.innerHTML,'');pending({papers:[{url:'/main',title:'Old main',status:'reviewed',status_label:'Main theorem proven with Lean'}]});await reading;for(const el of Object.values(c.elements))assert(!el.innerHTML.includes('Main theorem proven with Lean'),'a pre-hide response cannot restore a stale badge');
 }
});

const paperPage=readFileSync(new URL('../public/paper.html',import.meta.url),'utf8');
test('actual project initialization invalidates its first pending Papers read before starting polling',{timeout:1000},async()=>{
 let pending,markStarted;const started=new Promise(resolve=>markStarted=resolve),c=client(()=>new Promise(resolve=>{pending=resolve;markStarted();})),window=new EventTarget(),noop=async()=>{};let timers=0;
 const start=page.lastIndexOf('(async () => {'),end=page.indexOf('})();',start)+5;
 const initialization=runInNewContext(page.slice(start,end),{document:c.document,addEventListener:window.addEventListener.bind(window),clearPaperLists:c.clear,loadMe:noop,refreshBoard:c.load,renderStartField:noop,$:()=>({}),SLUG:'fixture',safeLoad:noop,loadPapers:c.load,loadDocuments:noop,loadProvenance:noop,loadHighscores:noop,sequenceList:{refresh:noop},openChannel:noop,polling:null,channelRequest:null,setInterval:()=>++timers,clearInterval(){}});
 await started;const hide=new Event('pagehide');hide.persisted=false;window.dispatchEvent(hide);
 pending({papers:[{url:'/main',title:'Old proof',status:'reviewed',status_label:'Main theorem proven with Lean',reviewed_pdf:{url:'/projects/fixture/papers/main/expositions/7/pdf'}}]});await initialization;
 for(const el of Object.values(c.elements))assert.equal(el.innerHTML,'');assert.equal(timers,0,'departed initial pages start no polling timers');
});

test('paper PDF action is server-rendered with no client refresh or DOM replacement',()=>{
 assert.match(paperPage,/<div class="page-heading">[\s\S]*?<h1>__TITLE__<\/h1>[\s\S]*?id="paper-pdf">__PDF_ACTION__<\/div><\/div>/);
 assert.doesNotMatch(paperPage,/download=/);
 const scripts=[...paperPage.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].filter(([,attrs])=>!attrs.includes('src=')&&!attrs.includes('application/ld+json')).map(([,attrs,source])=>source).join('\n');
 assert.doesNotMatch(scripts,/paper-pdf|lean_request|setInterval|pageshow|pagehide/);
});
