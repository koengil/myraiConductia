-- Calibrates ESTIMATE_ASSUMPTIONS (#261, design Q4c) from a synthetic gateway run on a LOCAL stack.
-- Run: psql "$LOCAL_DB_URL" -v tenant=00000000-0000-4000-8000-000000000001 -f scripts/discovery/calibrate-extract-estimate.sql
-- Never against a hosted database. Prints counts and sums only.
with calls as (
  select mc.input_tokens, mc.output_tokens, coalesce(octet_length(si.subject), 0) + octet_length(t.body_text) as item_bytes
  from model_calls mc
  join source_items si on si.id = mc.source_item_id
  join source_item_texts t on t.source_item_id = si.id
  where mc.tenant_id = :'tenant' and mc.transport = 'gateway' and mc.outcome in ('ok', 'invalid') and mc.input_tokens is not null
)
select count(*) as n, sum(item_bytes) as item_bytes, sum(input_tokens) as input_tokens,
       percentile_cont(0.5) within group (order by output_tokens) as output_p50,
       percentile_cont(0.95) within group (order by output_tokens) as output_p95,
       max(output_tokens) as output_max
from calls;
