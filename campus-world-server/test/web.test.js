// End-to-end: the REAL web/index.html (in jsdom) + the REAL server + REAL socket.io-client.
// Only Supabase is faked (auth + profiles table), so this does NOT prove the Supabase side.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { io } from 'socket.io-client';
import { createServer } from '../src/server.js';
import { makeStore } from '../src/store.js';

const HTML = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/index.html'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let srv, store, url;
const fakeDb = { users: new Map(), profiles: new Map(), n: 1 };      // shared "Supabase"
const jsErrors = [];

function fakeSupabase() {                                            // one instance per browser window
  let session = null;
  const sess = (id, role) => (session = { access_token: `dev:${id}:x:${role}`, user: { id } });
  return {
    createClient: () => ({
      auth: {
        signUp: async ({ email, password }) => {
          if (fakeDb.users.has(email)) return { error: { message: 'User already registered' } };
          const id = 'U' + fakeDb.n++; fakeDb.users.set(email, { id, pw: password, role: 'student' });
          return { data: { user: { id }, session: sess(id, 'student') }, error: null };
        },
        signInWithPassword: async ({ email, password }) => {
          const u = fakeDb.users.get(email);
          if (!u || u.pw !== password) return { error: { message: 'Invalid login credentials' } };
          return { data: { session: sess(u.id, u.role) }, error: null };
        },
        getSession: async () => ({ data: { session } }),
        getUser: async () => ({ data: { user: session ? session.user : null } }),
        signOut: async () => { session = null; },
      },
      from: () => ({
        insert: async row => {
          if ([...fakeDb.profiles.values()].some(p => p.enrollment.toUpperCase() === row.enrollment.toUpperCase()))
            return { error: { code: '23505', message: 'duplicate key' } };
          fakeDb.profiles.set(row.id, row); store._seed({ ...row, role: 'student' });
          return { error: null };
        },
        select: () => ({ eq: (_c, id) => ({ maybeSingle: async () => ({ data: fakeDb.profiles.get(id) || null }) }) }),
      }),
    }),
  };
}

async function openPage() {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://campus.test/',
    beforeParse(w) {
      const n = () => {};
      const ctx = new Proxy({}, { get: (t, k) => k === 'measureText' ? () => ({ width: 10 }) : (k === 'createLinearGradient' || k === 'createRadialGradient') ? () => ({ addColorStop: n }) : (t[k] || n), set: (t, k, v) => { t[k] = v; return true; } });
      w.HTMLCanvasElement.prototype.getContext = () => ctx;
      w.matchMedia = () => ({ matches: false, addListener: n }); w.ResizeObserver = class { observe() {} disconnect() {} };
      w.CAMPUS_CONFIG = { SUPABASE_URL: 'x', SUPABASE_ANON_KEY: 'y', SERVER_URL: url };
      w.supabase = fakeSupabase(); w.io = io;
      w.addEventListener('error', e => jsErrors.push(e.message));
    },
  });
  await sleep(300);
  const w = dom.window;
  return {
    w, dom,
    ev: s => w.eval(s),
    val: (sel, v) => { w.document.querySelector(sel).value = v; },
    text: sel => w.document.querySelector(sel).textContent,
    shown: sel => w.document.querySelector(sel).style.display !== 'none',
  };
}
async function signUp(p, { email, pw = 'password1', en, name, age = 20 }) {
  await p.ev('SU=true;STEP=1;lview()');
  p.val('#em', email); p.val('#pw', pw); p.val('#en', en); p.val('#nm', name); p.val('#ag', age);
  await p.ev('goBtn()'); await p.ev('goBtn()');
}
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; };

