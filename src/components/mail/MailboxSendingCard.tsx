'use client';

import * as React from 'react';

import { Badge, Button, Card } from '@/components/atoms';
import {
  GMAIL_CONNECT_REFUSAL,
  GMAIL_CONNECT_REFUSALS,
  type GmailConnectRefusal,
} from '@/lib/constants/mailboxSend';
import { TRY_AGAIN_COPY } from '@/components/deals/DealsUnavailable';

type MailboxStatus = {
  configured: boolean;
  connected: boolean;
  email?: string;
  provider?: 'microsoft' | 'google';
  status?: 'connected' | 'revoked';
  /** Which sending clients this deployment has. An older server omits it: read that as Microsoft only. */
  providers?: { microsoft: boolean; google: boolean };
};

/** A connect round trip's ?mailbox=error&reason=, narrowed to a known refusal. Anything else reads as failed. */
function connectRefusalOf(reason: string | null): GmailConnectRefusal {
  return (GMAIL_CONNECT_REFUSALS as string[]).includes(reason ?? '')
    ? (reason as GmailConnectRefusal)
    : GMAIL_CONNECT_REFUSAL.FAILED;
}

/** A connect probe that did not redirect: 409 is a firm with no Workspace domain, 403 a caller who may not send. */
function connectProbeRefusal(status: number | undefined): GmailConnectRefusal {
  if (status === 409) return GMAIL_CONNECT_REFUSAL.NO_FIRM_DOMAIN;
  if (status === 403) return GMAIL_CONNECT_REFUSAL.NOT_ELIGIBLE;
  return GMAIL_CONNECT_REFUSAL.FAILED;
}

/**
 * Why a connect did not complete, in the banker's words (#490 design, card
 * tree). `selfEmail` is the caller's own address from /api/v1/me; the reason
 * in the URL never carries an address.
 */
function connectRefusalCopy(reason: GmailConnectRefusal, selfEmail: string | null): string {
  switch (reason) {
    case GMAIL_CONNECT_REFUSAL.WRONG_ACCOUNT:
      return selfEmail
        ? `Google connected a different account. Connect with ${selfEmail}.`
        : 'Google connected a different account. Connect with your own work address.';
    case GMAIL_CONNECT_REFUSAL.NOT_WORKSPACE:
      return selfEmail
        ? `Connect with your firm's Google Workspace account, ${selfEmail}.`
        : "Connect with your firm's Google Workspace account.";
    case GMAIL_CONNECT_REFUSAL.SCOPE_MISSING:
      return 'Google did not grant Send email on your behalf. Connect again and allow it.';
    case GMAIL_CONNECT_REFUSAL.SCOPE_UNEXPECTED:
      return 'Google granted more than Conductia asked for, so the connection was not kept. Tell your admin.';
    case GMAIL_CONNECT_REFUSAL.NOT_ELIGIBLE:
      return "Sending from Gmail is for the bank's own team. Use the deal's threads instead.";
    case GMAIL_CONNECT_REFUSAL.NO_FIRM_DOMAIN:
      return "Your firm's Google Workspace is not set up for sending yet. Ask the Conductia team.";
    case GMAIL_CONNECT_REFUSAL.NOT_RECORDED:
      return 'The connection did not complete, and Conductia could not record the attempt. Try again, and tell the Conductia team if it happens again.';
    default:
      return 'The connection did not complete. Try again.';
  }
}

/**
 * Where a banker removes an approval Google recorded for a refused connect.
 * Google records it at consent, so the callback marks every refusal after
 * that point with granted=1, whatever the reason. Conductia stores nothing
 * and never revokes it (a revoke can end the account's other grants, Google
 * sign-in included: #490 audit 1), so the banker is told where to remove it.
 */
const GOOGLE_PERMISSIONS_URL = 'https://myaccount.google.com/permissions';

/** The current page with its query (Settings keeps `?section=mail`), for the connect round trip to come back to. */
function here(): string {
  return `${window.location.pathname}${window.location.search}`;
}

const TEXT = 'font-sans text-[length:var(--text-sm)] leading-relaxed';

/**
 * Send from your own mailbox (#490): connect Gmail or Microsoft 365 so mail
 * sent in Conductia goes out from the banker's own address, or disconnect.
 * Lives in Settings › Mail. Back from a connect round trip
 * (?mailbox=connected|error[&reason=][&granted=1]) it says why a connect did
 * not complete and drops those params so a reload does not repeat the notice;
 * any other query (`section=mail`) stays. `selfEmail` is the caller's own
 * address from /api/v1/me, named in the wrong-account copy.
 */
