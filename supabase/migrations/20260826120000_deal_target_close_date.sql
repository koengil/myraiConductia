-- Book graduation, field 1 (#191, Storm's default when asked which first):
-- the deal's TARGET close date becomes a real column. Set by the deal MD
-- (PATCH /api/v1/deals/{id}, audited as 'update'); read by the Book home's
-- CLOSE column and the Book deal view. Nullable: a deal without a target
-- shows none — the mock-scale fixture date is no longer consulted.
alter table public.deals
  add column if not exists target_close_date date;

comment on column public.deals.target_close_date is
  'The MD''s target close date for the mandate (#191 Book graduation). Null = not set.';
