// The reader capability (#262, audit round 1). Provider-neutral: every reader
// (Graph, Gmail) demands this one instance, so it lives outside both provider
// directories. src/lib/graph/reader/capability.ts re-exports it and holds no
// capability of its own. Static fences (ESLint, the
// tree-walk backstop) stop accidental and casual bypasses, but a computed
// import() or a re-export can walk around any text pattern. This is the run
// time backstop: every reader factory demands the capability, which exists once
// per module instance and is claimed once, at load, by
// src/lib/mailboxAccess/readers.ts. Any other caller has no way to obtain it, so
// a reader reached by a route around the guard refuses instead of reading.
//
// Where a hostile earlier claim is loud. The second claim throws, and that
// fails the boot only in a process that loads readers.ts at start:
// src/instrumentation.ts (Next server, Node runtime), the first import of
// worker/classify.ts, and the first import of each script that can reach a
// reader. tests/mailbox-access/boot-claim.test.ts pins all three. A process that
// never loads readers.ts has no boot claim: a hostile claim there is neither
// prevented nor noticed by code (the static fences and CODEOWNERS are the
// defence). A production `next start` build shares one instance between
// instrumentation and route handlers (verified on Next 16.3.5, Turbopack).

import { MAILBOX_GUARD_PURPOSE } from '@/lib/constants/discovery';
import { MailboxAccessRefusedError } from '@/lib/mailboxAccess/guard';

declare const readerCapabilityBrand: unique symbol;
/** Unforgeable at run time: only the one module-private instance below passes. */
export type ReaderCapability = { readonly [readerCapabilityBrand]: true };

const capability = Object.freeze(Object.create(null)) as ReaderCapability;
let claimed = false;

/**
 * One-time registration. Called by src/lib/mailboxAccess/readers.ts when it
 * loads, before any request can reach a reader. A second call throws, so a
 * module that loads later cannot obtain the capability.
 */
export function claimReaderCapability(): ReaderCapability {
  if (claimed) throw new Error('The reader capability is already claimed');
  claimed = true;
  return capability;
}

/** Throws MailboxAccessRefusedError('no_capability') unless `candidate` is the capability. */
export function requireReaderCapability(candidate: unknown): asserts candidate is ReaderCapability {
  if (candidate !== capability) {
    throw new MailboxAccessRefusedError('', '', 'no_capability', MAILBOX_GUARD_PURPOSE.PROVIDER_READ);
  }
}
