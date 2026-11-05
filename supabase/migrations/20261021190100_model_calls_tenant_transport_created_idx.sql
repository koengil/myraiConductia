-- The index discovery_extract_budget_state (20261021190000) reads a budget's gateway calls through: one
-- tenant's model_calls rows for one transport since the budget opened (#261).
-- Built concurrently and alone in its file because model_calls is a big table (supabase/lint/big-tables.txt):
-- a plain build holds a SHARE lock that blocks every ledger write until the scan ends. `supabase db push`
-- runs this file outside a transaction. If the build fails it leaves an invalid index: drop it before
-- re-running, or `if not exists` skips it.
create index concurrently if not exists model_calls_tenant_transport_created_idx on model_calls (tenant_id, transport, created_at);
