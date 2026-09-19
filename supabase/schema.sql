-- Run this once in Supabase SQL Editor.
create table if not exists public.discord_users (
  discord_id text primary key check (discord_id ~ '^[0-9]{17,20}$'),
  username text not null,
  global_name text,
  avatar_hash text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'blocked')),
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists discord_users_status_idx on public.discord_users(status);
create index if not exists discord_users_created_idx on public.discord_users(created_at);

alter table public.discord_users enable row level security;
revoke all on table public.discord_users from anon, authenticated;

-- The Express backend uses the Supabase server-side secret key, so browser clients
-- do not need direct table access.
