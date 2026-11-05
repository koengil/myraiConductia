-- supabase/migrations/20260731121000_dataroom_bucket.sql
-- Private Supabase Storage bucket for the LocalStorage data-room provider
-- (dev/CI; production uses Box via STORAGE_PROVIDER=box). No anon or
-- authenticated policies: service-role only — all access is mediated by
-- /api/v1 handlers, which enforce the room/classification/phase predicates.
--
-- Guarded so the migration replays cleanly on bare-Postgres checks where the
-- storage schema does not exist (scripts/check-pg.sh).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('dataroom', 'dataroom', false)
    on conflict (id) do nothing;
  end if;
end $$;
