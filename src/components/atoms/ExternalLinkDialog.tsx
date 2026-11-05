'use client';

import * as React from 'react';

import { Dialog } from '@/components/overlay/Dialog';
import { Button } from './Button';

/**
 * The "Leaving Conductia" panel: nothing in model output leaves until the MD has
 * seen the host and the full address. Built on the shared `Dialog`, which
 * portals to `document.body`, because the Markdown consumers sit inside
 * `overflow-auto` panels and transformed ancestors where `position: fixed`
 * would be clipped. Named by its title, so the host is announced. Cancel
 * takes focus first, explicitly: a control added to the body later must not
 * take first focus in a dialog whose job is to slow the user down.
 *
 * Reference for the kept-mounted pattern: the caller renders it always and
 * toggles `open`, so the close plays the exit motion.
 */
export function ExternalLinkDialog({
  open,
  url,
  onClose,
}: {
  open: boolean;
  url: URL;
  onClose: () => void;
}) {
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      initialFocus={cancelRef}
      eyebrow="Leaving Conductia"
      title={
        <>
          This link opens <strong className="break-all">{url.host || url.protocol}</strong>
        </>
      }
      description="It comes from model output. Check the full address before you open it."
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <a
            href={url.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
            className="inline-flex h-[34px] items-center justify-center whitespace-nowrap rounded-[var(--radius-control)] bg-[var(--accent)] px-4 text-(length:--text-base) font-medium text-[var(--accent-contrast)]! transition-colors hover:bg-[var(--accent-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
          >
            Open link
          </a>
        </>
      }
    >
      <p
        data-testid="external-link-href"
        className="mt-[var(--space-1)] break-all rounded-[var(--radius-input)] bg-[var(--surface-warm)] p-[var(--space-3)] font-mono text-[length:var(--text-xs)] text-[var(--ink)]"
      >
        {url.href}
      </p>
    </Dialog>
  );
}

export default ExternalLinkDialog;
