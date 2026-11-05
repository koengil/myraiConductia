'use client';

import * as React from 'react';

import { Dialog } from '@/components/overlay';
import { Gate0LeadLoader } from '@/components/wizard/Gate0LeadLoader';
import { useFlag } from '@/lib/flags/FlagsContext';
import { prefetchLeadCatalog } from '@/lib/leads/leadCatalog';
import { useLeadCatalog } from '@/lib/leads/useLeadCatalog';

import { Gate0Wizard } from './Gate0Wizard';

/**
 * NewMandateDialog — the portfolio's "New mandate" entry into the Gate 0
 * wizard (spec §4.3). A lightweight modal, not a route: the gate is a short,
 * self-contained ceremony launched from the portfolio and abandoned in place;
 * the created deal owns the destination URL, not the wizard.
 *
 * Built on the shared Dialog, named by its title "New mandate". The wizard
 * holds typed input, so the scrim does not close it; Escape and Close do.
 */
export interface NewMandateDialogProps {
  open: boolean;
  onClose: () => void;
}

export function NewMandateDialog({ open, onClose }: NewMandateDialogProps) {
  const apiCreateEnabled = useFlag('gate0_api_create');
  const leadCatalog = useLeadCatalog();
  const leadsLoading =
    apiCreateEnabled &&
    (leadCatalog.status === 'idle' || leadCatalog.status === 'loading');

  React.useEffect(() => {
    if (!open || !apiCreateEnabled) return;
    void prefetchLeadCatalog();
  }, [open, apiCreateEnabled]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="Gate 0"
      title="New mandate"
      size="lg"
      dismissOnScrim={false}
    >
      {leadsLoading ? <Gate0LeadLoader /> : <Gate0Wizard onCancel={onClose} onComplete={onClose} />}
    </Dialog>
  );
}

export default NewMandateDialog;
