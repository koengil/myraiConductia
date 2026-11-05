'use client';

import * as React from 'react';

import { LeadRegistration } from '@/components/leads/LeadRegistration';
import { ACCESS_DESTINATION } from '@/lib/constants/accessRequests';
import { useRequestAccess } from '@/lib/access/useRequestAccess';
import { freshCanCreateLead } from '@/lib/leads/freshCanCreateLead';
import { Dialog } from '@/components/overlay';

export interface RegisterLeadDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
  /** When false, show the permission wall instead of the create form. */
  allowed?: boolean;
  /** The live profile now includes Create leads — swap to the form. */
  onGranted?: () => void;
}

/**
 * RegisterLeadDialog: the shared Dialog around lead registration on /leads,
 * or the permission wall when the caller cannot create leads. The form holds
 * typed input, so the scrim does not close it; Escape and Close do.
 */
export function RegisterLeadDialog({
  open,
  onClose,
  onCreated,
  allowed = true,
  onGranted,
}: RegisterLeadDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="Leads"
      title="Register a lead"
      size="xl"
      dismissOnScrim={false}
    >
      {allowed ? (
        <LeadRegistration layout="dialog" onCancel={onClose} onCreated={onCreated} />
      ) : (
        <LeadCreateNeeded onGranted={onGranted} />
      )}
    </Dialog>
  );
}

function LeadCreateNeeded({ onGranted }: { onGranted?: () => void }) {
  const { pending, busy, error, requestAccess } = useRequestAccess(
    ACCESS_DESTINATION.LEADS_CREATE,
  );

  React.useEffect(() => {
    let cancelled = false;
    async function check() {
      const next = await freshCanCreateLead();
      if (!cancelled && next) onGranted?.();
    }
    void check();
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(() => void check(), 4000);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [onGranted]);
  const buttonClass =
    'inline-flex w-fit items-center rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[6px] text-[length:var(--text-sm)] font-medium disabled:opacity-60';

  return (
    <section
      aria-label="Access needed to register a lead"
      className="flex flex-col gap-[var(--space-4)]"
    >
      <p className="max-w-xl text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        You need permission from an organization administrator to register a lead.
        Send a request and they can approve or deny it.
      </p>
      {error ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative)]">
          {error}
        </p>
      ) : null}
      {pending ? (
        <p role="status" className="text-[length:var(--text-sm)] text-[var(--ink)]">
          Your request is waiting for an administrator.
        </p>
      ) : null}
      {pending ? null : (
        <button
          type="button"
          onClick={() => void requestAccess()}
          disabled={busy}
          className={`${buttonClass} text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]`}
        >
          {busy ? 'Sending…' : 'Request access'}
        </button>
      )}
    </section>
  );
}

export default RegisterLeadDialog;