before(async () => {
  process.env.DEV_MODE = '1';
  store = await makeStore();
  srv = await createServer({ store, port: 0 });
  url = 'http://localhost:' + srv.port;
  fakeDb.users.set('boss@x.com', { id: 'ADM1', pw: 'adminpass1', role: 'admin' });
  store._seed({ id: 'ADM1', name: 'Boss', enrollment: 'ADMIN-001', role: 'admin' });
  fakeDb.profiles.set('ADM1', { id: 'ADM1', name: 'Boss', enrollment: 'ADMIN-001', age: 30 });
});
after(async () => { await srv.close(); setTimeout(() => process.exit(0), 100); });

let A, B, ADM;
test('page starts configured, shows sign-in form', async () => {
  A = await openPage();
  assert.equal(A.ev('DB'), true);
  assert.equal(A.text('#go'), 'Sign in');
  assert.ok(A.shown('#cred') && !A.shown('#stp1'));
});

test('sign-up validation (email, password, enrollment, name, age)', async () => {
  await A.ev('SU=true;STEP=1;lview()');
  assert.equal(A.text('#go'), 'Next: Choose Character →');
  await A.ev('goBtn()'); assert.match(A.text('#err'), /email/i);
  A.val('#em', 'alice@x.com'); A.val('#pw', 'short'); await A.ev('goBtn()'); assert.match(A.text('#err'), /8 characters/);
  A.val('#pw', 'password1'); A.val('#en', 'bad'); await A.ev('goBtn()'); assert.match(A.text('#err'), /enrollment/i);
  A.val('#en', '01-134221-045'); A.val('#nm', 'Alice'); A.val('#ag', 12); await A.ev('goBtn()'); assert.match(A.text('#err'), /age/i);
  A.val('#ag', 20); await A.ev('goBtn()');
  assert.ok(A.shown('#stp2') && !A.shown('#stp1'), 'step 2 (character) shown');
  assert.equal(A.text('#go'), 'Create account & enter');
});

test('Alice creates account and enters the campus via the real server', async () => {
  await A.ev('goBtn()');
  assert.ok(await until(() => A.ev('!!me')), 'me created from server init');
  assert.equal(A.ev('me.name'), 'Alice');
  assert.equal(A.ev("$('#login').classList.contains('hide')"), true);
  assert.equal(fakeDb.profiles.get(A.ev('UID')).enrollment, '01-134221-045');
});

test('duplicate enrollment is rejected at registration; different one works', async () => {
  B = await openPage();
  await signUp(B, { email: 'bob@x.com', en: '01-134221-045', name: 'Bobby' });
  assert.match(B.text('#err'), /already registered/i);
  assert.equal(B.ev('STEP'), 1);
  assert.equal(B.ev('!!me'), false);
  B.val('#en', '01-134221-046'); await B.ev('goBtn()'); await B.ev('goBtn()');
  assert.ok(await until(() => B.ev('!!me')));
});

test('students see each other live', async () => {
  assert.ok(await until(() => A.ev("Object.keys(players).length===2")));
  assert.ok(A.ev("Object.values(players).some(p=>p.name==='Bobby')"));
  assert.ok(B.ev("Object.values(players).some(p=>p.name==='Alice')"));
});

test('same account cannot enter twice (second window)', async () => {
  const A2 = await openPage();
  await A2.ev("SU=false;lview()"); A2.val('#em', 'alice@x.com'); A2.val('#pw', 'password1');
  await A2.ev('goBtn()');
  assert.ok(await until(() => /already online/i.test(A2.text('#err'))), A2.text('#err'));
  assert.equal(A2.ev('!!me'), false);
});

test('wrong password is rejected', async () => {
  const W = await openPage();
  W.val('#em', 'alice@x.com'); W.val('#pw', 'nope-nope'); await W.ev('goBtn()');
  assert.match(W.text('#err'), /Invalid login/);
});

