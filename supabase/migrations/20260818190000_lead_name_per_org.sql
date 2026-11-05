-- Client leads (CRM companies.type = 'client') are owned by the registering
-- org (registered_by_company_id). Two banks in one tenant can both cover
-- "Figma". The old companies_tenant_name_unique index treated every company
-- name as tenant-global, so org B could not register a lead org A already had.
--
-- Non-client rows (bank / target / acquirer / counterparty) stay unique per
-- tenant: Gate 0 and onboarding still dedupe those identities firm-wide.

drop index if exists companies_tenant_name_unique;

create unique index if not exists companies_lead_name_per_registrar_unique
  on companies (tenant_id, registered_by_company_id, lower(name))
  where type = 'client' and registered_by_company_id is not null;

create unique index if not exists companies_lead_name_unscoped_unique
  on companies (tenant_id, lower(name))
  where type = 'client' and registered_by_company_id is null;

create unique index if not exists companies_nonclient_tenant_name_unique
  on companies (tenant_id, lower(name))
  where type <> 'client';
