# CAMPUS WORLD – HANDOFF CAPSULE #2 (supersedes CAMPUS_WORLD_HANDOFF.md)
You are taking over an in-progress project. Read this fully, then work from the attached files. **Do NOT rebuild from scratch. Make targeted edits only.**

## 0. User & communication
- User writes Roman Urdu (Urdu in Latin letters) + English. **Reply in Roman Urdu**, short, friendly, honest.
- User owns the product (Super Admin). Product is for **Bahria University H-11, Islamabad**.
- Be honest: never claim something works unless it was tested; say exactly what was and was not tested. User tends to say "kro/kru kru" = go ahead, and expects you to just do it.
- Files the user must re-upload to the new account (the new account has NO access to the old chat, artifact or /tmp):
  `campus-world-project.zip` (contains campus-world-server/, web/, dev-tools/, campus-world.html and this file). Unzip, then `cd campus-world-server && npm install && npm test`.

## 1. Product
"Campus World" = Module 1 of a larger campus app (future modules NOT to build now: Student Connect, Campus Bites, Student Rentals, Campus Requests). Multiplayer 2D isometric game of the university: each student controls a chibi avatar, sees others live, Global Chat, private chat requests when near someone. No GPS (removed permanently).

## 2. Three parts right now (all in the attached files)
### A) `campus-world.html` – single-file Canvas-2D isometric client, currently an **Artifact** (claude.ai runtime backend)
- Iso projection `P(x,y,z)`; +x screen right-down, +y left-down. World 760×540. `free(x,y)` collision (bounds, building rects B inflated 5, trees r=7, parked cars). Walk 105, run 170 units/s. `NEAR=75`.
- Runtime backend (only works inside claude.ai Artifact): `db` rules `students` read view/write admin, `students/{self}` write interact, `enroll` read view/write interact, `bans` read view/write admin, `chat` & `inbox` read view/write interact; `user`; `room` topics `{m:"interact"}` (topic `a` is admin-only by default = used for kick/announce). Platform rule: a rule's read level may not exceed its write level.
- **Login system (done, tested only on a fake runtime):** login box has Student | Admin tabs. Student sign-up = step 1 enrollment no. + name + age (enrollment unique via `enroll/<lowercase>` doc), step 2 choose character, then Enter. Legacy profiles without enrollment are asked to complete registration. Returning: "Continue as <name>". Admin tab → `adminLogin()` → only if `user.isOwner()||canEdit()` → separate **full-screen Admin Console** (Students list with enrollment/age/online, Ban/Mute/Kick/Reset, Public chat, Private chats, Announce, Logout). No admin button inside the game. Admin presence list comes from room `s` messages (`ONL`), admin sends `hello` every 3 s.
- Security fixes already in: kick/announce go on admin-only topic `a`; room messages checked against vouched sender id (`s.by`).
- Key functions: `prefill/lview/lmode/goBtn/enter/logout/openProf`, `startSession/stopSession`, `startAdmin/stopAdmin/adminLogin/adminLogout`, `admTab/admDm/setBan`, `sendA`, `dbChat`, `dmSend`, `saveProf`.
- Map (keep EXACT, user insisted twice): Iqbal Block x150–265,y290–410 ring w/ courtyard; **Jinnah Block flush on Iqbal's -x side** (x50–150, y290–410, spine x120–150, courtyard opens toward -x); Ayesha Hostel x80–190,y30–125; football x255–360,y15–100; basketball x265–350,y115–195; cricket oval (495,215) r125; parking x430–645,y345–460; main gate x620–680,y468–494; roads left x4–34, bottom y495–529, right x698–728. 19 building rects total (see `src/map.js`).

