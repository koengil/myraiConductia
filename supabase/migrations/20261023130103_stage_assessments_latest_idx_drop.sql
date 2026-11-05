-- G-07 slice 1a (#173): the old (candidate_id, as_of desc) latest-row index, now covered by
-- stage_assessments_audience_latest_idx (candidate_id, team_mailbox_id, as_of desc), which
-- 20261023130102 found valid. Dropped concurrently and alone in its file, so no write to
-- stage_assessments waits on an ACCESS EXCLUSIVE lock; `if exists` makes a re-run a no-op.
drop index concurrently if exists stage_assessments_latest_idx;
