// Lead CRM enum constants (relationship-map + stakeholder-map). Mirror the
// lead_relationships / lead_stakeholders CHECK enums in
// supabase/migrations/20260722120000_lead_crm_maps.sql (the migration is the
// source of truth). Values are verbatim from the current /leads UI option sets
// (formerly local arrays in src/components/leads/LeadRegistration.tsx). Kept in
// sync by tests/constants-schema-sync.test.ts.

export const RELATIONSHIP_TYPES = [
  'colleague',
  'co-investor',
  'board member',
  'prior client',
  'prior banker',
  'personal',
  'school',
  'prior deal counterparty',
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/** Shared by lead_relationships.strength and lead_relationships.confidence. */
export const STRENGTH_LEVELS = ['High', 'Medium', 'Low'] as const;

export type StrengthLevel = (typeof STRENGTH_LEVELS)[number];

export const RELATIONSHIP_SOURCES = [
  'HubSpot',
  'M365 email-calendar',
  'PitchBook',
  'CapIQ',
  'banker asserted',
] as const;

export type RelationshipSource = (typeof RELATIONSHIP_SOURCES)[number];

export const DECISION_ROLES = [
  'decision-maker',
  'influencer',
  'gatekeeper',
  'blocker',
] as const;

export type DecisionRole = (typeof DECISION_ROLES)[number];

export const MOTIVATIONS = [
  'max price',
  'speed',
  'legacy',
  'keep the team',
  'liquidity',
  'return hurdle',
] as const;

export type Motivation = (typeof MOTIVATIONS)[number];

export const STANCES = ['Supporter', 'Neutral', 'Detractor'] as const;

export type Stance = (typeof STANCES)[number];

/** lead_relationship_paths.path_type — warm uses relationship_id; cold does not. */
export const PATH_TYPES = ['warm', 'cold'] as const;

export type PathType = (typeof PATH_TYPES)[number];
