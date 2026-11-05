// Dataroom provider constants. Mirror datarooms.provider CHECK enum in
// supabase/migrations/20260731100000_dataroom_steps.sql.

export const DATAROOM_PROVIDER = {
  BOX: 'box',
} as const;

export type DataroomProvider = (typeof DATAROOM_PROVIDER)[keyof typeof DATAROOM_PROVIDER];

export const DOCUMENT_STORAGE_PROVIDER = {
  INTERNAL: 'internal',
  BOX: 'box',
} as const;

export type DocumentStorageProvider =
  (typeof DOCUMENT_STORAGE_PROVIDER)[keyof typeof DOCUMENT_STORAGE_PROVIDER];
