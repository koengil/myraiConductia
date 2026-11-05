-- Extend the company permission catalogue with client platform capabilities.

alter table company_permissions drop constraint company_permissions_key_check;

alter table company_permissions add constraint company_permissions_key_check check (key in (
  'company:directory:view_all',
  'company:invites:send',
  'company:roles:manage',
  'company:access:assign',
  'company:leads:view',
  'company:deals:create',
  'company:deals:add_members'
));

insert into company_permissions (key, label, description, category, sort_order) values
  ('company:leads:view', 'View Leads',
    'See the Leads section in the platform navigation.', 'Platform', 50),
  ('company:deals:create', 'Create deals',
    'Start a new deal from the New deal entry point.', 'Deals', 60),
  ('company:deals:add_members', 'Add people on deals',
    'Invite or assign people onto a deal the company participates in.', 'Deals', 70)
on conflict (key) do update set
  label = excluded.label,
  description = excluded.description,
  category = excluded.category,
  sort_order = excluded.sort_order;
