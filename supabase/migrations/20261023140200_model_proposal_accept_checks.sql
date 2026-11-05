-- supabase/migrations/20261023140200_model_proposal_accept_checks.sql
-- G-02b (#173), slice 1b: the two values only the accept path writes.
--
--   method 'model_proposal'      evidence_links.method and routing_ledger.method: the route of a message a person
--                                accepted as part of a model-only proposal. The worker stores it through the same
--                                persist path as the firm rules (slice 3), with the tier `firm` and a route that
--                                teaches no codename, thread or alias (design R5, R12).
--   action 'accept_proposal'     corrections.action: the person's accept, written by the finish definer
--                                (20261023140300) with the requester as actor.
--
-- Each CHECK is restated in full, as every widening does: the list on the base (the core migration's, never
-- restated since: 20260925120000_discovery_core.sql for both methods, 20261002210000_discovery_corrections.sql for the
-- actions) plus the one new value, nothing dropped (scripts/check-migration-check-lists.ts fails a drop).
-- evidence_links and routing_ledger are big tables (supabase/lint/big-tables.txt): their CHECKs go back NOT VALID,
-- so the re-add holds no scan under its ACCESS EXCLUSIVE lock. The list only grows, so every existing row already
-- passes, and a NOT VALID CHECK still holds every new write (the audit action CHECK is restated the same way). The
-- corrections log is small and append-only: its CHECK is re-added validated.
--
-- Reverse: restate the three lists without the new value (no row of either may carry it then).

alter table evidence_links drop constraint if exists evidence_links_method_check;
alter table evidence_links add constraint evidence_links_method_check
  check (method in ('codename', 'alias', 'thread_continuation', 'model_proposal')) not valid;

alter table routing_ledger drop constraint if exists routing_ledger_method_check;
alter table routing_ledger add constraint routing_ledger_method_check
  check (method in ('codename', 'alias', 'thread_continuation', 'model_proposal')) not valid;

alter table corrections drop constraint if exists corrections_action_check;
alter table corrections add constraint corrections_action_check
  check (action in ('rename', 'reject', 'set_station', 'merge', 'split', 'reassign', 'confirm_link', 'reject_link',
                    'promote', 'dismiss_suggestion', 'accept_proposal'));
