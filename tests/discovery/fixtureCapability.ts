import { claimReaderCapability } from '@/lib/discovery/source/capability';

/**
 * The reader capability for a test file that loads the fixture corpus directly
 * (loadFixtureMailboxes demands it, audit round 2, item 9). Vitest gives each
 * test file its own module registry, so this is that file's one claim. A test
 * that also loads @/lib/mailboxAccess would claim twice and throw, which is the
 * intended failure: such a test reaches the corpus through the guarded reader.
 */
export const fixtureCapability = claimReaderCapability();
