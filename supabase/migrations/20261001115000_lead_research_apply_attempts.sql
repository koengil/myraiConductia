-- #249: a failed presearch apply releases its claim at once so the next poll
-- retries, and counts the attempt. After a bounded number of failed attempts
-- the run stops being retried (completed_at stays null; the client is told the
-- apply is terminal). last_error keeps the newest failure visible to ops.
alter table lead_research add column if not exists attempts int not null default 0;
alter table lead_research add column if not exists last_error text;
