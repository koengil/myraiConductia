// Document classification constants. Mirror the documents.classification CHECK
// (between 1 and 4) in the permissions migration: 1 Public … 4 MNPI.
// Class 4 (MNPI) is hidden from all roles except md and cco.

export const DOCUMENT_CLASSIFICATION = {
  PUBLIC: 1,
  INTERNAL: 2,
  CONFIDENTIAL: 3,
  MNPI: 4,
} as const;

export type DocumentClassification =
  (typeof DOCUMENT_CLASSIFICATION)[keyof typeof DOCUMENT_CLASSIFICATION];

// Document room (documents.room). Mirrors the room CHECK in
// 20260731120000_onboarding_invites.sql.
// 'internal' — bank-internal data room; NEVER visible to external users,
//              regardless of phase or classification (checked before either).
// 'deal'     — the deal room; external access is phase- and
//              classification-gated.
export const DOCUMENT_ROOM = {
  INTERNAL: 'internal',
  DEAL: 'deal',
} as const;

export type DocumentRoom = (typeof DOCUMENT_ROOM)[keyof typeof DOCUMENT_ROOM];
