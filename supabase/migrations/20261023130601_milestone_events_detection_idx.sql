-- G-07 slice 3b (#173): the index the milestone_events -> milestone_detections reference needs, so a detection's
-- cascade (its item purged) finds its events without a scan of the whole table. Partial: only rule events carry a
-- detection_id. Concurrently and alone in its file because milestone_events is a big table
-- (supabase/lint/big-tables.txt). If the build fails it leaves an invalid index that `if not exists` would skip on a
-- retry, so 20261023130602 stops there: drop milestone_events_detection_idx and re-run this file.
create index concurrently if not exists milestone_events_detection_idx on milestone_events (detection_id) where detection_id is not null;
