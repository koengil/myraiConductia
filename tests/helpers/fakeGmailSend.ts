import PostalMime from 'postal-mime';

type ParsedEmail = Awaited<ReturnType<typeof PostalMime.parse>>;

/*
 * A fake Google for the Gmail send path (#490): one fetch, routed by URL, for
 * the token endpoint, users.messages.send and revoke. Nothing in Conductia
 * calls revoke (#490 audit 1); it is routed so a test can assert that. It records every call,
 * and decodes each sent `raw` back into a parsed message with postal-mime, so
 * a test asserts what a recipient would see (the From, the Bcc) rather than
 * the builder's input. Any other URL goes to `other`; without one it throws,
 * so an unexpected call fails the test. The integration suite passes the real
 * fetch as `other`, so Supabase requests reach the local stack.
 */

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Google's answer once the banker removed the app or the admin Blocked it (R6). */
export const invalidGrant = (): Response =>
  jsonResponse({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);

export const tokenOk = (): Response => jsonResponse({ access_token: 'at-fake', expires_in: 3599, token_type: 'Bearer' });

export const sentOk = (): Response =>
  jsonResponse({ id: 'gmail-msg-1', threadId: 'gmail-thread-1', labelIds: ['SENT'] });

type Reply = () => Response | Promise<Response>;

export type FakeGmailOptions = {
  token?: Reply;
  send?: Reply;
  revoke?: Reply;
  other?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

export type FakeGmail = {
  fetch: typeof fetch;
  /** Every Google call, in order. */
  log: Array<'token' | 'send' | 'revoke'>;
  tokenCalls: URLSearchParams[];
  sends: Array<{ authorization: string | null; raw: string }>;
  revokes: URLSearchParams[];
  /** URLs that went to `other`, in order. */
  otherCalls: string[];
  /** The n-th sent message, parsed back from its raw bytes. */
  parsed(index?: number): Promise<ParsedEmail>;
  reset(): void;
};

export function fakeGmailSend(opts: FakeGmailOptions = {}): FakeGmail {
  const fake: FakeGmail = {
    log: [],
    tokenCalls: [],
    sends: [],
    revokes: [],
    otherCalls: [],
    parsed: async (index = 0) => {
      const sent = fake.sends[index];
      if (!sent) throw new Error(`no message ${index} was sent`);
      return PostalMime.parse(Buffer.from(sent.raw, 'base64url'));
    },
    reset: () => {
      fake.log.length = 0;
      fake.tokenCalls.length = 0;
      fake.sends.length = 0;
      fake.revokes.length = 0;
      fake.otherCalls.length = 0;
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === GOOGLE_TOKEN_URL) {
        fake.log.push('token');
        fake.tokenCalls.push(new URLSearchParams(String(init?.body ?? '')));
        return (opts.token ?? tokenOk)();
      }
      if (url === GMAIL_SEND_URL) {
        fake.log.push('send');
        const { raw } = JSON.parse(String(init?.body ?? '{}')) as { raw: string };
        fake.sends.push({ authorization: new Headers(init?.headers).get('authorization'), raw });
        return (opts.send ?? sentOk)();
      }
      if (url === GOOGLE_REVOKE_URL) {
        fake.log.push('revoke');
        fake.revokes.push(new URLSearchParams(String(init?.body ?? '')));
        return (opts.revoke ?? (() => new Response(null, { status: 200 })))();
      }
      fake.otherCalls.push(url);
      if (opts.other) return opts.other(input, init);
      throw new Error(`unexpected fetch in the fake Gmail: ${url}`);
    }) as typeof fetch,
  };
  return fake;
}
