-- Skill publication retry cap (#249). A publish that keeps failing, or keeps
-- bouncing between publishing and reconciling on 409, now fails terminally
-- with status_code 'publish_exhausted' instead of retrying forever.

alter table skill_publication_operations drop constraint if exists skill_publication_operations_status_code_check;
alter table skill_publication_operations add constraint skill_publication_operations_status_code_check check (
  status_code is null or status_code = any (array[
    'candidate_invalid', 'candidate_stale', 'duplicate_active', 'duplicate_removed', 'duplicate_declined',
    'access_lost', 'feature_disabled', 'anchor_removed', 'receipt_conflict', 'step_removed',
    'publish_exhausted'
  ])
);
