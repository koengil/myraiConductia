-- Send idempotency for POST /api/v1/outbox: one logical send = at most one
-- provider send. The composer sends a clientRequestId for each message; the
-- record-first 'pending' insert is the claim, so a retry or a double click
-- with the same id hits this index (23505) and the route answers with the
-- original row instead of sending again. Scoped to the sender (who implies
-- the tenant). NULL for sends without an id (older clients, historical rows),
-- which the partial index leaves unconstrained.
--
-- Idempotent: safe to re-run.
alter table public.outbound_messages add column if not exists client_request_id text;
create unique index if not exists outbound_messages_sender_client_request_unique
  on public.outbound_messages (sender_id, client_request_id)
  where client_request_id is not null;
