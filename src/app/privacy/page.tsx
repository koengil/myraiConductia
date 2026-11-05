import type { Metadata } from 'next';
import Link from 'next/link';
import { PRIVACY_CONTACT_EMAIL, PRIVACY_VERSION } from '@/lib/constants/legal';

export const metadata: Metadata = {
  title: 'Privacy Policy · Conductia',
};

const USER_DATA_POLICY_URL = 'https://developers.google.com/terms/api-services-user-data-policy';
const GOOGLE_CONNECTIONS_URL = 'https://myaccount.google.com/connections';

const h2 = 'font-semibold text-[var(--ink)]';
const h3 = 'mt-[var(--space-3)] font-semibold text-[var(--ink)]';
const p = 'mt-[var(--space-1)]';
const list = 'mt-[var(--space-1)] list-disc space-y-[var(--space-1)] pl-[var(--space-5)]';
const link = 'text-[var(--ink)] underline underline-offset-2';

/**
 * Tier 1 (unguarded) route: Google's OAuth consent screen and its verification
 * review link here, and invitees read it before accepting, so it must be
 * reachable without a session (excluded from the middleware matcher).
 *
 * The Google user data section describes the shipped behaviour (#490, ADR-0025
 * for sending; ADR-0022 for reading) and carries the Limited Use statement
 * Google's sensitive-scope review requires. The draft notice stays until
 * counsel or the owner signs the page off (T4). Bump PRIVACY_VERSION on every
 * published revision. Submission notes: docs/03-engineering/google-oauth-verification.md.
 *
 * The root layout clips the body (overflow-hidden), so the page scrolls itself.
 */
