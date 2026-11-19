-- Campus World – Supabase schema. Run once in: Supabase Dashboard -> SQL Editor.
-- Design rule: clients may only read what is theirs. All writes to chat/DMs/moderation
-- go through the Node server (service-role key, bypasses RLS) after it validated them.

-- ───────── Characters (admin-managed presets students choose from) ─────────
create table if not exists public.characters (
  id      serial primary key,
  name    text    not null,
  look    jsonb   not null,           -- {"s": skinIdx, "h": hairIdx, "o": "#outfitColor"}
  enabled boolean not null default true
);
insert into public.characters (name, look) values
  ('Blue Hoodie',   '{"s":1,"h":1,"o":"#4f7cff"}'),
  ('Red Hoodie',    '{"s":0,"h":0,"o":"#ff6b6b"}'),
  ('Green Jacket',  '{"s":2,"h":3,"o":"#34c38f"}'),
  ('Gold Sweater',  '{"s":3,"h":2,"o":"#ffb100"}'),
  ('Purple Tee',    '{"s":1,"h":4,"o":"#a66bff"}'),
  ('Cyan Jacket',   '{"s":2,"h":0,"o":"#2fc4d9"}')
on conflict do nothing;

-- ───────── Profiles (1 row per Supabase auth user) ─────────
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  enrollment   text not null check (enrollment ~ '^[0-9A-Za-z-]{6,20}$'),
  name         text not null check (char_length(name) between 2 and 14),
  age          int  not null check (age between 15 and 60),
  character_id int  references public.characters(id),
  look         jsonb,                   -- student's own avatar look {"s":0-3,"h":0-4,"o":"#hex"}; wins over character_id
  role         text not null default 'student'  check (role   in ('student','admin')),
  -- Use 'pending' as the default if you want admin approval before anyone can enter.
  status       text not null default 'approved' check (status in ('pending','approved','banned')),
  muted        boolean not null default false,
  created_at   timestamptz not null default now()
);
-- (existing database? run: alter table public.profiles add column if not exists look jsonb;)
-- One enrollment number = one account (case-insensitive).
create unique index if not exists profiles_enrollment_uq on public.profiles (upper(enrollment));

create table if not exists public.chat_messages (
  id         bigint generated always as identity primary key,
  sender_id  uuid not null references public.profiles(id) on delete cascade,
  name       text not null,
  look       jsonb,
  text       text not null check (char_length(text) between 1 and 200),
  created_at timestamptz not null default now()
);
create index if not exists chat_created_idx on public.chat_messages (created_at desc);

create table if not exists public.dm_messages (
  id           bigint generated always as identity primary key,
  sender_id    uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  text         text not null check (char_length(text) between 1 and 200),
  created_at   timestamptz not null default now()
);
create index if not exists dm_pair_idx on public.dm_messages (sender_id, recipient_id, created_at desc);

create table if not exists public.blocks (
  blocker uuid not null references public.profiles(id) on delete cascade,
  blocked uuid not null references public.profiles(id) on delete cascade,
  primary key (blocker, blocked)
);

create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  admin_id   uuid,
  action     text not null,
  payload    jsonb,
  created_at timestamptz not null default now()
);

-- ───────── Helpers ─────────
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and role = 'admin' and status <> 'banned');
$$;

-- Students must never be able to promote themselves / un-ban / un-mute / change enrollment.
create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- server (service role) and the SQL editor / admins may change anything
  if coalesce(auth.role(), '') = 'service_role'
     or session_user in ('postgres', 'supabase_admin')
     or public.is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.role := 'student'; new.muted := false;
    if new.status <> 'pending' then new.status := 'approved'; end if;  -- allow self-chosen 'pending' only
    return new;
  end if;
  new.role := old.role; new.status := old.status; new.muted := old.muted;
  new.enrollment := old.enrollment;
  return new;
end $$;

drop trigger if exists profiles_protect on public.profiles;
create trigger profiles_protect before insert or update on public.profiles
  for each row execute function public.protect_profile();

-- ───────── Row Level Security ─────────
alter table public.characters    enable row level security;
alter table public.profiles      enable row level security;
alter table public.chat_messages enable row level security;
alter table public.dm_messages   enable row level security;
alter table public.blocks        enable row level security;
alter table public.audit_log     enable row level security;

-- characters: everyone signed-in sees enabled ones; only admins edit
create policy characters_read  on public.characters for select to authenticated using (enabled or public.is_admin());
create policy characters_admin on public.characters for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- profiles: you see only your own row (other students' public info arrives from the server over the socket)
create policy profiles_read   on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
create policy profiles_insert on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_admin  on public.profiles for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- public chat: readable when signed in; NO client write policy => only the server can insert/delete
create policy chat_read on public.chat_messages for select to authenticated using (true);

-- private chat: only the two participants (and admins) can read; NO client write policy
create policy dm_read on public.dm_messages for select to authenticated
  using (sender_id = auth.uid() or recipient_id = auth.uid() or public.is_admin());

-- blocks: each student manages only their own list
create policy blocks_own on public.blocks for all to authenticated
  using (blocker = auth.uid()) with check (blocker = auth.uid());

-- audit log: admins read only (server writes)
create policy audit_read on public.audit_log for select to authenticated using (public.is_admin());

-- ───────── First admin (run manually after that person signed up) ─────────
-- update public.profiles set role = 'admin' where enrollment = 'YOUR-ENROLLMENT';
-- If the trigger reverts it, run:  alter table public.profiles disable trigger profiles_protect;  then re-enable.
