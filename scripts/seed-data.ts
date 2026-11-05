// Dev seed fixtures (data only — no behaviour). Consumed by scripts/seed-users.ts.
// Decoupled from the runner so the "what" (data) is separate from the "how"
// (seeding logic). Dev-only; never used by the app at runtime.
//
// The dataset is shaped to exercise the full access model:
//   - two managed companies (cross-company isolation; "already belongs to
//     another company")
//   - two deals with DISJOINT membership (cross-deal RLS isolation)
//   - document classification variety incl. class-4 MNPI (classification gate)
//   - one delegated seat (access_scope.can_manage_members → S1 delegation)
//   - seats added by a non-MD director (added_by path + bulk revoke-by-adder)

import {
  DOCUMENT_CLASSIFICATION,
  type DocumentClassification,
} from '../src/lib/constants/documents';
import { COMPANY_TYPE, type CompanyType } from '../src/lib/constants/companies';
import {
  COMPANY_ROLE,
  DEAL_ROLE,
  DEPARTMENT,
  FIRM_ROLE,
  type CompanyRole,
  type DealRole,
  type Department,
  type FirmRole,
} from '../src/lib/constants/roles';

/** Seed account email format: `<slug>.intelibank@dev.com`. */
export const SEED_EMAIL_SUFFIX = '.intelibank@dev.com';

export function seedEmail(slug: string): string {
  return `${slug}${SEED_EMAIL_SUFFIX}`;
}

export type SeedVerifiedDomainDef = {
  domain: string;
  /** Auditable origin. Seed values are controlled release data, never inferred from users. */
  source: 'platform_operations_seed';
};

/** Managed companies (orgs whose people hold accounts). `key` cross-references users/deals. */
export type SeedCompanyDef = {
  key: string;
  name: string;
  type: CompanyType;
  verifiedDomains: SeedVerifiedDomainDef[];
};

export const SEED_COMPANIES: SeedCompanyDef[] = [
  {
    key: 'bank',
    name: 'Futureproofing Capital',
    type: COMPANY_TYPE.BANK,
    verifiedDomains: [{ domain: 'futureproofing.com', source: 'platform_operations_seed' }],
  },
  // A second managed firm so cross-company + cross-deal isolation is testable.
  {
    key: 'northwind',
    name: 'Northwind Partners',
    type: COMPANY_TYPE.BANK,
    verifiedDomains: [{ domain: 'northwindtraders.com', source: 'platform_operations_seed' }],
  },
];

export type SeedUserDef = {
  /** Email local part before SEED_EMAIL_SUFFIX (e.g. deal-team, nw-director). */
  emailSlug: string;
  fullName: string;
  displayName: string;
  department: Department | null;
  isExternal: boolean;
  firmRole: FirmRole | null;
  /** Managed company the user belongs to (null = external party, no company). */
  companyKey: string | null;
  companyRole: CompanyRole | null;
  /** Delegated invite right (Aug 4 sync): a member who can invite into their own company. */
  canInvite?: boolean;
};

export const SEED_USERS: SeedUserDef[] = [
  // ── Futureproofing Capital (bank) ──
  {
    emailSlug: 'md',
    fullName: 'Storm Duncan',
    displayName: 'Storm Duncan',
    department: DEPARTMENT.IB,
    isExternal: false,
    firmRole: null,
    companyKey: 'bank',
    companyRole: COMPANY_ROLE.DIRECTOR,
  },
  {
    emailSlug: 'deal-team',
    fullName: 'Alex Chen',
    displayName: 'Alex Chen',
    department: DEPARTMENT.IB,
    isExternal: false,
    firmRole: null,
    companyKey: 'bank',
    companyRole: COMPANY_ROLE.MEMBER,
    // Sandbox delegate: exercises the can-invite path without director rights.
    canInvite: true,
  },
  {
    emailSlug: 'legal',
    fullName: 'Jordan Blake',
    displayName: 'Jordan Blake',
    department: DEPARTMENT.LEGAL,
    isExternal: false,
    firmRole: null,
    companyKey: 'bank',
    companyRole: COMPANY_ROLE.MEMBER,
  },
  {
    emailSlug: 'cco',
    fullName: 'Pat Rivera',
    displayName: 'Pat Rivera',
    department: DEPARTMENT.COMPLIANCE,
    isExternal: false,
    firmRole: FIRM_ROLE.CCO,
    companyKey: 'bank',
    companyRole: COMPANY_ROLE.DIRECTOR,
  },
  {
    emailSlug: 'admin',
    fullName: 'Platform Admin',
    displayName: 'Admin',
    department: DEPARTMENT.ADMIN,
    isExternal: false,
    firmRole: FIRM_ROLE.ADMIN,
    companyKey: 'bank',
    companyRole: COMPANY_ROLE.DIRECTOR,
  },
  {
    // A non-MD bank director. Directors receive new-mandate notices as access
    // roots. Seed-only; never attached to organizations created at runtime.
    emailSlug: 'ib-director',
    fullName: 'Morgan Vale',
    displayName: 'Morgan Vale',
    department: DEPARTMENT.IB,
    isExternal: false,
    firmRole: null,
    companyKey: 'bank',
    companyRole: COMPANY_ROLE.DIRECTOR,
  },
  {
    emailSlug: 'read-only',
    fullName: 'Observer One',
    displayName: 'Observer',
    department: DEPARTMENT.IB,
    isExternal: false,
    firmRole: null,
    companyKey: 'bank',
    companyRole: COMPANY_ROLE.MEMBER,
  },
  // ── Northwind Partners (second managed company) ──
  {
    emailSlug: 'nw-director',
    fullName: 'Dana Wells',
    displayName: 'Dana Wells',
    department: DEPARTMENT.IB,
    isExternal: false,
    firmRole: null,
    companyKey: 'northwind',
    companyRole: COMPANY_ROLE.DIRECTOR,
  },
  {
    emailSlug: 'nw-member',
    fullName: 'Priya Nair',
    displayName: 'Priya Nair',
    department: DEPARTMENT.IB,
    isExternal: false,
    firmRole: null,
    companyKey: 'northwind',
    companyRole: COMPANY_ROLE.MEMBER,
  },
  // ── External parties (no managed company) ──
  {
    emailSlug: 'seller',
    fullName: 'Mike Cannon-Brookes',
    displayName: 'Mike Cannon-Brookes',
    department: null,
    isExternal: true,
    firmRole: null,
    companyKey: null,
    companyRole: null,
  },
  {
    emailSlug: 'buyer',
    fullName: 'Buyer Contact',
    displayName: 'Buyer Contact',
    department: null,
    isExternal: true,
    firmRole: null,
    companyKey: null,
    companyRole: null,
  },
];

