-- FS25 Companion: complete, repeatable Supabase setup
-- Run this entire file once in the Supabase SQL Editor.
-- Existing users and tasks are preserved.

begin;

-- ---------------------------------------------------------------------------
-- Discord website users and permissions
-- ---------------------------------------------------------------------------
create table if not exists public.discord_users (
  discord_id text primary key check (discord_id ~ '^[0-9]{17,20}$'),
  username text not null,
  global_name text,
  avatar_hash text,
  status text not null default 'pending',
  is_admin boolean not null default false,
  can_create_tasks boolean not null default false,
  can_delete_tasks boolean not null default false,
  can_manage_users boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.discord_users add column if not exists username text;
alter table public.discord_users add column if not exists global_name text;
alter table public.discord_users add column if not exists avatar_hash text;
alter table public.discord_users add column if not exists status text default 'pending';
alter table public.discord_users add column if not exists is_admin boolean not null default false;
alter table public.discord_users add column if not exists can_create_tasks boolean not null default false;
alter table public.discord_users add column if not exists can_delete_tasks boolean not null default false;
alter table public.discord_users add column if not exists can_manage_users boolean not null default false;
alter table public.discord_users add column if not exists last_seen_at timestamptz;
alter table public.discord_users add column if not exists created_at timestamptz not null default now();
alter table public.discord_users add column if not exists updated_at timestamptz not null default now();

update public.discord_users set username = 'unknown' where username is null or btrim(username) = '';
update public.discord_users set status = 'pending' where status is null or status not in ('pending', 'approved', 'rejected', 'blocked');

alter table public.discord_users alter column username set not null;
alter table public.discord_users alter column status set default 'pending';
alter table public.discord_users alter column status set not null;
alter table public.discord_users drop constraint if exists discord_users_status_check;
alter table public.discord_users add constraint discord_users_status_check
  check (status in ('pending', 'approved', 'rejected', 'blocked'));

-- The primary website administrator always has every permission. The backend
-- enforces the same fixed Discord ID independently of these stored flags.
update public.discord_users
set status = 'approved',
    is_admin = true,
    can_create_tasks = true,
    can_delete_tasks = true,
    can_manage_users = true,
    updated_at = now()
where discord_id = '1124793204588433518';

create index if not exists discord_users_status_idx on public.discord_users(status);
create index if not exists discord_users_created_idx on public.discord_users(created_at);
create index if not exists discord_users_presence_idx on public.discord_users(last_seen_at desc);

-- ---------------------------------------------------------------------------
-- Persistent website sessions. Keeps Discord logins across page refreshes and
-- server restarts/deployments. Session contents are only read by the backend.
-- ---------------------------------------------------------------------------
create table if not exists public.website_sessions (
  id text primary key,
  sess jsonb not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.website_sessions add column if not exists sess jsonb;
alter table public.website_sessions add column if not exists expires_at timestamptz;
alter table public.website_sessions add column if not exists updated_at timestamptz not null default now();
delete from public.website_sessions where sess is null or expires_at is null;
alter table public.website_sessions alter column sess set not null;
alter table public.website_sessions alter column expires_at set not null;
create index if not exists website_sessions_expires_idx on public.website_sessions(expires_at);

create table if not exists public.telemetry_sources (
  id uuid primary key default gen_random_uuid(),
  source_name text not null default 'FS25 Spielstand',
  device_id text,
  pairing_code_hash text unique,
  pairing_expires_at timestamptz,
  token_hash text unique,
  paired_at timestamptz,
  last_seen_at timestamptz,
  last_payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists telemetry_sources_seen_idx on public.telemetry_sources(last_seen_at desc);

-- ---------------------------------------------------------------------------
-- Shared task board
-- Canonical columns match the tasks table already present in this project.
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id bigint generated by default as identity primary key,
  task_name text not null,
  player_name text not null default '',
  field_number integer,
  task_type text not null default 'field',
  priority text not null default 'medium',
  is_completed boolean not null default false,
  created_by text references public.discord_users(discord_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tasks add column if not exists task_name text;
alter table public.tasks add column if not exists player_name text default '';
alter table public.tasks add column if not exists field_number integer;
alter table public.tasks add column if not exists task_type text default 'field';
alter table public.tasks add column if not exists priority text default 'medium';
alter table public.tasks add column if not exists is_completed boolean default false;
alter table public.tasks add column if not exists created_by text;
alter table public.tasks add column if not exists created_at timestamptz default now();
alter table public.tasks add column if not exists updated_at timestamptz default now();

-- Import values from the temporary column names used by an earlier build.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tasks' and column_name = 'name'
  ) then
    execute $sql$update public.tasks set task_name = coalesce(task_name, name) where task_name is null$sql$;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tasks' and column_name = 'assigned_player'
  ) then
    execute $sql$update public.tasks set player_name = coalesce(nullif(player_name, ''), assigned_player, '')$sql$;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tasks' and column_name = 'urgency'
  ) then
    execute $sql$update public.tasks set priority = coalesce(priority, urgency, 'medium')$sql$;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tasks' and column_name = 'done'
  ) then
    execute $sql$update public.tasks set is_completed = coalesce(is_completed, done, false)$sql$;
  end if;
end
$$;

