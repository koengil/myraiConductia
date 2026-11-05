export const PERSON_SUGGESTION_SOURCE = {
  DEAL_MEMBER: 'deal_member',
  COMPANY_USER: 'company_user',
  CRM_PERSON: 'crm_person',
  RELATIONSHIP: 'relationship',
  STAKEHOLDER: 'stakeholder',
} as const;

/** Narrows people search for firm-side relationship contacts vs target stakeholders. */
export const PERSON_SEARCH_SCOPE = {
  ALL: 'all',
  FIRM_NETWORK: 'firm_network',
  COMPANY_EMPLOYEES: 'company_employees',
} as const;

export type PersonSearchScope =
  (typeof PERSON_SEARCH_SCOPE)[keyof typeof PERSON_SEARCH_SCOPE];

export type PersonSuggestionSource =
  (typeof PERSON_SUGGESTION_SOURCE)[keyof typeof PERSON_SUGGESTION_SOURCE];

/** Normalized person row for mail To/Cc and rail name fields. */
export type PersonSuggestion = {
  id: string;
  name: string;
  email: string | null;
  company: string | null;
  source: PersonSuggestionSource;
};