export type SeedDealMemberDef = {
  emailSlug: string;
  dealRole: DealRole;
  /** Who granted the seat. Defaults to the deal's MD. */
  addedBySlug?: string;
  /** Delegate deal-member management to this seat (access_scope.can_manage_members). */
  canManageMembers?: boolean;
};

export type SeedDocumentDef = {
  name: string;
  classification: DocumentClassification;
  minPhase: number;
};

export type SeedDealDef = {
  code: string;
  codename: string;
  /** Owning company (deals.bank_id) — keyed to SEED_COMPANIES. */
  ownerCompanyKey: string;
  /** A referenced-only 'target' company (created without accounts). */
  targetName: string;
  /** Controlled operations reference data for the target, never account-derived. */
  targetVerifiedDomains: SeedVerifiedDomainDef[];
  members: SeedDealMemberDef[];
  documents: SeedDocumentDef[];
  /** Gate 0 lifecycle entry point (canonical step seq). Defaults to 1 (day one). */
  entryStepSeq?: number;
  /** Whether Gate 0 is complete (stamps gate0_completed_at, sets the cursor). */
  gate0Complete?: boolean;
  /** Slugs to seed a `deal_created` notification for (e.g. the tenant CCO). */
  notifyRecipientSlugs?: string[];
};

export const SEED_DEALS: SeedDealDef[] = [
  {
    code: 'ATLAS-2026-001',
    codename: 'Project Atlas',
    ownerCompanyKey: 'bank',
    targetName: 'Atlassian',
    targetVerifiedDomains: [{ domain: 'atlassian.com', source: 'platform_operations_seed' }],
    members: [
      { emailSlug: 'md', dealRole: DEAL_ROLE.MD },
      // Delegated deal-member management by the MD (S1 delegation path).
      { emailSlug: 'deal-team', dealRole: DEAL_ROLE.DEAL_TEAM, canManageMembers: true },
      { emailSlug: 'legal', dealRole: DEAL_ROLE.LEGAL },
      { emailSlug: 'read-only', dealRole: DEAL_ROLE.READ_ONLY },
      // External parties sponsored by a director (non-MD) → added_by + bulk-revoke tests.
      { emailSlug: 'seller', dealRole: DEAL_ROLE.SELLER, addedBySlug: 'cco' },
      { emailSlug: 'buyer', dealRole: DEAL_ROLE.BUYER, addedBySlug: 'cco' },
    ],
    documents: [
      { name: 'Teaser.pdf', classification: DOCUMENT_CLASSIFICATION.PUBLIC, minPhase: 0 },
      {
        name: 'Management Presentation v1.pdf',
        classification: DOCUMENT_CLASSIFICATION.INTERNAL,
        minPhase: 0,
      },
      {
        name: 'Valuation Model (MNPI).xlsx',
        classification: DOCUMENT_CLASSIFICATION.MNPI,
        minPhase: 0,
      },
    ],
  },
  {
    // Owned by Northwind, members disjoint from Atlas → cross-deal isolation.
    code: 'NW-2026-002',
    codename: 'Project Northwind',
    ownerCompanyKey: 'northwind',
    targetName: 'Canva',
    targetVerifiedDomains: [{ domain: 'canva.com', source: 'platform_operations_seed' }],
    members: [
      { emailSlug: 'nw-director', dealRole: DEAL_ROLE.MD },
      { emailSlug: 'nw-member', dealRole: DEAL_ROLE.DEAL_TEAM },
    ],
    documents: [
      { name: 'Northwind Brief.pdf', classification: DOCUMENT_CLASSIFICATION.INTERNAL, minPhase: 0 },
    ],
  },
  {
    // A Gate 0-complete deal that entered mid-lifecycle (entry_step_seq > 1) with
    // a seeded CCO notification — exercises the Gate 0 read side (rail hydration,
    // notifications UI) end to end.
    code: 'SUMMIT-2026-003',
    codename: 'Project Summit',
    ownerCompanyKey: 'bank',
    targetName: 'Databricks',
    targetVerifiedDomains: [{ domain: 'databricks.com', source: 'platform_operations_seed' }],
    entryStepSeq: 12,
    gate0Complete: true,
    notifyRecipientSlugs: ['cco'],
    members: [
      { emailSlug: 'md', dealRole: DEAL_ROLE.MD },
      { emailSlug: 'deal-team', dealRole: DEAL_ROLE.DEAL_TEAM },
      { emailSlug: 'ib-director', dealRole: DEAL_ROLE.DEAL_TEAM },
    ],
    documents: [
      { name: 'Summit Teaser.pdf', classification: DOCUMENT_CLASSIFICATION.PUBLIC, minPhase: 0 },
    ],
  },
];
