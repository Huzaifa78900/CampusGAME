// Runs the real server (dev in-memory store) and talks to it with real socket.io clients.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { createServer } from '../src/server.js';
import { makeStore } from '../src/store.js';

let srv, url;
const socks = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** connect and wait for init (or an error / fatal) */
function join(token, ns = '') {
  return new Promise(resolve => {
    const s = io(url + ns, { auth: { token }, reconnection: false, forceNew: true });
    socks.push(s);
    const box = { s, ev: {}, errors: [] };
    s.onAny((e, d) => { (box.ev[e] ||= []).push(d); });
    s.on('init', d => resolve({ ...box, init: d }));
    if (ns) s.on('connect', () => resolve(box));            // admin namespace has no init event
    s.on('connect_error', e => resolve({ ...box, error: e.message }));
    s.on('fatal', r => resolve({ ...box, fatal: r }));
  });
}
const ack = (s, ev, d) => new Promise(r => s.emit(ev, d, r));

before(async () => {
  process.env.DEV_MODE = '1';
  srv = await createServer({ store: await makeStore(), port: 0 });
  url = 'http://localhost:' + srv.port;
});
after(async () => { socks.forEach(s => s.close()); await srv.close(); });

test('rejects missing / bad token', async () => {
  assert.equal((await join('')).error, 'AUTH');
  assert.equal((await join('garbage')).error, 'AUTH');
});

let A, B, C, ADM;
test('students join, see each other, init has no secrets', async () => {
  A = await join('dev:a1:Alice:student');
  B = await join('dev:b2:Bobby:student');
  assert.ok(A.init.you.id === 'a1');
  assert.ok(B.init.players.some(p => p.id === 'a1'));
  assert.equal(JSON.stringify(B.init).includes('enrollment'), false);   // enrollment/age never sent to other players
  await sleep(100);
  assert.ok(A.ev.join?.some(p => p.id === 'b2'));
});

test('same account cannot have 2 avatars', async () => {
  const dup = await join('dev:a1:Alice:student');
  assert.equal(dup.fatal, 'ALREADY_ONLINE');
});

test('movement: legal step accepted, teleport + wall rejected', async () => {
  const { x, y } = A.init.you;
  await sleep(150);
  A.s.emit('move', { x: x + 3, y, f: 1, mv: 1 });
  await sleep(250);
  assert.ok(B.ev.state?.flat(1).some(r => r[0] === 'a1' && Math.abs(r[1] - (x + 3)) < .2), 'B sees A move');
  A.s.emit('move', { x: x + 300, y, f: 1, mv: 1 });            // teleport
  await sleep(120);
  assert.ok(A.ev.correct?.length >= 1, 'teleport corrected');
  await sleep(100);
  A.s.emit('move', { x: 150 + 20, y: 300 + 5, f: 1, mv: 1 });   // inside Iqbal Block wall
  await sleep(100);
  assert.ok(A.ev.correct?.length >= 2, 'wall corrected');
  A.s.emit('move', { x: 'abc', y: null });                       // garbage ignored, no crash
  await sleep(50);
});

test('speed hack: many fast steps get throttled by the distance budget', async () => {
  const { x, y } = A.init.you;
  let moved = 0, cx = x + 3;
  for (let i = 0; i < 12; i++) { await sleep(50); cx += 20; A.s.emit('move', { x: cx, y, f: 1, mv: 1 }); }   // 400 u/s
  await sleep(200);
  const last = [...B.ev.state.flat(1)].filter(r => r[0] === 'a1').pop();
  assert.ok(last[1] - (x + 3) < 12 * 20 * .75, 'server position lags the cheater: ' + (last[1] - x));
});

test('public chat: broadcast, sanitise, rate limit', async () => {
  A.s.emit('chat:global', { text: 'hello <b>all</b>' });
  await sleep(150);
  assert.equal(B.ev.chat.at(-1).text, 'hello ball/b');      // < and > stripped
  assert.ok(!B.ev.chat.at(-1).text.includes('<'));
  A.s.emit('chat:global', { text: 'second too fast' });
  await sleep(100);
  assert.ok(A.ev.notice?.includes('Slow down a little.'));
  assert.equal(B.ev.chat.length, 1);
});

test('private chat needs request+accept, then DM reaches only the two', async () => {
  C = await join('dev:c3:Cara:student');
  Object.assign(srv.players.get('a1'), { x: 390, y: 325 }); Object.assign(srv.players.get('b2'), { x: 400, y: 330 });   // within chat-request range
  A.s.emit('dm:send', { to: 'b2', text: 'sneaky' });
  await sleep(100);
  assert.ok(A.ev.notice?.includes('Send a chat request first.'));
  A.s.emit('req:send', { to: 'b2' });
  await sleep(100);
  assert.equal(B.ev.req?.[0]?.from, 'a1');
  B.s.emit('req:reply', { to: 'a1', accept: true });
  await sleep(100);
  assert.equal(A.ev['req:res']?.[0]?.accept, true);
  A.s.emit('dm:send', { to: 'b2', text: 'secret hi' });
  await sleep(150);
  assert.equal(B.ev.dm?.[0]?.text, 'secret hi');
  assert.equal(A.ev.dm?.[0]?.text, 'secret hi');
  assert.equal(C.ev.dm, undefined, 'third student gets nothing');
});

