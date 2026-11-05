'use client';

import * as React from 'react';

import { useFlag } from '@/lib/flags/FlagsContext';
import { useProjectId } from '@/lib/project/useProjectId';
import { clearRecipientAddition, peekRecipientAddition } from '@/lib/team/recipientAddition';

import { DataRoom } from './DataRoom';
import { DataRoomLive } from './DataRoomLive';

/**
 * DataRoomSwitch — the flag seam for the Data Room destination.
 *
 * platform_onboarding ON: the live document store (DataRoomLive) over
 * GET/POST /api/v1/deals/{dealId}/documents.
 * platform_onboarding OFF: the fixture explorer, byte-for-byte the
 * pre-onboarding surface. The flag fails closed, so a missing provider also
 * lands here.
 */
export function DataRoomSwitch() {
  const live = useFlag('platform_onboarding');
  const dealId = useProjectId();
  // The fixture room has no invite form, so a Mail "Give data room access"
  // handoff is dropped on arrival instead of lingering in memory.
  React.useEffect(() => {
    if (!live && peekRecipientAddition(dealId, 'data-room')) clearRecipientAddition();
  }, [live, dealId]);
  return live ? <DataRoomLive /> : <DataRoom kind="data-room" />;
}

export default DataRoomSwitch;
