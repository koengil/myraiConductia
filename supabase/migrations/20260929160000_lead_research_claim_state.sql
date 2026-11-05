-- #249: applyPresearchToLead claims the execution by inserting its
-- lead_research row before adding stakeholders. A claim alone must not mean
-- "applied": an apply that dies after claiming would otherwise be skipped for
-- good. completed_at marks a finished apply; claimed_at lets a later apply
-- take over a claim that went stale.
alter table lead_research add column if not exists claimed_at timestamptz not null default now();
alter table lead_research add column if not exists completed_at timestamptz;

-- Every row written before this migration was written after its apply finished.
update lead_research set completed_at = created_at where completed_at is null;

-- A stale claim can be taken over while its first owner is merely slow, not
-- dead, so both may insert the same people. The database, not the claim, has
-- to make that insert idempotent: a presearch stakeholder names the execution
-- that added it, and one execution adds a name to a lead at most once.
alter table lead_stakeholders add column if not exists source_execution_id text;
create unique index if not exists lead_stakeholders_presearch_once
  on lead_stakeholders (company_id, source_execution_id, lower(name))
  where source_execution_id is not null;
