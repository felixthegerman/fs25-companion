-- FS25 Companion: zuverlässige Finanz-Upserts für Telemetrie v1.6
-- Kann gefahrlos mehrfach ausgeführt werden.
begin;

alter table public.finance_transactions add column if not exists external_id text;
drop index if exists public.finance_transactions_external_id_idx;
create unique index finance_transactions_external_id_idx
  on public.finance_transactions(external_id);

commit;
notify pgrst, 'reload schema';
