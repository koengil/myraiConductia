-- Off-platform send census (#425): the index behind the weekly send counts. Alone in its file because `create index
-- concurrently` cannot run in a transaction (db push runs it on its own). If it fails it leaves an invalid index:
-- drop routing_ledger_sent_idx and re-run.
create index concurrently if not exists routing_ledger_sent_idx on routing_ledger (source_id, sent_at) where sent_at is not null;
