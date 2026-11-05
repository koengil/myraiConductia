-- Off-platform send census (#425): validate the NOT VALID CHECKs added in 20261021180000. Validation takes only a SHARE
-- UPDATE EXCLUSIVE lock, so reads and writes continue while the rows are checked.
alter table routing_ledger validate constraint routing_ledger_sent_recipient_check;
alter table routing_ledger validate constraint routing_ledger_sent_shape_check;

-- 20261021180300 builds the index concurrently; a failed build leaves an invalid index that `if not exists` would skip
-- on a retry. Stop here, loudly, if that happened: drop routing_ledger_sent_idx and re-run 20261021180300.
do $$
begin
  if not exists (select 1 from pg_index where indexrelid = 'public.routing_ledger_sent_idx'::regclass and indisvalid) then
    raise exception 'routing_ledger_sent_idx is invalid: drop it and re-run 20261021180300_routing_ledger_sent_idx.sql';
  end if;
end;
$$;