update public.tasks set task_name = 'Neue Aufgabe' where task_name is null or btrim(task_name) = '';
update public.tasks set player_name = '' where player_name is null;
update public.tasks
set priority = case lower(coalesce(priority, 'medium'))
  when 'low' then 'low'
  when 'niedrig' then 'low'
  when 'high' then 'high'
  when 'hoch' then 'high'
  else 'medium'
end;
update public.tasks set is_completed = false where is_completed is null;
update public.tasks set task_type = 'field' where task_type is null or task_type not in ('field', 'animal', 'vehicle', 'transport', 'production', 'maintenance', 'other');
update public.tasks set created_at = now() where created_at is null;
update public.tasks set updated_at = coalesce(created_at, now()) where updated_at is null;

alter table public.tasks alter column task_name set not null;
alter table public.tasks alter column player_name set default '';
alter table public.tasks alter column player_name set not null;
alter table public.tasks alter column priority set default 'medium';
alter table public.tasks alter column priority set not null;
alter table public.tasks alter column task_type set default 'field';
alter table public.tasks alter column task_type set not null;
alter table public.tasks alter column is_completed set default false;
alter table public.tasks alter column is_completed set not null;
alter table public.tasks alter column created_at set default now();
alter table public.tasks alter column created_at set not null;
alter table public.tasks alter column updated_at set default now();
alter table public.tasks alter column updated_at set not null;

alter table public.tasks drop constraint if exists tasks_priority_check;
alter table public.tasks add constraint tasks_priority_check
  check (priority in ('low', 'medium', 'high'));
alter table public.tasks drop constraint if exists tasks_type_check;
alter table public.tasks add constraint tasks_type_check
  check (task_type in ('field', 'animal', 'vehicle', 'transport', 'production', 'maintenance', 'other'));

create table if not exists public.task_assignees (
  task_id bigint not null references public.tasks(id) on delete cascade,
  assignee_key text not null,
  discord_id text references public.discord_users(discord_id) on delete set null,
  display_name text not null,
  is_claimed boolean not null default false,
  assigned_at timestamptz not null default now(),
  primary key (task_id, assignee_key)
);
alter table public.task_assignees add column if not exists discord_id text;
alter table public.task_assignees add column if not exists display_name text;
alter table public.task_assignees add column if not exists is_claimed boolean not null default false;
alter table public.task_assignees add column if not exists assigned_at timestamptz not null default now();
update public.task_assignees set display_name = 'Spieler' where display_name is null or btrim(display_name) = '';
alter table public.task_assignees alter column display_name set not null;
insert into public.task_assignees (task_id, assignee_key, display_name, is_claimed)
select id, 'legacy:' || lower(regexp_replace(player_name, '[^a-zA-Z0-9]+', '-', 'g')), player_name, false
from public.tasks
where btrim(player_name) <> ''
on conflict (task_id, assignee_key) do nothing;
create index if not exists task_assignees_discord_idx on public.task_assignees(discord_id);

-- Remove only the old built-in demo tasks. Real tasks created through the
-- website always carry the creator's Discord ID and are left untouched.
delete from public.tasks
where created_by is null
  and task_name in (
    'Weizen ernten', 'Kartoffeln düngen', 'Claas Lexion warten',
    'Harvest the wheat', 'Fertilize the potatoes', 'Service the Claas Lexion'
  );

create index if not exists tasks_completed_idx on public.tasks(is_completed);
create index if not exists tasks_created_idx on public.tasks(created_at desc);

-- ---------------------------------------------------------------------------
-- Finance ledger prepared for the later FS25 telemetry integration.
-- No sample rows are inserted.
-- ---------------------------------------------------------------------------
create table if not exists public.finance_transactions (
  id bigint generated by default as identity primary key,
  external_id text unique,
  occurred_at timestamptz not null default now(),
  category text not null default 'other',
  description text not null,
  amount numeric(14,2) not null,
  balance_after numeric(14,2),
  currency text not null default 'USD',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.finance_transactions add column if not exists external_id text;
alter table public.finance_transactions add column if not exists occurred_at timestamptz not null default now();
alter table public.finance_transactions add column if not exists category text not null default 'other';
alter table public.finance_transactions add column if not exists description text;
alter table public.finance_transactions add column if not exists amount numeric(14,2);
alter table public.finance_transactions add column if not exists balance_after numeric(14,2);
alter table public.finance_transactions add column if not exists currency text not null default 'USD';
alter table public.finance_transactions add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.finance_transactions add column if not exists created_at timestamptz not null default now();

create unique index if not exists finance_transactions_external_id_idx
  on public.finance_transactions(external_id) where external_id is not null;
create index if not exists finance_transactions_occurred_idx
  on public.finance_transactions(occurred_at desc);

-- Browser clients do not access these tables directly. The Express backend
-- uses the Supabase server-side secret key and therefore bypasses RLS.
alter table public.discord_users enable row level security;
alter table public.website_sessions enable row level security;
alter table public.telemetry_sources enable row level security;
alter table public.tasks enable row level security;
alter table public.task_assignees enable row level security;
alter table public.finance_transactions enable row level security;
revoke all on table public.discord_users from anon, authenticated;
revoke all on table public.website_sessions from anon, authenticated;
revoke all on table public.telemetry_sources from anon, authenticated;
revoke all on table public.tasks from anon, authenticated;
revoke all on table public.task_assignees from anon, authenticated;
revoke all on table public.finance_transactions from anon, authenticated;

commit;

-- Make PostgREST immediately recognize the newly added columns.
notify pgrst, 'reload schema';