### B) `campus-world-server/` – REAL backend (Node 20+, ESM, Socket.IO 4, Supabase) – written this session (+ `look` event, admin `chat:list`/`student:resetLook`, `profiles.look` column)
- `supabase/schema.sql` (parses as valid PostgreSQL via pglast; NOT run on a real Supabase project): tables characters, profiles (enrollment unique on upper()), chat_messages, dm_messages, blocks, audit_log; `is_admin()`, trigger `protect_profile` (students can't change role/status/muted/enrollment), RLS (DMs readable only by the 2 participants + admins; no client write policies for chat/DM).
- `src/server.js` (`createServer({store,port,origins})`): JWT auth middleware (profile read from DB), one avatar per account (`ALREADY_ONLINE`), authoritative movement (`move` → distance-budget speed check + `isFree()`; violation → `correct {x,y}`), 10 Hz batched `state`, `chat:global` (sanitise, 200 chars, 1 msg/1.2 s, mute), request→accept→`dm:send` (range `NEAR*1.6`, 20 s cooldown, 30 s TTL), block/unblock, `/admin` namespace (role checked in DB; students:list, student:ban/mute/kick/approve, announce, chat:delete/clear, dm:read/delete; audit log).
- `src/store.js`: `supabaseStore()` and `devStore()` (in-memory; `DEV_MODE=1`, tokens `dev:<id>:<name>:<student|admin>`). `src/map.js` generated from the client's real collision data.
- Tests: `test/server.test.js` (14, real socket.io-client) + `test/web.test.js` (18, real `web/index.html` in jsdom vs real server, Supabase auth/profiles FAKED). **32/32 pass, 3/3 runs.** Run `npm i && npm test` in a normal dir (claude.ai outputs dir can't hold node_modules – symlink error; `web/` must be a sibling folder of `campus-world-server/`).
- `client/net.js`: older adapter sketch (superseded by web/index.html). `README.md` has protocol + setup + limitations.

### C) `web/index.html` + `web/config.js` – hostable static front-end (NEW, generated from campus-world.html by replacing only login/network/admin code; game rendering/map/UI untouched)
- Student tab: Sign in | Sign up (email, password ≥8, enrollment, name 2–14, age 15–60 → step 2 character → create account & enter). Resume: if a Supabase session exists → "Continue as <name>". Admin tab: separate login → full-screen Admin Console (Students: Approve/Ban/Mute/Kick/Reset avatar; Public chat; Private chats; Announce) over Socket.IO `/admin`; server checks `profiles.role='admin'`. Student with admin tab → "not an admin".
- Internal game messages kept (`bc.onmessage` types s/c/req/res/pm/ann); socket events are translated in `wire(S)`; ids: game uses `'u_'+uid`, server uses raw uid. `send()` translates `s`→`move`/`emote`, `req`→`req:send`, `res`→`req:reply`.
- Config: `web/config.js` (SUPABASE_URL, SUPABASE_ANON_KEY, SERVER_URL). CDN: supabase-js 2.45.4, socket.io-client 4.7.5 (jsdelivr, UMD).
- Rebuild script idea: `build_web.py` + `net_block.js` were in /tmp (lost); edit web/index.html directly from now on.

## 3. STATUS / what is verified
- Artifact client (A): 42 checks on a jsdom fake runtime; never on real claude.ai. It is now LEGACY – superseded by `web/`.
- Server (B) + web (C): 32 automated tests pass (see above). **Not verified:** real Supabase (schema run, JWT verify, RLS, trigger `protect_profile`), deployment, real browser (layout, mobile joystick, canvas), CDN script loading, email-confirmation flow, remaining Artifact-era features (e.g. Settings reset avatar, nearby list) beyond what tests touch.
- User has NOT yet created a Supabase project, deployed the server, or hosted `web/`.

## 4. NEXT TASKS (in order)
1. **Walk the user through go-live** (they are in Pakistan, non-developer, Roman Urdu): Supabase project (Auth→Email; run `supabase/schema.sql`; copy URL/anon/service keys) → deploy server (Render/Railway; env vars; `CLIENT_ORIGIN`) → fill `web/config.js` → host `web/` (Netlify/Vercel drag-and-drop) → sign up once → make first admin via SQL (`update public.profiles set role='admin' ...`) → test with 2 real accounts on 2 devices. Fix whatever fails (likely first-run issues: trigger/auth.role(), CORS/CLIENT_ORIGIN, email confirmation setting, WebSocket on host).
2. Registration approval (default status 'pending') + admin character manager (CRUD on `characters`, sign-up step 2 reading enabled characters) + reported/blocked users list; DM history load on login.
3. Map accuracy vs satellite image (ask which building/ground is off), mobile UX check, day-night, performance, PROJECT_STATUS.md, XP/levels.
4. Later: modular React+TS+Phaser per original structure `src/modules/campus-world/{game,maps,characters,movement,collisions,interactions,global-chat,private-chat}`, Redis adapter for scaling.

## 5. KNOWN LIMITATIONS (be honest)
Admins can read private chats (by design; mention privacy notice). Enrollment numbers are not verified against a university list. Server validates speed+collision but not walk-vs-run; single server instance; request pairs only in memory. Artifact version: DM privacy/ban/mute are client-side only. Bots (demo) are local per tab.

## 6. Original rules from the user (still apply)
Never show a blank screen; every visible control must do something; don't claim real multiplayer works until independently verified; server must validate movement, prevent duplicate sessions, interpolate remote players, avoid per-frame DB writes; after each phase run/test, fix, document in PROJECT_STATUS.md; don't rebuild everything when new requirements arrive – extend.

## 7. Working notes for the new account
- If the new Claude has the Artifact tool and the old artifact link is not accessible, publish `campus-world.html` as a new Artifact with capabilities: db rules above, `user:{}`, `room:{topics:{m:"interact"}}`. Edit published pages with Artifact `action:"edit"` (old_str/new_str) instead of rewriting.
- Published-page rules: single self-contained file, scripts only from cdnjs/jsdelivr/tailwind/jquery (pinned versions ≥2 weeks old), no other network, no localStorage assumptions beyond try/catch, typographic apostrophes in visible text.
- To test page logic: `dev-tools/` (jsdom + fake runtime). To test server: `npm test`.
