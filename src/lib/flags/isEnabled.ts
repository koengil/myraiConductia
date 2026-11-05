import { errorCodeOf } from '@/lib/errors/upstream';

import type { FlagKey } from './keys';
import type { FlagSource } from './source';

// Fail-closed flag resolution. A flag is enabled ONLY when its source row
// explicitly returns `true`. A missing row (null), an unknown key, or any source
// error all resolve to `false` — unreachable or unknown state must never silently
// enable a capability (ADR-0007).
export async function isEnabled(
  key: FlagKey,
  source: FlagSource,
): Promise<boolean> {
  try {
    return (await source.getEnabled(key)) === true;
  } catch (error) {
    // Fail closed, but never silently: a misconfig or outage must be visible,
    // not indistinguishable from a disabled flag.
    console.warn(
      `[flags] isEnabled("${key}") failed; defaulting to false (fail-closed):`,
      errorCodeOf(error),
    );
    return false;
  }
}
