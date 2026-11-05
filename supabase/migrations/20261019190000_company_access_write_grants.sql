revoke insert, update, delete, truncate, references, trigger
  on company_roles, company_role_permissions, company_member_roles, company_member_permissions
  from public, anon, authenticated;
