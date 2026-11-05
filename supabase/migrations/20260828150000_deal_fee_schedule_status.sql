-- Book graduation, fields 2 and 3 (#191; Storm, Aug 27: "Schedule Status,
-- Close Date, Fee" all real): the deal's FEE and SCHEDULE STATUS become real
-- columns beside target_close_date. Set by the deal MD (PATCH
-- /api/v1/deals/{id}, one audit 'update' row per changed field); read by the
-- Book home's FEE and STATUS columns and the Book deal view. Both nullable:
-- a deal without them shows none — the mock-scale fixture values are no
-- longer consulted.
alter table public.deals
  add column if not exists fee_usd bigint
    check (fee_usd is null or fee_usd >= 0),
  add column if not exists schedule_status text
    check (schedule_status is null or schedule_status in ('ahead', 'on_time', 'late'));

comment on column public.deals.fee_usd is
  'The mandate fee in whole US dollars (#191 Book graduation). Null = not set.';
comment on column public.deals.schedule_status is
  'The MD''s read of the deal against plan: ahead | on_time | late (#191 Book graduation). Null = not set.';
