'use client';

import * as React from 'react';

import { DealInvite } from '@/components/team';
import { clearRecipientAddition, peekRecipientAddition } from '@/lib/team/recipientAddition';

/**
 * The Data Room's "Give data room access" entry: the shared invite (DealInvite,
 * data-room mode). It renders nothing for a viewer who may not invite, so this
 * adds no chrome or checks of its own. Arriving from Mail's "Give {email} data
 * room access" link opens the form with that address filled in and asks for the recipient's deal relationship.
 */
export type DataRoomAccessInviteProps = {
  /** The deal code or id, as in the URL. */
  dealId: string;
  /** Called after an invite is created. */
  onCreated?: () => void;
};

export function DataRoomAccessInvite({ dealId, onCreated }: DataRoomAccessInviteProps) {
  // Read once on arrival. The handoff is cleared only when the form opens
  // with it or the invite is sent, so a failed read keeps it for
  // Retry; it is not kept anywhere else.
  const [email] = React.useState(() => peekRecipientAddition(dealId, 'data-room') ?? undefined);
  return (
    <DealInvite
      dealId={dealId}
      mode="data-room"
      onCreated={onCreated}
      recipientEmail={email}
      onRecipientConsumed={clearRecipientAddition}
    />
  );
}
