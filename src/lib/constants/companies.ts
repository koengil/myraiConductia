// Company + deal-party constants. Mirror the companies.type and
// deal_parties.party_role CHECK enums in
// supabase/migrations/20260604100000_permissions_schema.sql.

export const COMPANY_TYPE = {
  BANK: 'bank',
  TARGET: 'target',
  ACQUIRER: 'acquirer',
  CLIENT: 'client',
  COUNTERPARTY: 'counterparty',
} as const;

export type CompanyType = (typeof COMPANY_TYPE)[keyof typeof COMPANY_TYPE];
export const COMPANY_TYPES = Object.values(COMPANY_TYPE) as CompanyType[];

export const PARTY_ROLE = {
  TARGET: 'target',
  CO_SELLER: 'co_seller',
  ACQUIRER_SHORTLIST: 'acquirer_shortlist',
  COUNTERPARTY: 'counterparty',
} as const;

export type PartyRole = (typeof PARTY_ROLE)[keyof typeof PARTY_ROLE];