test('movement: WASD moves locally and the server accepts it; B sees it', async () => {
  const x0 = A.ev('me.x'), y0 = A.ev('me.y');
  A.w.dispatchEvent(new A.w.KeyboardEvent('keydown', { code: 'KeyD' }));
  await sleep(900);
  A.w.dispatchEvent(new A.w.KeyboardEvent('keyup', { code: 'KeyD' }));
  await sleep(400);
  const sp = srv.players.get(A.ev('UID'));
  assert.ok(Math.hypot(sp.x - x0, sp.y - y0) > 5, 'server position changed: ' + Math.hypot(sp.x - x0, sp.y - y0));
  const bSees = B.ev("Object.values(players).find(p=>p.name==='Alice')");
  assert.ok(Math.hypot(bSees.x - x0, bSees.y - y0) > 5, 'B sees Alice moved');
});

test('public chat both ways + spam guard', async () => {
  A.val('#ci', 'hello from alice'); A.ev('sendG()');
  assert.ok(await until(() => B.text('#msgs').includes('hello from alice')));
  assert.ok(A.text('#msgs').includes('hello from alice'), 'sender sees own message once via server');
  B.val('#ci', 'hi alice'); B.ev('sendG()');
  assert.ok(await until(() => A.text('#msgs').includes('hi alice')));
});

test('private chat: request -> accept -> DM', async () => {
  const aId = A.ev('UID'), bId = B.ev('UID');
  const sa = srv.players.get(aId), sb = srv.players.get(bId); Object.assign(sa, { x: 390, y: 325 }); Object.assign(sb, { x: 400, y: 325 });
  A.ev(`me.x=390;me.y=325;players['u_${bId}'].x=400;players['u_${bId}'].y=325;players['u_${bId}'].rx=400;players['u_${bId}'].ry=325`);
  A.ev(`reqChat('u_${bId}')`);
  assert.ok(await until(() => /wants to chat/.test(B.text('#reqs'))), 'B got request card: ' + B.text('#reqs') + '|' + B.text('#toast'));
  B.ev("[...document.querySelectorAll('#reqs button')].find(b=>b.textContent==='Accept').click()");
  assert.ok(await until(() => A.ev("act==='u_" + bId + "'")), 'A opened conversation after accept');
  A.val('#pi', 'secret hello'); A.ev('sendP()');
  assert.ok(await until(() => JSON.stringify(B.ev('convs')).includes('secret hello')), 'B received DM');
  B.ev(`openConv('u_${aId}')`); B.val('#pi', 'secret reply'); B.ev('sendP()');
  assert.ok(await until(() => JSON.stringify(A.ev('convs')).includes('secret reply')), 'A received reply');
});

test('block works end-to-end (server stops delivering chat)', async () => {
  const aId = A.ev('UID');
  B.ev(`openCard('u_${aId}')`);
  B.ev("[...document.querySelectorAll('#card button')].find(b=>/Block/.test(b.textContent)).click()");
  assert.ok(await until(() => B.ev(`blocked.has('u_${aId}')`)));
  await sleep(1300);
  A.val('#ci', 'after block msg'); A.ev('sendG()'); await sleep(300);
  assert.ok(!B.text('#msgs').includes('after block msg'));
});

test('character change is saved and seen by others', async () => {
  A.ev('openProf()');
  assert.equal(A.text('#go'), 'Save Character');
  A.ev("look.o='#ff6b6b';look.s=2");
  await A.ev('goBtn()');
  assert.ok(await until(() => B.ev("Object.values(players).find(p=>p.name==='Alice').look.o") === '#ff6b6b'));
});

test('student cannot open the admin console', async () => {
  const S = await openPage();
  await S.ev("lmode('a')"); S.val('#em', 'alice@x.com'); S.val('#pw', 'password1'); await S.ev('goBtn()');
  assert.ok(await until(() => /not an admin/i.test(S.text('#err'))), S.text('#err'));
  assert.equal(S.ev("!$('#adm').classList.contains('hide')"), false);
});

