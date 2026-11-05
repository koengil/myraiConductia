-- No record of an email that was not sent (D80; Storm at the Oct 5 Weekly
-- Build Sync: a record of a draft someone was about to send is a legal
-- liability). Since PR #382 the composer reports only emails sent after a
-- warning and the route refuses "abandoned"; this removes the abandoned
-- counts already written and narrows the outcome CHECK so the table cannot
-- hold one again (Rob's review of PR #405).
--
-- Safe to re-run: the delete is idempotent and the constraint is dropped by
-- name before it is added. Run by hand, in one transaction, on develop and
-- prod; no code depends on the order beyond PR #382 being live first.

delete from mail_warning_outcomes where outcome = 'abandoned';

alter table mail_warning_outcomes drop constraint if exists mail_warning_outcomes_outcome_check;
alter table mail_warning_outcomes
  add constraint mail_warning_outcomes_outcome_check check (outcome in ('sent_after_warning'));