export default function PrivacyPage() {
  return (
    <div className="h-full overflow-y-auto">
      <main className="mx-auto max-w-[640px] px-[var(--space-5)] py-[var(--space-8)]">
        <p className="font-mono text-[length:var(--text-xxs)] tracking-[0.06em] text-[var(--ink-tertiary)]">
          Conductia · Version {PRIVACY_VERSION}
        </p>
        <h1 className="mt-[var(--space-2)] text-[length:var(--text-xl)] font-semibold text-[var(--ink)]">
          Privacy Policy
        </h1>
        <p className="mt-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface-subtle)] p-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          Draft pending counsel review. The section on Google user data describes
          how Conductia handles that data today. The other sections outline the
          coverage the published policy will carry.
        </p>
        <div className="mt-[var(--space-5)] space-y-[var(--space-4)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          <section>
            <h2 className={h2}>1. Who this policy covers</h2>
            <p className={p}>
              Conductia provides compliance-first deal workspace software to
              invited members of participating firms. This policy describes how
              Conductia handles personal data in the platform, including data
              Conductia receives from Google. It accompanies the Conductia{' '}
              <Link href="/terms" className={link}>
                Terms of Service
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 className={h2}>2. Data Conductia processes</h2>
            <p className={p}>
              Conductia processes account data (your name, work email address,
              firm and role), the deal material you and your firm add, the
              messages you compose and send through Conductia, and a record of
              actions on the platform. Conductia processes this data to operate
              the platform and to meet compliance obligations. Actions on the
              platform are recorded in an audit trail retained for regulatory
              purposes.
            </p>
          </section>

          <section id="google-user-data">
            <h2 className={h2}>3. Google user data</h2>
            <p className={p}>
              Conductia receives data from Google in two separate ways, each
              with its own authorization. This section describes both, and the
              rules that apply to all information Conductia receives from Google
              APIs.
            </p>

            <h3 className={h3}>Sending from your Gmail</h3>
            <p className={p}>
              When you choose Connect for sending in Settings › Mail, Google asks
              you to approve these permissions for Conductia&apos;s sending app:
            </p>
            <ul className={list}>
              <li>
                Send email on your behalf (the gmail.send scope). Conductia uses
                it only to send a message when you send it from Conductia. Before
                each message is sent, Conductia screens it for compliance and
                sets the sender to your connected address. This permission does
                not let Conductia read, change or delete the mail in your
                mailbox.
              </li>
              <li>
                Your Google Account email address and account identifier (the
                openid and email scopes). Conductia uses them only to confirm
                that the account you approved is your own account in your
                firm&apos;s Google Workspace before it keeps the approval, and to
                send your messages from that address.
              </li>
            </ul>
            <p className={p}>
              Conductia stores the approval Google issues (a refresh token),
              encrypted, together with the connected address, Google&apos;s
              identifier for the account and the permissions Google granted.
              Each time you send, Conductia obtains a short-lived access token
              from Google and does not store it. For each message sent, Conductia
              stores the message identifier Gmail returns, so the send can be
              traced in your firm&apos;s compliance record. A copy of each message
              appears in your Gmail Sent folder, and Conductia keeps its own
              record of the message, as it does for every message sent through
              the platform.
            </p>

            <h3 className={h3}>Reading for deal discovery</h3>
            <p className={p}>
              Separately, your firm&apos;s Google Workspace administrator can
              let Conductia read the mailboxes of people who agree to deal
              discovery. When your firm has done so and you have agreed in
              Settings › Mail, Conductia reads your mailbox with read-only access to find
              deals your firm may be working on. This reading uses the
              authorization your administrator grants. It does not use the
              permission you approve under Connect for sending, and that
              permission is never used to read mail. Your firm&apos;s exclusion
              policy is applied before message content is downloaded. You can
              stop the reading from Settings › Mail at any time.
            </p>
            <p className={p}>
              To find deals in what it reads, Conductia sends the content of
              those messages to an AI model provider, Anthropic, through
              Vercel&apos;s AI Gateway. This transfer is needed to provide deal
              discovery. Every request is made with zero data retention: the
              provider does not keep the content after it answers, and it does
              not use the content to train its models. If zero data retention is
              not available, Conductia does not send the content and the AI step
              stays off. Mail you send through Connect for sending is not part
              of this reading.
            </p>

            <h3 className={h3}>How Conductia uses and shares Google user data</h3>
            <ul className={list}>
              <li>
                Conductia uses Google user data only to provide the features
                described above, which you see and control in Conductia.
              </li>
              <li>
                Conductia does not transfer Google user data to others, except
                as needed to provide those features (for example, handing your
                message to Gmail to send it, or sending the content read for deal
                discovery to the AI model provider described above, with zero
                data retention), to comply with applicable law, for
                security purposes, or as part of a merger, acquisition or sale of
                assets after obtaining your explicit prior consent.
              </li>
              <li>
                Conductia does not use or transfer Google user data for serving
                advertisements, including retargeting, personalized or
                interest-based advertising.
              </li>
              <li>
                Conductia does not sell Google user data, does not transfer it to
                data brokers or information resellers, and does not use it to
                determine credit-worthiness or for lending purposes.
              </li>
              {/* TODO(owner): a firmer "personnel do not read Google user data" depends on the open
                  question in docs/03-engineering/google-oauth-verification.md (points for counsel, 4):
                  whether the deal-discovery evaluation harness has people read real mail. Until that is
                  confirmed, the page states only Google's Limited Use exceptions. */}
              <li>
                Conductia personnel read Google user data only with your
                affirmative agreement for specific messages, when it is necessary
                for security purposes such as investigating abuse, when it is
                necessary to comply with applicable law, or, for Conductia&apos;s
                internal operations, after it has been aggregated and anonymized.
              </li>
              <li>
                Conductia does not use Google user data to develop, improve or
                train generalized artificial intelligence or machine learning
                models.
              </li>
            </ul>
            <p className={p}>
              Conductia&apos;s use and transfer to any other app of information
              received from Google APIs will adhere to{' '}
              <a href={USER_DATA_POLICY_URL} target="_blank" rel="noreferrer" className={link}>
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </p>

            <h3 className={h3}>Storage and security</h3>
            <p className={p}>
              The stored approval is encrypted at rest with a key held only on
              Conductia&apos;s servers, and it is never sent to your browser.
              Data moves between your browser, Conductia and Google over
              encrypted connections.
            </p>

            <h3 className={h3}>Deleting your data and removing access</h3>
            <ul className={list}>
              <li>
                Disconnect in Settings › Mail deletes the stored approval at once,
                together with the connected address, the account identifier and
                the granted permissions. Mail you send in Conductia then goes out
                from the platform address.
              </li>
              <li>
                If Conductia refuses a connection, for example because Google
                connected a different account or a personal Google account, it
                stores nothing from that approval. Google may still list
                Conductia on your Google Account; remove it on the page linked
                below.
              </li>
              <li>
                Disconnect does not remove Conductia from your Google Account. To
                remove it there too, use Google&apos;s{' '}
                <a href={GOOGLE_CONNECTIONS_URL} target="_blank" rel="noreferrer" className={link}>
                  third-party apps and services page
                </a>
                .
              </li>
              <li>
                When you remove Conductia from your Google Account, or your
                administrator blocks it, Conductia deletes the stored approval
                the next time it tries to send, and Settings › Mail shows Approval
                ended. Disconnect then removes the rest of the connection.
              </li>
              <li>
                Conductia keeps an audit record that a connection was made, ended
                or removed, naming only the provider. It keeps the record of each
                message you sent as part of your firm&apos;s compliance record,
                retained for regulatory purposes.
              </li>
              <li>
                To ask Conductia to delete other Google user data it holds about
                you, write to the address below.
              </li>
            </ul>
          </section>

          <section>
            <h2 className={h2}>4. Contact</h2>
            <p className={p}>
              Send questions about this policy, and requests about your data, to{' '}
              <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`} className={link}>
                {PRIVACY_CONTACT_EMAIL}
              </a>
              .
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
