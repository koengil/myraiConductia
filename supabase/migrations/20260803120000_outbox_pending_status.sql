-- supabase/migrations/20260803120000_outbox_pending_status.sql
-- Record-first send ordering (PR #122 review, must-fix 3): a compliant message
-- is now INSERTED as 'pending' BEFORE the provider send and updated to 'sent'
-- after, so a message can never leave the platform without a stored record.
-- On release, the held->pending transition doubles as an atomic claim that
-- prevents a double send on retry.
--
-- 'pending' is transient: it marks an in-flight send. A row stuck in
-- 'pending' means the process died between send and confirmation — evidence,
-- not a bug; it is not re-releasable (only 'held' is).
--
-- Idempotent: drop-and-re-add, safe to re-run. Newest widening, so it owns
-- the validated constraint (all existing rows are in the old, smaller set).

alter table outbound_messages drop constraint if exists outbound_messages_status_check;
alter table outbound_messages add constraint outbound_messages_status_check
  check (status in ('sent','held','blocked','rejected','pending'));
