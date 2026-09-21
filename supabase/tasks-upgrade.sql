-- FS25 Companion: Aufgaben-Kategorien, Bearbeitung, Mehrfachzuweisung und Claims
-- Kann gefahrlos mehrfach ausgeführt werden.
begin;

alter table public.tasks add column if not exists task_type text default 'field';
update public.tasks
set task_type = 'field'
where task_type is null or task_type not in ('field', 'animal', 'vehicle', 'transport', 'production', 'maintenance', 'other');
alter table public.tasks alter column task_type set default 'field';
alter table public.tasks alter column task_type set not null;
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
delete from public.task_assignees where discord_id is null;
create index if not exists task_assignees_discord_idx on public.task_assignees(discord_id);

alter table public.task_assignees enable row level security;
revoke all on table public.task_assignees from anon, authenticated;

commit;
notify pgrst, 'reload schema';
