const {JSDOM}=require('jsdom');const fs=require('fs');
const html=fs.readFileSync(process.argv[2]||'cw.html','utf8');
// shared fake backend
const store={};const dbSubs=[];const roomL=[];
const ids=p=>p.split('/');
function mkSnap(path){const d=store[path];return{id:ids(path).pop(),exists:!!d,data:()=>d&&JSON.parse(JSON.stringify(d))}}
function colDocs(col){return Object.keys(store).filter(k=>k.startsWith(col+'/')&&ids(k).length===ids(col).length+1)}
function notify(path){dbSubs.forEach(s=>s(path))}
function mkDB(){const db={collection:col=>{const q=(ord,lim)=>({orderBy:(f,d)=>q({f,d},lim),limit:n=>q(ord,n),
 _docs(){let ks=colDocs(col).map(k=>({k,v:store[k]}));if(ord)ks.sort((a,b)=>(ord.d==='desc'?-1:1)*(a.v[ord.f]-b.v[ord.f]));if(lim)ks=ks.slice(0,lim);return ks},
 async get(){const ds=this._docs().map(o=>({id:ids(o.k).pop(),data:()=>o.v}));return{docs:ds,empty:!ds.length,size:ds.length}},
 onSnapshot(cb){let seen={};const run=()=>{const cur={};const ch=[];const ds=this._docs();ds.forEach(o=>{cur[o.k]=JSON.stringify(o.v);if(!(o.k in seen))ch.push({type:'added',doc:{id:ids(o.k).pop(),data:()=>o.v}});else if(seen[o.k]!==cur[o.k])ch.push({type:'modified',doc:{id:ids(o.k).pop(),data:()=>o.v}})});Object.keys(seen).forEach(k=>{if(!(k in cur))ch.push({type:'removed',doc:{id:ids(k).pop(),data:()=>({})}})});seen=cur;cb({docs:ds.map(o=>({id:ids(o.k).pop(),data:()=>o.v})),empty:!ds.length,docChanges:()=>ch})};const h=p=>{if(p.startsWith(col+'/'))run()};dbSubs.push(h);setTimeout(run,0);return()=>{const i=dbSubs.indexOf(h);if(i>=0)dbSubs.splice(i,1)}}});
 const base=q();return Object.assign(base,{doc:id=>{const p=col+'/'+id;return{get:async()=>mkSnap(p),set:async v=>{store[p]=JSON.parse(JSON.stringify(v));setTimeout(()=>notify(p),0)},update:async v=>{store[p]=Object.assign({},store[p],v);setTimeout(()=>notify(p),0)},delete:async()=>{delete store[p];setTimeout(()=>notify(p),0)},onSnapshot(cb){let last;const h=pp=>{if(pp===p){cb(mkSnap(p))}};dbSubs.push(h);setTimeout(()=>cb(mkSnap(p)),0);return()=>{const i=dbSubs.indexOf(h);if(i>=0)dbSubs.splice(i,1)}}}}})}};return db}
const logs=[];
function mkClient(uid,admin,tag){return new Promise(res=>{
 const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:'https://x.test/',beforeParse(w){
  const noop=()=>{};const ctx=new Proxy({},{get:(t,k)=>k==='measureText'?()=>({width:10}):k==='createLinearGradient'||k==='createRadialGradient'?()=>({addColorStop:noop}):(t[k]||noop),set:(t,k,v)=>{t[k]=v;return true}});
  w.HTMLCanvasElement.prototype.getContext=()=>ctx;w.matchMedia=()=>({matches:false,addListener:noop});w.BroadcastChannel=undefined;
  w.ResizeObserver=class{observe(){}disconnect(){}};
  const topics={};const me={isMe:true};
  let self;const room={emit:async(t,d)=>{if(t==='a'&&!admin){const e=new Error('np');e.code='not_permitted';throw e}roomL.forEach(c=>c.recv(t,d,uid,c===self))},on:(t,f)=>{(topics[t]=topics[t]||[]).push(f);return noop}};
  self={uid,recv:(t,d,by,same)=>{(topics[t]||[]).forEach(f=>f({data:JSON.parse(JSON.stringify(d)),by,sameTab:same,isMe:by===uid,peer:'p'+by}))}};roomL.push(self);
  w.claude={use:async n=>n==='db'?mkDB():n==='room'?room:n==='user'?{id:async()=>uid,isOwner:async()=>admin,canEdit:async()=>admin}:null};
  w.addEventListener('error',e=>logs.push(tag+' ERR '+e.message));
 }});res(dom)})}
module.exports={mkClient,store,logs};