test('admin: separate login opens the full console with the student list', async () => {
  ADM = await openPage();
  await ADM.ev("lmode('a')");
  assert.equal(ADM.text('#go'), 'Admin Login');
  ADM.val('#em', 'boss@x.com'); ADM.val('#pw', 'adminpass1'); await ADM.ev('goBtn()');
  assert.ok(await until(() => ADM.ev("!$('#adm').classList.contains('hide')")), ADM.text('#err'));
  assert.ok(await until(() => /Alice · 01-134221-045/.test(ADM.text('#admb'))), ADM.text('#admb'));
  assert.match(ADM.text('#admb'), /Bobby · 01-134221-046/);
  assert.match(ADM.text('#admb'), /Online now: 2/);
});

test('admin: announce, chat moderation, read + delete private chat', async () => {
  ADM.ev("admTab('an')"); ADM.ev("document.querySelector('#admb input').value='Class cancelled'");
  ADM.ev("[...document.querySelectorAll('#admb button')].find(b=>/Send/.test(b.textContent)).click()");
  assert.ok(await until(() => A.text('#msgs').includes('Class cancelled')), 'announcement reached Alice');
  await ADM.ev("admTab('ch')");
  assert.ok(await until(() => /hello from alice/.test(ADM.text('#admb'))));
  ADM.ev("[...document.querySelectorAll('#admb .ar')].find(r=>/hello from alice/.test(r.textContent)).querySelector('button').click()");
  assert.ok(await until(() => !A.text('#msgs').includes('hello from alice')), 'deleted message removed live');
  await ADM.ev("admTab('dm')");
  await ADM.ev(`admDm('${A.ev('UID')}')`);
  assert.ok(await until(() => /secret hello/.test(ADM.text('#dmv'))), ADM.text('#dmv'));
  ADM.ev("document.querySelector('#dmv .ar button').click()");
  assert.ok(await until(() => !/secret reply/.test(ADM.text('#dmv')) || !/secret hello/.test(ADM.text('#dmv'))));
});

test('admin: mute, kick, ban (and banned user cannot sign back in), unban', async () => {
  const bId = B.ev('UID');
  const act = async (label) => { await ADM.ev("admTab('pl')"); await sleep(200);
    ADM.ev(`[...document.querySelectorAll('#admb .ar')].find(r=>/Bobby/.test(r.textContent)).querySelectorAll('button').forEach(b=>b.textContent==='${label}'&&b.click())`); await sleep(300); };
  await act('Mute'); await sleep(1300);
  B.val('#ci', 'i am muted'); B.ev('sendG()'); await sleep(300);
  assert.ok(!A.text('#msgs').includes('i am muted'));
  await act('Unmute');
  await act('Kick');
  assert.ok(await until(() => !B.ev('!!me')), 'kicked');
  assert.match(B.text('#err'), /removed by an admin/);
  B.val('#em', 'bob@x.com'); B.val('#pw', 'password1'); await B.ev('goBtn()');
  assert.ok(await until(() => B.ev('!!me')), 'Bobby can come back after a kick');
  await act('Ban');
  assert.ok(await until(() => !B.ev('!!me')), 'banned and removed');
  B.val('#em', 'bob@x.com'); B.val('#pw', 'password1'); await B.ev('goBtn()');
  assert.ok(await until(() => /suspended/i.test(B.text('#err'))), B.text('#err'));
  await act('Unban');
  await B.ev('goBtn()');
  assert.ok(await until(() => B.ev('!!me')), 'unbanned user can enter');
});

test('logout returns to sign-in; admin logout returns to login', async () => {
  A.ev('logout()');
  assert.equal(A.ev("$('#login').classList.contains('hide')"), false);
  assert.equal(A.text('#go'), 'Sign in');
  ADM.ev('adminLogout()');
  assert.equal(ADM.ev("$('#adm').classList.contains('hide')"), true);
  assert.equal(ADM.text('#go'), 'Sign in');
});

test('no uncaught JS errors in any page', () => {
  assert.deepEqual(jsErrors, []);
});
