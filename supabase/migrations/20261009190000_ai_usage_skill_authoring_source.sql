-- AI cost per banker (plan v5 W3, #155): skill authoring and enhancement turns
-- in the skill builder go on the ledger as their own source. Since
-- agents-backend PR #147 the bench prices each turn on its closing `done`
-- line; the turn runner now records it, keyed by attempt id. Widens the CHECK
-- only: no row changes, and a turn always has an actor.

alter table ai_usage drop constraint if exists ai_usage_source_check;
alter table ai_usage add constraint ai_usage_source_check
  check (source in ('screen','agent_run','bench_chat','twin_chat','discovery_extract','skill_run','skill_authoring'))
  not valid;
-- Validated separately: VALIDATE's lock does not block ledger writes, but only
-- when it runs in its own transaction (psql autocommit). Run as one script in a
-- single transaction, the ADD's exclusive lock covers the scan; fine at the
-- ledger's current size.
alter table ai_usage validate constraint ai_usage_source_check;
