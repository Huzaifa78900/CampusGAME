// Sketch of the browser adapter that replaces the Artifact `room`/`db` code. NOT TESTED in a browser yet.
// Needs (via <script> or bundler): @supabase/supabase-js, socket.io-client.
import { createClient } from '@supabase/supabase-js';
import { io } from 'socket.io-client';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);   // anon key only – never the service key

export async function signUp({ email, password, enrollment, name, age, characterId }) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  const { error: e2 } = await supabase.from('profiles')
    .insert({ id: data.user.id, enrollment: enrollment.toUpperCase(), name, age, character_id: characterId });
  if (e2?.code === '23505') throw new Error('This enrollment number is already registered.');
  if (e2) throw e2;
}
export const signIn = (email, password) => supabase.auth.signInWithPassword({ email, password });

export async function connect(handlers, { admin = false } = {}) {
  const { data } = await supabase.auth.getSession();
  const socket = io(SERVER_URL + (admin ? '/admin' : ''), {
    auth: { token: data.session?.access_token }, reconnection: false,
  });
  socket.on('connect_error', e => handlers.onError?.(e.message));      // AUTH, BANNED, FORBIDDEN, ...
  socket.on('fatal', r => handlers.onFatal?.(r));                      // ALREADY_ONLINE, KICKED, BANNED
  for (const ev of ['init', 'join', 'leave', 'state', 'correct', 'chat', 'chat:del', 'chat:clear',
                    'announce', 'req', 'req:res', 'dm', 'blocks', 'notice'])
    socket.on(ev, d => handlers['on_' + ev.replace(':', '_')]?.(d));
  return {
    socket,
    move: (x, y, f, mv) => socket.emit('move', { x, y, f, mv }),       // call ~every 110 ms while moving
    chat: text => socket.emit('chat:global', { text }),
    requestChat: to => socket.emit('req:send', { to }),
    replyChat: (to, accept) => socket.emit('req:reply', { to, accept }),
    dm: (to, text) => socket.emit('dm:send', { to, text }),
    block: id => socket.emit('block', id),
    admin: (ev, payload) => new Promise(res => socket.emit(ev, payload, res)),   // e.g. admin('student:ban',{id,banned:true})
  };
}