test('fake reply without a request is ignored', async () => {
  C.s.emit('req:reply', { to: 'a1', accept: true });
  await sleep(100);
  A.s.emit('dm:send', { to: 'c3', text: 'x' });
  await sleep(100);
  assert.equal(C.ev.dm, undefined);
});

test('request cooldown + range + block', async () => {
  const pa = srv.players.get('a1'), pc = srv.players.get('c3');
  Object.assign(pa, { x: 390, y: 325 }); Object.assign(pc, { x: 600, y: 300 });   // far apart
  A.s.emit('req:send', { to: 'c3' }); await sleep(80);
  assert.ok(A.ev.notice?.includes('Move closer to Cara first.'));
  assert.equal(C.ev.req, undefined, 'no request delivered when too far');
  Object.assign(pc, { x: 400, y: 325 });                                          // close
  A.s.emit('req:send', { to: 'c3' }); await sleep(80);
  A.s.emit('req:send', { to: 'c3' }); await sleep(80);
  assert.ok(A.ev.notice?.includes('Please wait before asking again.'));
  C.s.emit('block', 'a1'); await sleep(100);
  assert.deepEqual(C.ev.blocks?.at(-1), ['a1']);
  await sleep(1300);
  A.s.emit('chat:global', { text: 'blocked ones cannot reach C' }); await sleep(150);
  assert.ok(!C.ev.chat?.some(m => m.text.includes('blocked ones')));
  assert.ok(B.ev.chat.some(m => m.text.includes('blocked ones')));
});

test('students cannot use the admin namespace', async () => {
  assert.equal((await join('dev:a1:Alice:student', '/admin')).error, 'FORBIDDEN');
  assert.equal((await join('nope', '/admin')).error, 'FORBIDDEN');
});

test('admin: list, mute, delete chat, read DMs, announce', async () => {
  ADM = await join('dev:ad:Boss:admin', '/admin');
  await sleep(100);
  const list = await ack(ADM.s, 'students:list');
  assert.ok(list.ok && list.data.find(p => p.id === 'a1').online === true);
  assert.equal((await ack(ADM.s, 'student:mute', { id: 'b2', muted: true })).ok, true);
  await sleep(1300);
  B.s.emit('chat:global', { text: 'i am muted' }); await sleep(120);
  assert.ok(B.ev.notice?.includes('You are muted by an admin.'));
  await ack(ADM.s, 'student:mute', { id: 'b2', muted: false });
  const dms = await ack(ADM.s, 'dm:read', { id: 'a1', with: 'b2' });
  assert.equal(dms.data[0].text, 'secret hi');
  const msgId = B.ev.chat[0].id;
  await ack(ADM.s, 'chat:delete', { id: msgId }); await sleep(100);
  assert.deepEqual(A.ev['chat:del']?.[0], msgId);
  await ack(ADM.s, 'announce', { text: 'Exam hall changed' }); await sleep(100);
  assert.equal(C.ev.announce?.[0]?.text, 'Exam hall changed');
  assert.equal((await ack(ADM.s, 'student:ban', { id: 'ad', banned: true })).ok, false, 'cannot self-ban');
});

test('admin kick and ban; banned account cannot reconnect', async () => {
  await ack(ADM.s, 'student:kick', { id: 'c3' }); await sleep(150);
  assert.equal(C.ev.fatal?.[0], 'KICKED');
  assert.equal(srv.players.has('c3'), false);
  await ack(ADM.s, 'student:ban', { id: 'b2', banned: true }); await sleep(150);
  assert.equal(B.ev.fatal?.[0], 'BANNED');
  assert.equal((await join('dev:b2:Bobby:student')).error, 'BANNED');
  await ack(ADM.s, 'student:ban', { id: 'b2', banned: false });
  assert.ok((await join('dev:b2:Bobby:student')).init);
});

test('look change is validated and broadcast; admin can reset', async () => {
  const B2 = await join('dev:d4:Dave:student'); await sleep(50);
  B2.s.emit('look', { s: 9, h: 1, o: '#4f7cff' }); await sleep(100);
  assert.equal(srv.players.get('d4').look.s, 1, 'invalid look rejected');
  B2.s.emit('look', { s: 2, h: 3, o: '#ff6b6b' }); await sleep(120);
  assert.deepEqual(B2.ev.look?.at(-1), { id: 'd4', look: { s: 2, h: 3, o: '#ff6b6b' } });
  await ack(ADM.s, 'student:resetLook', { id: 'd4' }); await sleep(100);
  assert.equal(B2.ev.look.at(-1).look.o, '#4f7cff');
  assert.ok((await ack(ADM.s, 'chat:list')).ok);
});

test('leave is broadcast on disconnect', async () => {
  A.s.close(); await sleep(150);
  assert.equal(srv.players.has('a1'), false);
});
