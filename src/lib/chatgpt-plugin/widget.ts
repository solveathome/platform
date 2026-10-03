/* eslint-disable @stylistic/max-len -- the widget's own CSS and script are embedded as source text */
/**
 * The widget shell: one self-contained HTML document a plugin's tool renders in, inside ChatGPT's
 * sandboxed iframe. It speaks the MCP Apps bridge (JSON-RPC over postMessage: ui/initialize, then
 * ui/notifications/tool-result) and falls back to window.openai.toolOutput, so the same file works
 * in every host that implements either. A site gives only its look (css) and a render function.
 *
 * render is the source of a JS function (data, root, h) that fills root from the tool's
 * structuredContent (with the result's _meta, which only the widget sees, as data._meta); h.esc(s) escapes text, h.a(href, text, cls) makes a link that opens through
 * the host (a plain link may be blocked in the sandbox). No external script, no font, no tracker:
 * nothing loads that the CSP in mcp.ts does not name.
 */

export interface WidgetShell {
  title: string;
  /** The site's accent and the widget's own styles; kept small, no web fonts. */
  css?: string;
  /** Source of `function (data, root, h) { … }`. */
  render: string;
}

const BASE_CSS = `
:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--bg:transparent;--accent:#1d1d1f;--card:#fff}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--muted:#a1a1a6;--line:#3a3a3c;--card:#1c1c1e;--accent:#f5f5f7}}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
#root{padding:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:0 0 10px}
.title{font-weight:600;font-size:16px;margin:0 0 4px}.muted{color:var(--muted);font-size:13px}
.row{display:flex;gap:12px;align-items:baseline;justify-content:space-between;flex-wrap:wrap}
.big{font-size:22px;font-weight:650;letter-spacing:-.01em}
a{color:var(--accent);text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:12px;color:var(--muted);margin:0 4px 4px 0}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
img.thumb{width:64px;height:64px;object-fit:contain;border-radius:8px;background:#fff}
.empty{color:var(--muted);padding:8px 0}
`;

const BRIDGE = `
(function(){
  var root=document.getElementById('root');var drawn=false;var nextId=1;var pending={};
  var h={
    esc:function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})},
    a:function(href,text,cls){return '<a data-href="'+h.esc(href)+'"'+(cls?' class="'+h.esc(cls)+'"':'')+'>'+h.esc(text)+'</a>'}
  };
  var render=(RENDER);
  function withMeta(d,meta){if(!d||typeof d!=='object')return d;if(meta&&typeof meta==='object'){var o={};for(var k in d)o[k]=d[k];o._meta=meta;return o;}return d;}
  function draw(data){if(!data||typeof data!=='object')return;drawn=true;try{render(data,root,h);}catch(e){root.innerHTML='<div class="empty">Could not show this result.</div>';}resize();}
  function post(msg){try{window.parent.postMessage(msg,'*');}catch(e){}}
  function request(method,params){var id=nextId++;post({jsonrpc:'2.0',id:id,method:method,params:params||{}});return new Promise(function(res){pending[id]=res;setTimeout(function(){if(pending[id]){delete pending[id];res(null);}},4000);});}
  function resize(){var height=Math.ceil(document.documentElement.scrollHeight);post({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:height}});if(window.openai&&window.openai.notifyIntrinsicHeight){try{window.openai.notifyIntrinsicHeight(height);}catch(e){}}}
  function open(href){
    if(window.openai&&window.openai.openExternal){try{window.openai.openExternal({href:href});return;}catch(e){}}
    request('ui/open-link',{url:href}).then(function(r){if(r===null){try{window.open(href,'_blank','noopener');}catch(e){}}});
  }
  document.addEventListener('click',function(ev){var t=ev.target;while(t&&t!==document&&!(t.getAttribute&&t.getAttribute('data-href')))t=t.parentNode;if(t&&t.getAttribute&&t.getAttribute('data-href')){ev.preventDefault();open(t.getAttribute('data-href'));}});
  window.addEventListener('message',function(ev){
    var m=ev.data;if(!m||m.jsonrpc!=='2.0')return;
    if(m.id!=null&&pending[m.id]){var r=pending[m.id];delete pending[m.id];r(m.result||null);return;}
    if(m.method==='ui/notifications/tool-result'&&m.params){draw(withMeta(m.params.structuredContent,m.params._meta));}
  });
  window.addEventListener('openai:set_globals',function(ev){var g=ev.detail&&ev.detail.globals;if(g&&g.toolOutput)draw(withMeta(g.toolOutput,g.toolResponseMetadata||(window.openai&&window.openai.toolResponseMetadata)));});
  request('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:document.title,version:'1'},appCapabilities:{}}).then(function(){post({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}});});
  function fromGlobals(){if(window.openai&&window.openai.toolOutput)draw(withMeta(window.openai.toolOutput,window.openai.toolResponseMetadata));}
  fromGlobals();
  setTimeout(function(){if(!drawn)fromGlobals();},300);
  if(window.ResizeObserver)new ResizeObserver(resize).observe(document.body);
})();
`;

const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

export function widgetHtml(shell: WidgetShell): string {
  const script = BRIDGE.replace('(RENDER)', `(${shell.render})`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(shell.title)}</title><style>${BASE_CSS}${shell.css || ''}</style></head><body><div id="root"><div class="empty">Loading…</div></div><script>${script}</script></body></html>`;
}
