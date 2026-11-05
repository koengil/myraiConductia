-- Gmail reader (#259), phase 3: worker-owned sync bookkeeping that survives the
-- checkpoint reset an expired history id causes (R9, R21).
--
--   backfill_started_at    When the current or last backfill began (a read from a
--                          null checkpoint). Kept after the backfill completes:
--                          with backfill_completed_at it says how long the
--                          backfill took, and a backfill longer than the
--                          provider's history window can never catch up.
--   history_expiry_streak  Consecutive resets whose expiry came right after a
--                          backfill. Two in a row halt the source instead of
--                          looping (R21). A successful delta pass sets it to 0.
--
-- Both are written by the worker (service role) only. Neither holds content.
alter table content_sources
  add column if not exists backfill_started_at   timestamptz,
  add column if not exists history_expiry_streak int not null default 0
    check (history_expiry_streak >= 0);
