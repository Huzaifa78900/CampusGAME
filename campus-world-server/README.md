# Campus World – Server (Node + Socket.IO + Supabase)

Replaces the Artifact-runtime backend of `campus-world.html` with a real server.
**Status: server + schema + web front-end written. 32 automated tests pass (server 14 + page-vs-server 18, with dev store / fake Supabase).
NOT yet tested: a real Supabase project, deployment, a real browser.**

## What changed vs. the Artifact version
| Topic | Artifact (client-side) | This server |
|---|---|---|
| Login | claude.ai account, no password | Supabase Auth (email + password), JWT verified by the server |
| Admin | claude.ai Owner/Editor | `profiles.role = 'admin'`, checked in the DB on every `/admin` connection |
| Movement | trusted | server validates speed (distance budget) + collision (same map data as client) → `correct` event snaps cheaters back |
| Public chat | any client writes DB | only the server writes (length, sanitising, 1 msg/1.2 s, mute check) |
| Private chat | anyone could read all inboxes | RLS: only sender, recipient (and admins) can read; only the server writes; needs accepted request |
| Duplicate avatar | handshake between tabs | server refuses a 2nd connection for the same account (`ALREADY_ONLINE`) |
| Enrollment no. | client-side check | `unique(upper(enrollment))` in Postgres + format check; students cannot read other students' enrollment/age (never sent over the socket) |
| Self-promotion | possible in theory | DB trigger blocks students from changing role / status / muted / enrollment |

## 1. Supabase setup
1. Create a project at supabase.com. Authentication → Providers: enable **Email**. (Optionally turn on email confirmation.)
2. SQL Editor → paste `supabase/schema.sql` → Run.
3. Project Settings → API: copy **Project URL**, **anon key** (frontend) and **service_role key** (server only).
4. Sign up once from the front-end, then make yourself admin in the SQL editor:
   `update public.profiles set role='admin' where upper(enrollment)=upper('YOUR-ENROLLMENT');`
   (If the trigger reverts it: `alter table public.profiles disable trigger profiles_protect;` → run the update → `enable trigger`.)
5. Approval flow (optional): change the `status` default to `'pending'` in `schema.sql` (and the insert branch of `protect_profile`);
   admin approves with the `student:approve` event. Pending students get `PENDING_APPROVAL` on connect.

## 2. Run the server
```bash
cp .env.example .env        # fill SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLIENT_ORIGIN
npm install
npm start                   # http://localhost:3001/health
npm test                    # 32 tests, no Supabase needed (in-memory dev store + fake Supabase auth)
npm run dev                 # local server in DEV_MODE (fake tokens: dev:<id>:<name>:<student|admin>)
```
Deploy on any Node host (Render, Railway, Fly.io, a VPS). It needs a **persistent process with WebSocket support**
(not serverless functions). Set the same env vars; set `CLIENT_ORIGIN` to your frontend's exact URL.
Run **one** instance (player state is in memory). Scaling beyond ~a few hundred concurrent players needs the Redis adapter – later.

## 3. Socket.IO protocol
Connect: `io(SERVER_URL, { auth: { token: supabaseAccessToken } })` — admin: `io(SERVER_URL + '/admin', { auth: { token } })`.

**Server → client:** `init {you, players, chat, blocks}` · `join player` · `leave id` · `state [[id,x,y,f,mv,em],…]` (10 Hz, only changed) ·
`correct {x,y}` · `chat msg` · `chat:del id` · `chat:clear` · `announce {text}` · `req {from,name}` · `req:res {from,accept}` · `dm msg` ·
`blocks [ids]` · `notice text` · `fatal reason` (`ALREADY_ONLINE`, `KICKED`, `BANNED`).
Connect errors: `AUTH`, `NO_PROFILE`, `BANNED`, `PENDING_APPROVAL`, `TOO_MANY_CONNECTIONS`, `FORBIDDEN` (admin).

**Client → server:** `move {x,y,f,mv}` (≤ ~25/s, send ~every 110 ms while moving) · `emote name|null` · `chat:global {text}` ·
`req:send {to}` · `req:reply {to,accept}` · `dm:send {to,text}` · `block id` · `unblock id`.

**Admin (`/admin`, with ack callback `{ok,data|error}`):** `students:list` · `student:ban {id,banned}` · `student:mute {id,muted}` ·
`student:kick {id}` · `student:approve {id}` · `announce {text}` · `chat:delete {id}` · `chat:clear` · `dm:read {id,with?}` · `dm:delete {id}`.
Every admin action is written to `audit_log`.

## 4. Front-end (`../web/`) – now switched to this server
`web/index.html` is `campus-world.html` with the network layer replaced (rendering, map, characters, UI unchanged):
Supabase email+password login/sign-up (enrollment, name, age, character), Socket.IO for movement/chat/DM/requests/block,
and a separate **Admin login → full-screen Admin Console** on the `/admin` namespace.
1. Edit `web/config.js`: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (public anon key only), `SERVER_URL` (your deployed Node server).
2. Host the `web/` folder as a static site (Netlify / Vercel / GitHub Pages). It must NOT be a claude.ai Artifact (those can't reach your server).
3. Put that site's exact URL in the server's `CLIENT_ORIGIN`.
Tested: `test/web.test.js` runs the real page in jsdom against the real server (Supabase faked) – sign-up/sign-in, duplicate enrollment,
live players, movement, chat, request→accept→DM, block, character change, admin login/console, announce, moderation, mute/kick/ban/unban.
NOT tested: a real browser (layout, touch/joystick, canvas drawing), real Supabase, real CDN scripts loading.
Not carried over: demo bots, offline demo mode, DM history after re-login (only live DMs are shown), Settings→"Reset avatar" only changes the local look until saved.

## 5. Honest limitations
- Admins **can read private chats** (by design, same as before). Tell students in your privacy notice.
- Movement validation checks speed + collision, not "walk vs run" (a cheater can always move at run speed) and not moving platforms/cars.
- Chat-request pairs live in memory for the session; after a restart players must ask again (history stays in the DB).
- State is in one process; restart = everyone reconnects.
- Enrollment numbers are not verified against a university list (anyone can type a valid-format number first). Use admin approval + a CSV import of real enrollments if you need that.
- Demo bots from the Artifact are not part of the server.
- Rate limits are basic (per-socket timers, 8 sockets per IP). Add real DDoS protection (Cloudflare) in production.
- `schema.sql` parses as valid PostgreSQL but I could not run it against a real Supabase project.
