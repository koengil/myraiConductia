// Compatibility re-export (#262, coordination item C3). The reader capability
// lives in the provider-neutral src/lib/discovery/source/capability.ts. This
// path is a pure re-export, with no capability instance of its own, so a second
// module can never hold a second capability (tests/mailbox-access-pins.test.ts
// checks both).
export { claimReaderCapability, requireReaderCapability } from '@/lib/discovery/source/capability';
export type { ReaderCapability } from '@/lib/discovery/source/capability';
