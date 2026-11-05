'use client';

import { useFlag } from '@/lib/flags/FlagsContext';

import { DataRoom } from './DataRoom';
import { DealFolderLive } from './DealFolderLive';

/**
 * DealFolderSwitch — the flag seam for the Deal Folder destination.
 *
 * platform_onboarding ON: the live explorer over GET/POST
 * /api/v1/deals/{dealId}/documents, filed into the Ignatious taxonomy.
 * platform_onboarding OFF: the empty taxonomy explorer (folders only).
 */
export function DealFolderSwitch() {
  const live = useFlag('platform_onboarding');
  return live ? <DealFolderLive /> : <DataRoom kind="deal-folder" />;
}

export default DealFolderSwitch;
