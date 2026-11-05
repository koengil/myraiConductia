-- Retry deadlines survive process restarts, reloads, and concurrent pollers.
-- NULL means no scheduled failure backoff; claimed_at still fences owners.
alter table public.lead_research add column if not exists retry_at timestamptz;
