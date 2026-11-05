import { clearAudit } from '@/lib/audit/store';
import { clearAllDrafts } from '@/lib/mail/drafts';
import { clearDealTokens, clearStoredDeals } from '@/lib/rail/deals';
import { RAIL_CLEARS, runEach } from '@/lib/session/clearRailStores';

export { clearRailStores } from '@/lib/session/clearRailStores';

const CLEARS: ReadonlyArray<() => void> = [
  clearAudit,
  clearAllDrafts,
  clearStoredDeals,
  clearDealTokens,
  ...RAIL_CLEARS,
];

export function clearLocalStores(): void {
  runEach(CLEARS);
}
