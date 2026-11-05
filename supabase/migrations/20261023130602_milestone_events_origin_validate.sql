-- G-07 slice 3b (#173): validate the reference and the check 20261023130600 added NOT VALID to milestone_events, a big
-- table. Validation takes a SHARE UPDATE EXCLUSIVE lock, so reads and writes continue while the rows are checked.
-- lint-allow: hosted-counts every row written before 20261023130600 has a model_call_id and no detection_id (the column is new and model_call_id was not null), so both hold on every hosted row
alter table milestone_events validate constraint milestone_events_detection_fkey;
-- lint-allow: hosted-counts as above
alter table milestone_events validate constraint milestone_events_one_origin_check;

-- 20261023130601 builds the detection index concurrently; a failed build leaves an invalid index that `if not exists`
-- would skip on a retry. Stop here, loudly, if that happened: drop milestone_events_detection_idx and re-run 130601.
do $$
begin
  if to_regclass('public.milestone_events_detection_idx') is null
     or not exists (select 1 from pg_index where indexrelid = 'public.milestone_events_detection_idx'::regclass and indisvalid) then
    raise exception 'milestone_events_detection_idx is missing or invalid: drop it and re-run 20261023130601_milestone_events_detection_idx.sql';
  end if;
end;
$$;
