import { claimReaderCapability } from '@/lib/discovery/source/capability';

/**
 * The reader capability for a test file that builds a live Graph reader, a
 * token provider or a certificate source directly (each demands it, #262).
 * Vitest gives each test file its own module registry, so this is that file's
 * one claim. A test that also loads @/lib/mailboxAccess (or worker/classify.ts)
 * would claim twice and throw: such a test reaches a reader through the guard.
 */
export const readerCapability = claimReaderCapability();
