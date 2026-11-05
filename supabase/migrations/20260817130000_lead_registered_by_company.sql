-- Lead ownership: each registered lead (companies.type = 'client') is scoped to the
-- managed company that created it. Bank-internal callers still see the full tenant
-- list; external / company-scoped callers see only their org's leads.

alter table companies
  add column if not exists registered_by_company_id uuid references companies (id) on delete set null;

create index if not exists companies_registered_by_company_idx
  on companies (registered_by_company_id)
  where registered_by_company_id is not null;
