import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { makeStore } from './store.js';
import { isFree, SPAWN } from './map.js';

// ───────── Tunables (same numbers as the client) ─────────
const WALK = 105, RUN = 170;          // world units / second
const SPEED_TOL = 1.35;               // network jitter tolerance
const BUDGET_CAP = 60;                // max "stored" distance (stops bursts / teleports)
const NEAR = 75;                      // client's nearby radius
const REQ_RANGE = NEAR * 1.6;         // must be this close to send a private-chat request
const TICK_MS = 100;                  // world state broadcast rate (10 Hz)
const CHAT_GAP = 1200, DM_GAP = 400, REQ_COOLDOWN = 20_000, REQ_TTL = 30_000;
const EMOTES = new Set(['wave', 'dance', 'laugh', 'sit', 'celebrate']);
const OUTFITS = new Set(['#4f7cff', '#ff6b6b', '#34c38f', '#ffb100', '#a66bff', '#2fc4d9']);
const DEFAULT_LOOK = { s: 1, h: 1, o: '#4f7cff' };
const validLook = l => l && Number.isInteger(l.s) && l.s >= 0 && l.s <= 3 && Number.isInteger(l.h) && l.h >= 0 && l.h <= 4 && OUTFITS.has(l.o);

/** Create the server. Exported so tests can start it on a random port. */
export async function createServer({ store, port = 0, origins = ['*'] } = {}) {
  store = store || await makeStore();
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: origins }, maxHttpBufferSize: 1e4 });

  /** online players, keyed by user id */
  const players = new Map();
  const perIp = new Map();
  app.get('/health', (_req, res) => res.json({ ok: true, online: players.size }));

  // ───────── helpers ─────────
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const clean = (s, max) => typeof s === 'string'
    ? s.replace(/[\u0000-\u001f\u007f<>&]/g, '').trim().slice(0, max) : '';
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const pub = p => ({ id: p.id, name: p.name, look: p.look, x: p.x, y: p.y, f: p.f, mv: p.mv, em: p.em });
  const toUser = (p, ev, data) => io.to(p.sid).emit(ev, data);
  const kick = (id, reason) => {
    const p = players.get(id); if (!p) return;
    toUser(p, 'fatal', reason);
    io.sockets.sockets.get(p.sid)?.disconnect(true);
  };
  const findSpawn = () => {
    for (let i = 0; i < 200; i++) {
      const x = SPAWN.x + (Math.random() - .5) * 80, y = SPAWN.y + (Math.random() - .5) * 80;
      if (isFree(x, y) && ![...players.values()].some(o => Math.hypot(o.x - x, o.y - y) < 14)) return { x, y };
    }
    return { ...SPAWN };
  };

  // ───────── player authentication (every socket) ─────────
  io.use(async (sock, next) => {
    try {
      const ip = sock.handshake.address;
      if ((perIp.get(ip) || 0) >= 8) return next(new Error('TOO_MANY_CONNECTIONS'));
      const u = await store.verify(sock.handshake.auth?.token);
      if (!u) return next(new Error('AUTH'));
      const p = await store.getProfile(u.id);                // profile is read from the DB, never from the client
      if (!p) return next(new Error('NO_PROFILE'));
      if (p.status === 'banned') return next(new Error('BANNED'));
      if (p.status !== 'approved') return next(new Error('PENDING_APPROVAL'));
      sock.data.profile = p; sock.data.ip = ip;
      next();
    } catch (e) { console.error('[auth]', e.message); next(new Error('AUTH')); }
  });

  io.on('connection', async sock => {
    const prof = sock.data.profile, ip = sock.data.ip;
    perIp.set(ip, (perIp.get(ip) || 0) + 1);

    // one avatar per account
    if (players.has(prof.id)) { sock.emit('fatal', 'ALREADY_ONLINE'); sock.disconnect(true); return; }
    const sp = findSpawn(), now = Date.now();
    const me = {
      id: prof.id, sid: sock.id, name: prof.name, look: prof.look, muted: prof.muted,
      x: sp.x, y: sp.y, f: 1, mv: 0, em: null, dirty: false,
      budget: BUDGET_CAP, lastMove: now, last: {}, blocks: new Set(), pairs: new Set(),
      cool: new Map(), out: new Map(),
    };
    players.set(me.id, me);                                   // reserve the slot before any await
    try {
      (await store.getBlocks(me.id)).forEach(b => me.blocks.add(b));
      const chat = (await store.recentChat(50)).filter(m => !me.blocks.has(m.sid));
      sock.emit('init', {
        you: pub(me), players: [...players.values()].filter(o => o !== me).map(pub),
        chat, blocks: [...me.blocks],
      });
      sock.broadcast.emit('join', pub(me));
    } catch (e) { console.error('[init]', e.message); sock.disconnect(true); return; }

    const rl = (key, ms) => { const t = Date.now(); if (me.last[key] && t - me.last[key] < ms) return false; me.last[key] = t; return true; };
    const notice = t => sock.emit('notice', t);

    // ───── movement: client proposes, server decides ─────
    sock.on('move', d => {
      if (!d || !num(d.x) || !num(d.y)) return;
      const t = Date.now();
      if (t - me.lastMove < 40) return;                       // max ~25 updates/s
      const dt = Math.min((t - me.lastMove) / 1000, .5);
      me.lastMove = t;
      me.budget = Math.min(BUDGET_CAP, me.budget + dt * RUN * SPEED_TOL);
      const step = Math.hypot(d.x - me.x, d.y - me.y);
      if (step > me.budget || !isFree(d.x, d.y)) {            // too fast / inside a wall -> snap back
        return sock.emit('correct', { x: me.x, y: me.y });
      }
      me.budget -= step;
      me.x = d.x; me.y = d.y;
      me.f = d.f === -1 ? -1 : 1;
      me.mv = d.mv ? 1 : 0;
      if (me.mv) me.em = null;
      me.dirty = true;
    });
    sock.on('emote', name => {
      if (name !== null && !EMOTES.has(name)) return;
      if (!rl('emote', 500)) return;
      me.em = name; me.dirty = true;
    });

    // ───── avatar look (student changes own character) ─────
    sock.on('look', async l => {
      if (!validLook(l) || !rl('look', 2000)) return;
      const look = { s: l.s, h: l.h, o: l.o };
      try { await store.setLook(me.id, look); me.look = look; io.emit('look', { id: me.id, look }); } catch { notice('Could not save character.'); }
    });

    // ───── public chat ─────
    sock.on('chat:global', async d => {
      try {
        const text = clean(d?.text, 200);
        if (!text) return;
        if (me.muted) return notice('You are muted by an admin.');
        if (!rl('chat', CHAT_GAP)) return notice('Slow down a little.');
        const m = await store.addChat({ sender_id: me.id, name: me.name, look: me.look, text });
        for (const o of players.values()) if (!o.blocks.has(me.id)) toUser(o, 'chat', m);
      } catch (e) { console.error('[chat]', e.message); notice('Message failed.'); }
    });

    // ───── private chat: request -> accept -> DM ─────
    sock.on('req:send', d => {
      const o = players.get(d?.to);
      if (!o || o === me) return;
      if (o.blocks.has(me.id) || me.blocks.has(o.id)) return;
      if (me.pairs.has(o.id)) return sock.emit('req:res', { from: o.id, accept: true });
      if (dist(me, o) > REQ_RANGE) return notice('Move closer to ' + o.name + ' first.');
      const t = Date.now();
      if ((me.cool.get(o.id) || 0) > t) return notice('Please wait before asking again.');
      me.cool.set(o.id, t + REQ_COOLDOWN);
      me.out.set(o.id, t + REQ_TTL);
      toUser(o, 'req', { from: me.id, name: me.name });
    });
    sock.on('req:reply', d => {
      const o = players.get(d?.to);
      const exp = o?.out.get(me.id);
      if (!o || !exp || exp < Date.now()) return;             // only answers to a live request count
      o.out.delete(me.id);
      if (d.accept) { me.pairs.add(o.id); o.pairs.add(me.id); }
      toUser(o, 'req:res', { from: me.id, accept: !!d.accept });
    });
    sock.on('dm:send', async d => {
      try {
        const o = players.get(d?.to), text = clean(d?.text, 200);
        if (!text || !me.pairs.has(d.to)) return notice('Send a chat request first.');
        if (me.muted) return notice('You are muted by an admin.');
        if (!rl('dm', DM_GAP)) return notice('Slow down a little.');
        if (o?.blocks.has(me.id) || me.blocks.has(d.to)) return;
        const m = await store.addDM({ from: me.id, to: d.to, text });
        sock.emit('dm', m); if (o) toUser(o, 'dm', m);
      } catch (e) { console.error('[dm]', e.message); notice('Message failed.'); }
    });

    // ───── blocking ─────
    sock.on('block', async id => {
      if (typeof id !== 'string' || id === me.id) return;
      try { await store.addBlock(me.id, id); me.blocks.add(id); me.pairs.delete(id); sock.emit('blocks', [...me.blocks]); } catch (e) { notice('Could not block.'); }
    });
    sock.on('unblock', async id => {
      try { await store.removeBlock(me.id, id); me.blocks.delete(id); sock.emit('blocks', [...me.blocks]); } catch (e) { notice('Could not unblock.'); }
    });

    sock.on('disconnect', () => {
      perIp.set(ip, Math.max(0, (perIp.get(ip) || 1) - 1));
      if (players.get(me.id) === me) {
        players.delete(me.id);
        for (const o of players.values()) { o.pairs.delete(me.id); o.out.delete(me.id); }
        io.emit('leave', me.id);
      }
    });
  });

  // ───────── world tick: one batched update, only players that changed ─────────
  const tick = setInterval(() => {
    const out = [];
    for (const p of players.values()) if (p.dirty) {
      out.push([p.id, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, p.f, p.mv, p.em]);
      p.dirty = false;
    }
    if (out.length) io.emit('state', out);
  }, TICK_MS);

  // ───────── admin namespace: role is checked in the DB on every connection ─────────
  const adm = io.of('/admin');
  adm.use(async (sock, next) => {
    try {
      const u = await store.verify(sock.handshake.auth?.token);
      const p = u && await store.getProfile(u.id);
      if (!p || p.role !== 'admin' || p.status === 'banned') return next(new Error('FORBIDDEN'));
      sock.data.admin = p; next();
    } catch { next(new Error('FORBIDDEN')); }
  });
  adm.on('connection', sock => {
    const admin = sock.data.admin;
    const on = (ev, fn) => sock.on(ev, async (d, ack) => {
      try {
        const data = await fn(d || {});
        store.audit(admin.id, ev, d).catch(() => {});
        ack?.({ ok: true, data });
      } catch (e) { ack?.({ ok: false, error: String(e.message || e) }); }
    });
    const needId = d => { if (typeof d.id !== 'string' || !d.id) throw new Error('id required'); return d.id; };

    on('students:list', async () => (await store.listProfiles()).map(p => ({ ...p, online: players.has(p.id) })));
    on('student:ban', async d => {
      const id = needId(d);
      if (id === admin.id) throw new Error("You can't ban yourself.");
      await store.setStatus(id, d.banned ? 'banned' : 'approved');
      if (d.banned) kick(id, 'BANNED');
    });
    on('student:approve', async d => store.setStatus(needId(d), 'approved'));
    on('student:mute', async d => {
      const id = needId(d); await store.setMuted(id, !!d.muted);
      const p = players.get(id); if (p) p.muted = !!d.muted;
    });
    on('student:kick', async d => kick(needId(d), 'KICKED'));
    on('announce', async d => {
      const text = clean(d.text, 200); if (!text) throw new Error('Empty announcement');
      io.emit('announce', { text });
    });
    on('chat:delete', async d => { await store.deleteChat(needId(d)); io.emit('chat:del', d.id); });
    on('chat:clear', async () => { await store.clearChat(); io.emit('chat:clear'); });
    on('chat:list', async () => store.recentChat(100));
    on('student:resetLook', async d => {
      const id = needId(d); await store.setLook(id, DEFAULT_LOOK);
      const p = players.get(id); if (p) { p.look = DEFAULT_LOOK; io.emit('look', { id, look: DEFAULT_LOOK }); }
    });
    on('dm:read', async d => store.listDM(needId(d), typeof d.with === 'string' ? d.with : undefined));
    on('dm:delete', async d => store.deleteDM(needId(d)));
  });

  await new Promise(r => server.listen(port, r));
  return {
    io, server, players, port: server.address().port,
    close: () => new Promise(r => { clearInterval(tick); io.close(() => r()); }),
  };
}

// run directly: `npm start`
if (import.meta.url === `file://${process.argv[1]}`) {
  const origins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map(s => s.trim());
  const s = await createServer({ port: +process.env.PORT || 3001, origins });
  console.log(`Campus World server listening on :${s.port}`);
  process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
}
