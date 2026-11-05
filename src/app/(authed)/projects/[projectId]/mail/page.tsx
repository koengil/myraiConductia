'use client';

import { MailClient } from '@/components/mail/MailClient';

/**
 * Mail (/projects/[projectId]/mail) — the compliance email client, Outlook
 * structure with the Conductia skin: folder rail, message list, reading pane.
 * List-first; New message opens the composer in the reading pane. Nothing
 * leaves unscreened (fast layer as you type, full layer on send).
 *
 * Send-only for now: Inbox carries an honest empty state until the Microsoft
 * 365 connection lands. Messages are tenant-level (the sandbox project ids
 * are not database deals). The hold release flow is a later slice.
 */
export default function MailPage() {
  return (
    <div className="h-full min-h-0">
      <MailClient />
    </div>
  );
}
