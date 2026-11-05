-- AI cost tracking (#109, MVP 2 item 5): one row per AI call the platform
-- can see, attributed to the deal, the person, the task and the model.
--
-- Two sources today. The compliance screen's own Claude pass reports token
-- usage in the API reply (priced here from a code-owned table); an Ignatious
-- agent run reports its cost on the status poll (recorded once the run is
-- finished, keyed by execution id so repeated polls never double-count).
--
-- A ledger, not a rate limiter: writes are service-role only from the
-- /api/v1 layer; reads go through GET /api/v1/ai-spend with the app-layer
-- deal / internal predicates, so no authenticated policy is granted.

create table if not exists ai_usage (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  deal_id       uuid references deals (id),
  company_id    uuid references companies (id),
  actor_id      uuid not null references users (id),
  -- Which surface spent it: 'screen' (compliance screen), 'agent_run'
  -- (Ignatious run), later 'bench_chat' / 'twin_chat'.
  source        text not null check (source in ('screen','agent_run','bench_chat','twin_chat')),
  -- What the spend was for, in the vocabulary the reader recognizes: a rail
  -- step id (p1-s9), 'mail_screen', 'lead_presearch', 'lead_debrief'.
  task          text not null,
  model         text,
  input_tokens  integer,
  output_tokens integer,
  cache_read_tokens  integer,
  cache_write_tokens integer,
  -- USD, 6 decimals. Null when the model is unknown to the pricing table:
  -- the tokens are still on record.
  cost_usd      numeric(12,6),
  -- Per-source key: the execution id for an agent run (so a repeated status
  -- poll writes once); a fresh uuid for a screen (one row per pass).
  external_id   text not null,
  created_at    timestamptz not null default now(),
  unique (source, external_id)
);

create index if not exists ai_usage_deal_idx on ai_usage (deal_id, created_at desc);
create index if not exists ai_usage_tenant_idx on ai_usage (tenant_id, created_at desc);

alter table ai_usage enable row level security;
grant select, insert, update, delete on ai_usage to service_role;
