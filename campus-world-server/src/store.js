// Data layer. Two implementations behind one interface:
//   - supabaseStore: real auth + Postgres (production)
//   - devStore:      in-memory, for local testing without Supabase (DEV_MODE=1, never in production)
import { createClient } from '@supabase/supabase-js';

const DEFAULT_LOOK = { s: 1, h: 1, o: '#4f7cff' };

export async function makeStore() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return supabaseStore();
  if (process.env.DEV_MODE === '1' && process.env.NODE_ENV !== 'production') {
    console.warn('[store] DEV_MODE: in-memory data, fake tokens. NOT for production.');
    return devStore();
  }
  throw new Error('Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or DEV_MODE=1 for local testing).');
}

// ───────────────────────────── Supabase ─────────────────────────────
function supabaseStore() {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const ok = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  const pair = (a, b) =>
    `and(sender_id.eq.${a},recipient_id.eq.${b}),and(sender_id.eq.${b},recipient_id.eq.${a})`;

  return {
    async verify(token) {
      if (!token || typeof token !== 'string') return null;
      const { data, error } = await sb.auth.getUser(token);   // validates the JWT with Supabase
      return error || !data?.user ? null : { id: data.user.id };
    },
    async getProfile(id) {
      const d = ok(await sb.from('profiles')
        .select('id,name,enrollment,age,role,status,muted,look,characters(look)').eq('id', id).maybeSingle());
      return d && { ...d, look: d.look || d.characters?.look || DEFAULT_LOOK, characters: undefined };
    },
    async listProfiles() {
      return ok(await sb.from('profiles').select('id,name,enrollment,age,role,status,muted,created_at').order('created_at'));
    },
    async setStatus(id, status) { ok(await sb.from('profiles').update({ status }).eq('id', id)); },
    async setMuted(id, muted)   { ok(await sb.from('profiles').update({ muted }).eq('id', id)); },
    async setLook(id, look)     { ok(await sb.from('profiles').update({ look }).eq('id', id)); },

    async recentChat(n = 50) {
      const d = ok(await sb.from('chat_messages').select('id,sender_id,name,look,text,created_at')
        .order('created_at', { ascending: false }).limit(n));
      return d.reverse().map(row);
    },
    async addChat({ sender_id, name, look, text }) {
      return row(ok(await sb.from('chat_messages').insert({ sender_id, name, look, text }).select().single()));
    },
    async deleteChat(id) { ok(await sb.from('chat_messages').delete().eq('id', id)); },
    async clearChat()    { ok(await sb.from('chat_messages').delete().gt('id', 0)); },

    async addDM({ from, to, text }) {
      return dmRow(ok(await sb.from('dm_messages').insert({ sender_id: from, recipient_id: to, text }).select().single()));
    },
    async listDM(a, b) {                       // b optional: all DMs of student a
      const q = sb.from('dm_messages').select('*').order('created_at').limit(200);
      const d = ok(await (b ? q.or(pair(a, b)) : q.or(`sender_id.eq.${a},recipient_id.eq.${a}`)));
      return d.map(dmRow);
    },
    async deleteDM(id) { ok(await sb.from('dm_messages').delete().eq('id', id)); },

    async getBlocks(id) { return ok(await sb.from('blocks').select('blocked').eq('blocker', id)).map(r => r.blocked); },
    async addBlock(blocker, blocked)    { ok(await sb.from('blocks').upsert({ blocker, blocked })); },
    async removeBlock(blocker, blocked) { ok(await sb.from('blocks').delete().match({ blocker, blocked })); },

    async audit(admin_id, action, payload) { await sb.from('audit_log').insert({ admin_id, action, payload }); },
  };
}
const row = r => ({ id: String(r.id), sid: r.sender_id, name: r.name, look: r.look, text: r.text, ts: Date.parse(r.created_at) });
const dmRow = r => ({ id: String(r.id), from: r.sender_id, to: r.recipient_id, text: r.text, ts: Date.parse(r.created_at) });

// ───────────────────────────── Dev (in-memory) ─────────────────────────────
function devStore() {
  const profiles = new Map(), blocks = new Map(), enrolled = new Set();
  let chat = [], dms = [], seq = 1;
  return {
    // token format:  dev:<id>:<name>:<student|admin>
    async verify(token) {
      const [k, id, name, role] = String(token || '').split(':');
      if (k !== 'dev' || !id) return null;
      if (!profiles.has(id)) {
        profiles.set(id, { id, name: name || id, enrollment: 'DEV-' + id, age: 20, role: role === 'admin' ? 'admin' : 'student',
                           status: 'approved', muted: false, look: DEFAULT_LOOK });
        enrolled.add('DEV-' + id);
      }
      return { id };
    },
    async getProfile(id) { const p = profiles.get(id); return p && { ...p }; },
    async listProfiles() { return [...profiles.values()].map(p => ({ ...p })); },
    async setStatus(id, status) { profiles.get(id).status = status; },
    async setMuted(id, muted)   { profiles.get(id).muted = muted; },
    async setLook(id, look)     { profiles.get(id).look = look; },
    _seed(p) { profiles.set(p.id, { age: 20, status: 'approved', muted: false, role: 'student', look: DEFAULT_LOOK, ...p }); },   // tests only
    async recentChat(n = 50) { return chat.slice(-n); },
    async addChat({ sender_id, name, look, text }) {
      const m = { id: String(seq++), sid: sender_id, name, look, text, ts: Date.now() }; chat.push(m); return m;
    },
    async deleteChat(id) { chat = chat.filter(m => m.id !== String(id)); },
    async clearChat() { chat = []; },
    async addDM({ from, to, text }) { const m = { id: String(seq++), from, to, text, ts: Date.now() }; dms.push(m); return m; },
    async listDM(a, b) { return dms.filter(m => b ? (m.from === a && m.to === b) || (m.from === b && m.to === a) : m.from === a || m.to === a); },
    async deleteDM(id) { dms = dms.filter(m => m.id !== String(id)); },
    async getBlocks(id) { return [...(blocks.get(id) || [])]; },
    async addBlock(a, b)    { (blocks.get(a) || blocks.set(a, new Set()).get(a)).add(b); },
    async removeBlock(a, b) { blocks.get(a)?.delete(b); },
    async audit() {},
  };
}
