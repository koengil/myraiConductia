-- supabase/migrations/20261016120000_discovery_backfill_window.sql
-- Ingestion window (#353): how far back a mailbox's first read goes.
--
--   backfill_since  The first day (UTC) of mail the source's first read takes. The Gmail
--                   reader lists threads with q=after: from it and keeps only messages on or
--                   after it; the exclusion policy still judges the whole thread. The reader
--                   pins the value it used into its checkpoint (GmailCheckpoint.since), so the
--                   checkpoint, not this column, is what a pass covered. Null reads the whole
--                   mailbox. The Graph reader does not honour it yet (#353 follow-up F1).
--
-- Existing rows keep null (whole mailbox), except a Google mailbox that has never read: it is new
-- in every way that matters and gets 90 days before it was registered (created_at, the one
-- timestamp nothing rewrites). Every later insert gets 90 days before today (UTC) by DEFAULT, so
-- the consent RPC, scripts/google/write-registration.ts and archive-and-replace need no change;
-- scripts/seed-discovery.ts writes null explicitly (fixture mailboxes are read whole).
-- 90 is BACKFILL_WINDOW_DEFAULT_DAYS in src/lib/constants/discovery.ts (pinned by
-- tests/constants-schema-sync.test.ts). No content.
alter table content_sources add column if not exists backfill_since date;

update content_sources
   set backfill_since = (created_at at time zone 'utc')::date - 90
 where provider = 'google' and kind = 'mailbox' and archived_at is null
   and delta_checkpoint is null and backfill_started_at is null and backfill_completed_at is null;

alter table content_sources
  alter column backfill_since set default ((now() at time zone 'utc')::date - 90);
