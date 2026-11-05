-- The index the team inbox audit read (20261023100300_team_mailbox_audit_read.sql, #173 G-03) reads a firm's
-- access rows through: one tenant's audit_log rows of a few actions, newest first. Without it the read walks past
-- every reader-pass row of the tenant (about 576 a day per source) to find the sparse connect, check and access rows.
-- Built concurrently and alone in its file because audit_log is a big table (supabase/lint/big-tables.txt): a plain
-- build holds a SHARE lock that blocks every audit write until the scan ends. `supabase db push` runs this file
-- outside a transaction. If the build fails it leaves an invalid index: drop it before re-running, or `if not exists`
-- skips it.
create index concurrently if not exists audit_log_tenant_action_ts on audit_log (tenant_id, action, ts desc, id desc);
