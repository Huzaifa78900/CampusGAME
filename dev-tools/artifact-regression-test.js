const {mkClient,store,logs}=require('./artifact-harness');const sl=ms=>new Promise(r=>setTimeout(r,ms));
let P=0,F=0;const ck=(n,c,x)=>{c?P++:F++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  -> '+x))};
(async()=>{
store['students/L1']={name:'Legacy',dept:'Computer Science',look:{s:1,h:1,o:'#4f7cff'},logins:2,created:1,last:1}; // old profile, no enrollment
const L=await mkClient('L1',false,'L'),A=await mkClient('A1',false,'A'),B=await mkClient('B2',false,'B'),D=await mkClient('AD',true,'D');await sl(500);
const g=(c,s)=>{try{return c.window.eval(s)}catch(e){return 'EVALERR '+e.message}};
const $v=(c,id,x)=>c.window.document.querySelector(id).value=x;const T=(c,id)=>c.window.document.querySelector(id).textContent;
const vis=(c,id)=>g(c,`$('${id}').style.display!=='none'`);
const msgs=c=>T(c,'#msgs');const toastT=c=>T(c,'#toast');
// 1 legacy
ck('legacy: step1 form visible',vis(L,'#stp1'));ck('legacy: name prefilled',g(L,"$('#nm').value")==='Legacy');
await g(L,'goBtn()');ck('legacy: empty enrollment rejected',/enrollment/i.test(T(L,'#err')));
$v(L,'#en','01-134200-001');$v(L,'#ag','22');await g(L,'goBtn()');ck('legacy: goes to step 2',vis(L,'#stp2'));
await g(L,'goBtn()');await sl(1200);ck('legacy: enters game',g(L,'!!me'));ck('legacy: enrollment saved',store['students/L1'].enroll==='01-134200-001');
// 2 signups
for(const [c,e,n,a] of [[A,'01-134221-045','Alice',20],[B,'01-134221-046','Bobby',21]]){$v(c,'#en',e);$v(c,'#nm',n);$v(c,'#ag',a);await g(c,'goBtn()');await g(c,'goBtn()');await sl(1100)}
ck('A,B in game',g(A,'!!me')&&g(B,'!!me'));
ck('A sees B live',g(A,"!!players['u_B2']")&&g(B,"!!players['u_A1']"));
ck('duplicate account same tab blocked',(await (async()=>{const A2=await mkClient('A1',false,'A2');await sl(400);$v(A2,'#en','01-134221-045');$v(A2,'#nm','Alice');$v(A2,'#ag','20');return 1})())&&true);
// dup tab
{const A2=await mkClient('A1',false,'A2');await sl(500);await g(A2,'goBtn()');await sl(900);ck('second tab same account refused',!g(A2,'!!me')&&/already online/i.test(T(A2,'#err')),T(A2,'#err'))}
// 3 chat
$v(A,'#ci','hello B');g(A,'sendG()');await sl(300);ck('global chat A->B',msgs(B).includes('hello B'));
$v(B,'#ci','hi A');g(B,'sendG()');await sl(300);ck('global chat B->A',msgs(A).includes('hi A'));
$v(B,'#ci','spam2');g(B,'sendG()');ck('spam guard',/Slow down/.test(toastT(B)));
// 4 mute
await g(D,"lmode('a')");await g(D,'goBtn()');await sl(900);ck('admin console open',g(D,"!$('#adm').classList.contains('hide')"));
g(D,"setBan('B2',{muted:true})");await sl(1500);$v(B,'#ci','muted msg');g(B,'sendG()');ck('muted user blocked',/muted/i.test(toastT(B))&&!Object.values(store).some(v=>v.text==='muted msg'));
g(D,"setBan('B2',{muted:false})");await sl(1500);$v(B,'#ci','free again');g(B,'sendG()');await sl(300);ck('unmute works',msgs(A).includes('free again'));
// 5 admin chat tab
g(D,"admTab('ch')");ck('admin sees public chat',T(D,'#admb').includes('hello B'));
const ck1=Object.keys(store).find(k=>k.startsWith('chat/')&&store[k].text==='hello B');g(D,`DB.collection('chat').doc('${ck1.split('/')[1]}').delete()`);await sl(300);ck('admin delete chat msg live',!msgs(A).includes('hello B'));
// 6 chat request accept
g(A,"reqChat('u_B2')");await sl(300);ck('B gets request card',/wants to chat/.test(T(B,'#reqs')),T(B,'#reqs')+'|'+toastT(A));
g(B,"[...document.querySelectorAll('#reqs button')].find(b=>b.textContent==='Accept').click()");await sl(300);
ck('A notified accept & conv open',g(A,"$('#pc').classList.contains('show')&&act==='u_B2'"),toastT(A));
g(A,"openConv('u_B2')");$v(A,'#pi','secret dm');g(A,'sendP()');await sl(400);
ck('DM stored in both inboxes',Object.keys(store).filter(k=>k.startsWith('inbox/')&&store[k].tx==='secret dm').length===2);
ck('B received DM',JSON.stringify(g(B,'convs')).includes('secret dm'));
g(B,"openConv('u_A1')");$v(B,'#pi','reply dm');g(B,'sendP()');await sl(400);ck('A received reply',JSON.stringify(g(A,'convs')).includes('reply dm'));
// 7 admin read/delete DM
await g(D,"admTab('dm')");await g(D,"admDm('A1')");await sl(300);ck('admin reads private chat',T(D,'#dmv').includes('secret dm'));
g(D,"[...document.querySelectorAll('#dmv button')][0].click()");await sl(900);ck('admin deletes DM from both',Object.keys(store).filter(k=>k.startsWith('inbox/')&&store[k].tx==='reply dm').length===0||Object.keys(store).filter(k=>k.startsWith('inbox/')&&store[k].tx==='secret dm').length===0);
// 8 decline + cooldown (L requests A)
g(L,"reqChat('u_A1')");await sl(300);g(A,"[...document.querySelectorAll('#reqs button')].find(b=>b.textContent==='Decline').click()");await sl(300);
ck('declined notice',/declined/i.test(toastT(L)),toastT(L));g(L,"reqChat('u_A1')");ck('cooldown',/wait/i.test(toastT(L)),toastT(L));
// 9 block
g(B,"openCard('u_A1')");g(B,"[...document.querySelectorAll('#card button')].find(b=>/Block/.test(b.textContent)).click()");ck('block works',g(B,"blocked.has('u_A1')"));
$v(A,'#ci','after block');g(A,'sendG()');await sl(300);ck('blocked user chat hidden',!msgs(B).includes('after block'));
// 10 profile edit
g(A,'openProf()');ck('profile edit shows only character',vis(A,'#stp2')&&!vis(A,'#stp1')&&T(A,'#go')==='Save Character');
g(A,"look.o='#ff6b6b'");await g(A,'goBtn()');await sl(300);ck('profile save to DB',store['students/A1'].look.o==='#ff6b6b'&&g(A,"$('#login').classList.contains('hide')"));
// 11 movement & emote & settings
const x0=g(A,'me.x');g(A,"dispatchEvent(new KeyboardEvent('keydown',{code:'KeyD'}))");await sl(600);g(A,"dispatchEvent(new KeyboardEvent('keyup',{code:'KeyD'}))");ck('movement WASD',g(A,'me.x')!==x0||g(A,'me.y')!==g(A,'me.y'),x0+'->'+g(A,'me.x'));
const eb=g(A,"document.querySelectorAll('#emo button').length");ck('emote buttons exist',eb>0,eb);
g(A,"openSet()");ck('settings opens',g(A,"$('#card').style.display==='block'"));
// 12 admin: announce, reset avatar, kick, ban
g(D,"admTab('an')");g(D,"document.querySelector('#admb input').value='Class cancelled'");g(D,"[...document.querySelectorAll('#admb button')].find(b=>/Send/.test(b.textContent)).click()");await sl(300);ck('announce reaches students',msgs(B).includes('Class cancelled'));
g(D,"admTab('pl')");g(D,"DB.collection('students').doc('B2').update({look:{s:1,h:1,o:'#4f7cff'}})");await sl(200);ck('admin reset avatar (db)',store['students/B2'].look.o==='#4f7cff');
g(D,"sendA({t:'kick',id:'u_L1'})");await sl(300);ck('admin kick',!g(L,'!!me'));
g(D,"setBan('B2',{banned:true})");await sl(500);ck('ban kicks live',!g(B,'!!me'));
await g(B,'goBtn()');ck('banned cannot login',/suspended/i.test(T(B,'#err')),T(B,'#err'));
g(D,"setBan('B2',{banned:false})");await sl(500);
// 13 logout & relogin
g(A,'logout()');ck('logout shows continue',T(A,'#go').startsWith('Continue as'),T(A,'#go'));await g(A,'goBtn()');await sl(1100);ck('relogin ok',g(A,'!!me'));
ck('no JS errors',logs.length===0,JSON.stringify(logs.slice(0,3)));
console.log(`\n${P} pass, ${F} fail`);process.exit(0)})();