export function MailboxSendingCard({ selfEmail }: { selfEmail: string | null }) {
  const [mailbox, setMailbox] = React.useState<MailboxStatus | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  // A failed status read is stated, never shown as "not set up".
  const [failed, setFailed] = React.useState(false);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [disconnect, setDisconnect] = React.useState<'idle' | 'busy' | 'failed'>('idle');
  // Why the last Connect for sending did not complete, until the next attempt,
  // and whether Google had already recorded an approval (granted=1).
  const [connectNotice, setConnectNotice] = React.useState<GmailConnectRefusal | null>(null);
  const [connectGranted, setConnectGranted] = React.useState(false);

  // Deferred a tick; the URL is read inside the timer so a double-run effect still sees it.
  React.useEffect(() => {
    const timer = setTimeout(() => {
      const url = new URL(window.location.href);
      const outcome = url.searchParams.get('mailbox');
      if (outcome !== 'connected' && outcome !== 'error') return;
      const reason = url.searchParams.get('reason');
      const granted = url.searchParams.get('granted') === '1';
      url.searchParams.delete('mailbox');
      url.searchParams.delete('reason');
      url.searchParams.delete('granted');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      setConnectNotice(outcome === 'error' ? connectRefusalOf(reason) : null);
      setConnectGranted(outcome === 'error' && granted);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/api/v1/mailbox', { signal: controller.signal });
        if (res.ok) {
          setMailbox((await res.json()) as MailboxStatus);
          setFailed(false);
        } else {
          setFailed(true);
        }
      } catch {
        // Unreadable: said so, with Retry; the card offers no connect it cannot back.
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        if (!controller.signal.aborted) setLoaded(true);
      }
    })();
    return () => controller.abort();
  }, [refreshKey]);

  // Which sending clients this deployment offers, and the caller's Google
  // connection, if that is what they hold. A Google row is always reported,
  // so its card shows even when Gmail sending is switched off.
  const sendingProviders = mailbox?.providers ?? { microsoft: Boolean(mailbox?.configured), google: false };
  const googleMailbox = mailbox?.provider === 'google' ? mailbox : null;

  const disconnectMailbox = async () => {
    setDisconnect('busy');
    const ok = await fetch('/api/v1/mailbox', { method: 'DELETE' }).then(
      (res) => res.ok,
      () => false,
    );
    setDisconnect(ok ? 'idle' : 'failed');
    if (ok) {
      setConnectNotice(null);
      setConnectGranted(false);
      setRefreshKey((k) => k + 1);
    }
  };

  // Ask the connect route first without following it: a firm with no Google
  // Workspace domain on record is a 409 the card can put in words, where a
  // plain navigation would land the banker on raw JSON. A redirect means the
  // consent can start, so navigate for real; that second call sets the state
  // and PKCE cookies the callback checks.
  const connectGmail = async () => {
    setConnectNotice(null);
    setConnectGranted(false);
    const href = `/api/v1/mailbox/google/connect?next=${encodeURIComponent(here())}`;
    const res = await fetch(href, { redirect: 'manual' }).catch(() => null);
    if (res && (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400))) {
      // A route handler that redirects to Google: full navigation.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(href);
      return;
    }
    setConnectNotice(connectProbeRefusal(res?.status));
  };

  const disconnectFailed =
    disconnect === 'failed' ? (
      <p role="alert" className={`${TEXT} text-[var(--ink-secondary)]`}>
        The mailbox is still connected. Disconnect could not be completed. Try again.
      </p>
    ) : null;

  let body: React.ReactNode;
  if (!loaded) {
    body = <p className={`${TEXT} text-[var(--ink-tertiary)]`}>Loading…</p>;
  } else if (failed) {
    body = (
      <div role="alert" className="flex flex-wrap items-center gap-[var(--space-2)]">
        <p className={`${TEXT} text-[var(--ink-secondary)]`}>Your mailbox status could not be loaded. Try again.</p>
        <Button
          size="sm"
          variant="secondary"
          aria-label="Try again loading mailbox status"
          onClick={() => {
            setLoaded(false);
            setRefreshKey((k) => k + 1);
          }}
        >
          {TRY_AGAIN_COPY}
        </Button>
      </div>
    );
  } else if (googleMailbox) {
    body = (
      <>
        {!sendingProviders.google ? (
          <p className={`${TEXT} text-[var(--ink)]`}>
            Sending from Gmail is switched off in Conductia for now. Mail does not send from{' '}
            <strong>{googleMailbox.email}</strong> until it is back. Disconnect to send from the platform address.
          </p>
        ) : googleMailbox.status === 'revoked' ? (
          <>
            <div>
              <Badge tone="hold">Approval ended</Badge>
            </div>
            <p className={`${TEXT} text-[var(--ink)]`}>
              Google ended Conductia&apos;s approval to send as <strong>{googleMailbox.email}</strong>. Mail does not
              send until you connect again.
            </p>
          </>
        ) : (
          <p className={`${TEXT} text-[var(--ink)]`}>
            Connected for sending as <strong>{googleMailbox.email}</strong>. Mail you send here goes out from your
            Gmail and appears in your Sent folder.
          </p>
        )}
        <div className="flex flex-wrap gap-[var(--space-2)]">
          {sendingProviders.google && googleMailbox.status === 'revoked' ? (
            <Button size="sm" onClick={connectGmail}>
              Connect for sending
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" disabled={disconnect === 'busy'} onClick={disconnectMailbox}>
            Disconnect
          </Button>
        </div>
        {sendingProviders.google ? (
          <p className="font-sans text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-tertiary)]">
            Disconnect deletes Conductia&apos;s stored approval. Mail you send here then goes out from the platform
            address. To remove Conductia from your Google account too, use Google&apos;s linked apps page.
          </p>
        ) : null}
        {disconnectFailed}
      </>
    );
  } else if (mailbox?.connected) {
    body = (
      <>
        <p className={`${TEXT} text-[var(--ink)]`}>
          Connected as <strong>{mailbox.email}</strong>. Mail you send here goes out from your Microsoft 365 mailbox.
        </p>
        <div>
          <Button size="sm" variant="secondary" disabled={disconnect === 'busy'} onClick={disconnectMailbox}>
            Disconnect
          </Button>
        </div>
        {disconnectFailed}
      </>
    );
  } else if (!mailbox || !mailbox.configured) {
    body = (
      <p className={`${TEXT} text-[var(--ink-secondary)]`}>
        Sending from your own mailbox is not set up in Conductia yet. Until then, mail sends from the platform
        address.
      </p>
    );
  } else {
    body = (
      <>
        {sendingProviders.google ? (
          <>
            <p className={`${TEXT} text-[var(--ink-secondary)]`}>
              Connect your Gmail to send as your own address. Mail you send here goes out from your Gmail and appears
              in your Gmail Sent folder. Google asks you to approve one permission, Send email on your behalf. This
              permission does not let Conductia read your mail.
            </p>
            <div>
              <Button size="sm" onClick={connectGmail}>
                Connect for sending
              </Button>
            </div>
          </>
        ) : null}
        {sendingProviders.microsoft ? (
          <>
            <p className={`${TEXT} text-[var(--ink-secondary)]`}>
              Connect your Microsoft 365 mailbox to send as your own address. You approve access on Microsoft&apos;s
              page, and Conductia never sees your password.
            </p>
            <div>
              <Button
                size="sm"
                onClick={() => {
                  // A route handler that redirects to Microsoft: full navigation.
                  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                  window.location.href = `/api/v1/mailbox/connect?next=${encodeURIComponent(here())}`;
                }}
              >
                Connect Microsoft 365
              </Button>
            </div>
          </>
        ) : null}
      </>
    );
  }

  return (
    <Card role="region" aria-labelledby="mailbox-sending-title" className="flex flex-col gap-[var(--space-3)]">
      <h3 id="mailbox-sending-title" className="font-sans text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
        Send from your mailbox
      </h3>
      {connectNotice ? (
        <p role="alert" className={`${TEXT} text-[var(--negative-deep)]`}>
          {connectRefusalCopy(connectNotice, selfEmail)}
          {connectGranted ? (
            <>
              {' '}Conductia kept nothing from that approval. To remove it from the Google account, open{' '}
              <a href={GOOGLE_PERMISSIONS_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                myaccount.google.com/permissions
              </a>
              .
            </>
          ) : null}
        </p>
      ) : null}
      {body}
    </Card>
  );
}
