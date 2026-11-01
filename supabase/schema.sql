-- ═══════════════════════════════════════════════════════════════════════
-- Terminal · Supabase schema
-- Messages, channels, DMs, read receipts, media storage, realtime.
-- Run in Supabase Studio → SQL Editor (or `supabase db push`).
-- ═══════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

-- ── People ────────────────────────────────────────────────────────────
create table if not exists terminal_members (
  email        text primary key,
  handle       text unique not null,
  display_name text not null,
  hue          text not null default '#10b981',
  created_at   timestamptz not null default now()
);

-- Invite allow-list: only these Google addresses may join.
create table if not exists terminal_invites (
  email       text primary key,
  handle      text unique,
  display_name text,
  hue         text not null default '#10b981',
  created_at  timestamptz not null default now()
);

-- ── Channels & DMs ────────────────────────────────────────────────────
create table if not exists terminal_rooms (
  id         text primary key,
  name       text not null,
  topic      text not null default '',
  is_system  boolean not null default false,
  created_by text,
  created_at timestamptz not null default now()
);

insert into terminal_rooms (id, name, topic, is_system)
values ('general', 'General', 'Primary workspace channel — always active', true)
on conflict (id) do nothing;

-- DM membership (rooms named 'dm:<a>:<b>')
create table if not exists terminal_dm_members (
  room  text not null,
  email text not null,
  primary key (room, email)
);

-- ── Messages ──────────────────────────────────────────────────────────
create table if not exists terminal_messages (
  id          uuid primary key default gen_random_uuid(),
  room        text not null,
  author      text not null,            -- member email
  body        text not null default '',
  file_path   text,
  file_name   text,
  file_mime   text,
  file_size   bigint,
  reply_to    uuid,
  read_by     text[] not null default '{}',
  client_id   text,
  created_at  timestamptz not null default now()
);

create index if not exists terminal_messages_room_idx on terminal_messages (room, created_at desc);
create index if not exists terminal_messages_author_idx on terminal_messages (author);

-- ── Helpers (security definer so RLS can see membership) ─────────────
create or replace function terminal_is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from terminal_members m where m.email = auth.jwt() ->> 'email');
$$;

create or replace function terminal_room_visible(target_room text)
returns boolean language sql stable security definer set search_path = public as $$
  select
    exists (select 1 from terminal_rooms r where r.id = target_room)
    or exists (select 1 from terminal_dm_members d
               where d.room = target_room and d.email = auth.jwt() ->> 'email');
$$;

-- Mark every message in a room as read by the caller.
create or replace function terminal_mark_read(target_room text)
returns setof uuid language sql security definer set search_path = public as $$
  update terminal_messages
     set read_by = case
                     when auth.jwt() ->> 'email' = any(read_by) then read_by
                     else array_append(read_by, auth.jwt() ->> 'email')
                   end
   where room = target_room
     and auth.jwt() ->> 'email' is not null
     and auth.jwt() ->> 'email' <> author
  returning id;
$$;

-- ── Row Level Security ────────────────────────────────────────────────
alter table terminal_members     enable row level security;
alter table terminal_invites     enable row level security;
alter table terminal_rooms       enable row level security;
alter table terminal_dm_members  enable row level security;
alter table terminal_messages   enable row level security;

drop policy if exists members_read on terminal_members;
create policy members_read on terminal_members for select using (terminal_is_member());

-- Invites are readable only by the service role (server inserts them).
drop policy if exists invites_none on terminal_invites;
create policy invites_none on terminal_invites for all using (false);

drop policy if exists rooms_read on terminal_rooms;
create policy rooms_read on terminal_rooms for select using (terminal_is_member());

drop policy if exists rooms_write on terminal_rooms;
create policy rooms_write on terminal_rooms for insert with check (terminal_is_member());

drop policy if exists dm_read on terminal_dm_members;
create policy dm_read on terminal_dm_members for select using (terminal_is_member());

drop policy if exists dm_write on terminal_dm_members;
create policy dm_write on terminal_dm_members for insert with check (terminal_is_member());

drop policy if exists messages_read on terminal_messages;
create policy messages_read on terminal_messages for select
  using (terminal_is_member() and terminal_room_visible(room));

drop policy if exists messages_insert on terminal_messages;
create policy messages_insert on terminal_messages for insert
  with check (
    terminal_is_member()
    and author = auth.jwt() ->> 'email'
    and terminal_room_visible(room)
  );

-- ── Realtime ──────────────────────────────────────────────────────────
alter table terminal_messages replica identity full;
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and tablename = 'terminal_messages') then
    alter publication supabase_realtime add table terminal_messages;
  end if;
end $$;

-- ── Media storage ─────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('terminal-media', 'terminal-media', false, 15728640,
        array['image/jpeg','image/png','image/webp','image/gif','audio/webm','audio/mp4','audio/ogg','video/mp4','video/webm','text/plain','application/pdf'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit;

drop policy if exists media_read on storage.objects;
create policy media_read on storage.objects for select
  using (bucket_id = 'terminal-media' and terminal_is_member());

drop policy if exists media_write on storage.objects;
create policy media_write on storage.objects for insert
  with check (bucket_id = 'terminal-media' and terminal_is_member());

-- ── Seed your crew ────────────────────────────────────────────────────
-- Replace with real people, then sign in with those Google addresses.
insert into terminal_invites (email, handle, display_name) values
  ('alice@example.com', 'alice', 'Alice'),
  ('blair@example.com', 'blair', 'Blair')
on conflict (email) do nothing;
