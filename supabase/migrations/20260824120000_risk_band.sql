-- #192 (written decision, 2026-08-24): every outbound message that proceeds
-- carries its risk BAND — Routine / Sampled / Queued — never the raw score.
-- The band is what the post-send CCO queue, the sampling view, and the
-- report filter on. Nullable: historic rows and blocked rows carry no band.
alter table public.outbound_messages
  add column if not exists risk_band text;

-- Constraint managed separately (the table's own migration pattern), so a
-- pre-existing column from schema drift still gets the CHECK.
alter table public.outbound_messages
  drop constraint if exists outbound_messages_risk_band_check;
alter table public.outbound_messages
  add constraint outbound_messages_risk_band_check
  check (risk_band is null or risk_band in ('routine', 'sampled', 'queued'));

comment on column public.outbound_messages.risk_band is
  'Risk band from the send-time screen (#192): routine | sampled | queued. Band only; the raw score is never stored.';
