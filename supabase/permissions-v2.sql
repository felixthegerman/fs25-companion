-- FS25 Companion: modulare Archiv-Berechtigungen
-- Kann gefahrlos mehrfach ausgeführt werden.
begin;

alter table public.discord_users add column if not exists can_view_archive boolean not null default false;
alter table public.discord_users add column if not exists can_edit_archive boolean not null default false;
alter table public.discord_users add column if not exists can_delete_archive boolean not null default false;

update public.discord_users
set status = 'approved',
    is_admin = true,
    can_create_tasks = true,
    can_delete_tasks = true,
    can_manage_users = true,
    can_view_archive = true,
    can_edit_archive = true,
    can_delete_archive = true,
    updated_at = now()
where discord_id = '1124793204588433518';

commit;
notify pgrst, 'reload schema';
