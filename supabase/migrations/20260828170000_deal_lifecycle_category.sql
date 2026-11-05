-- Book graduation, field 4 (#191; Storm, Aug 27): the deal's LIFECYCLE
-- CATEGORY becomes a real column, replacing the mock-scale live-vs-pitch
-- split. Storm's seven, in his order: Live Deals, Pitches, Prospects and
-- Client Maintenance, Mandate Hold, Terminated, Closed, Lost. Set by the
-- deal MD (PATCH /api/v1/deals/{id}, audited as 'update'); read by the Book
-- home's grouping. NOT NULL with default 'live': every existing deal stays
-- where the Book showed it until the MD moves it.
alter table public.deals
  add column if not exists lifecycle_category text not null default 'live'
    check (lifecycle_category in
      ('live', 'pitch', 'prospect', 'mandate_hold', 'terminated', 'closed', 'lost'));

comment on column public.deals.lifecycle_category is
  'Book lifecycle category (#191): live | pitch | prospect | mandate_hold | terminated | closed | lost. Default live.';
