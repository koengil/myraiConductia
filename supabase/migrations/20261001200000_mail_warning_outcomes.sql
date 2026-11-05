-- Anonymous count of what bankers do after an email warning (MVP 2 plan,
-- week 2; Storm's answer Q5 = B, Sep 21: "keep an anonymous count of emails
-- not sent after a warning").
--
-- One row per firm, UTC day, warning kind and outcome, holding a counter.
-- No person, no deal, no message content: Storm's answer 7A keeps no record
-- of unsent emails, and this table is only a tally. It feeds the week 2
-- false-positive tuning (which warnings make bankers give up) and the week 4
-- override learning.
--
--   kind     risk_issues       the Risk Patcher returned the email with issues
--            recipient_review  the recipient review asked for a confirmation
--   outcome  sent_after_warning  the email was sent after the warning
--            abandoned           the draft was discarded or the page left
--
-- Writes are service-role only, through POST /api/v1/mail-warning-outcomes,
-- which resolves the tenant from the signed-in user. Nothing is granted to
-- anon or authenticated, and RLS is on with no policy, so the Data API
-- cannot read or write it.

create table if not exists mail_warning_outcomes (
  tenant_id  uuid not null,
  day        date not null,
  kind       text not null check (kind in ('risk_issues','recipient_review')),
  outcome    text not null check (outcome in ('sent_after_warning','abandoned')),
  count      integer not null default 0 check (count >= 0),
  primary key (tenant_id, day, kind, outcome)
);

alter table mail_warning_outcomes enable row level security;

revoke all on table mail_warning_outcomes from public, anon, authenticated;
grant select, insert, update on table mail_warning_outcomes to service_role;

-- Adds one to the day's counter, creating the row on first use. The day is
-- taken here, in UTC, so a client clock cannot move a count to another day.
create or replace function record_mail_warning_outcome(
  p_tenant_id uuid,
  p_kind text,
  p_outcome text
) returns void
language sql
security invoker
set search_path = public
as $$
  insert into mail_warning_outcomes (tenant_id, day, kind, outcome, count)
  values (p_tenant_id, (now() at time zone 'utc')::date, p_kind, p_outcome, 1)
  on conflict (tenant_id, day, kind, outcome)
  do update set count = mail_warning_outcomes.count + 1;
$$;

revoke all on function record_mail_warning_outcome(uuid, text, text) from public, anon, authenticated;
grant execute on function record_mail_warning_outcome(uuid, text, text) to service_role;
