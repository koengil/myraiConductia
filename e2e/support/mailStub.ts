import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';

/**
 * A stand-in for Resend's send endpoint (design D7). Invite email is real
 * Resend, called server-side by raw fetch, with no outbox row and no Inbucket
 * delivery — so the only way a browser test can read an invitation back is to
 * terminate the HTTP call ourselves. The hermetic tier points
 * RESEND_API_BASE here; nothing leaves the process, which is a stronger
 * guarantee than any hosted sandbox inbox.
 *
 * It observes everything real delivery does short of the vendor: the ordering
 * of the two emails, the Idempotency-Key on each, and the retry attempts.
 */
export type CapturedMessage = {
  id: string;
  /** Monotonic arrival counter — the ordering evidence (code before link). */
  seq: number;
  to: string[];
  from: string;
  subject: string;
  html: string;
  idempotencyKey: string | null;
  receivedAt: string;
};

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export function createMailStub(): {
  handler: http.RequestListener;
  messages: CapturedMessage[];
} {
  const messages: CapturedMessage[] = [];
  let seq = 0;

  const handler: http.RequestListener = (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (request.method === 'POST' && url.pathname === '/emails') {
        const raw = await readBody(request);
        let payload: { from?: string; to?: string[] | string; subject?: string; html?: string };
        try {
          payload = JSON.parse(raw) as typeof payload;
        } catch {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ message: 'invalid JSON' }));
          return;
        }
        seq += 1;
        const id = randomUUID();
        const key = request.headers['idempotency-key'];
        messages.push({
          id,
          seq,
          to: Array.isArray(payload.to) ? payload.to : payload.to ? [payload.to] : [],
          from: payload.from ?? '',
          subject: payload.subject ?? '',
          html: payload.html ?? '',
          idempotencyKey: typeof key === 'string' ? key : null,
          receivedAt: new Date().toISOString(),
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id }));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/messages') {
        const to = url.searchParams.get('to')?.toLowerCase() ?? null;
        const selected = to
          ? messages.filter((message) =>
              message.to.some((recipient) => recipient.toLowerCase() === to),
            )
          : messages;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ messages: selected }));
        return;
      }

      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'not found' }));
    })();
  };

  return { handler, messages };
}

export function startMailStub(port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const { handler } = createMailStub();
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          ),
      });
    });
  });
}

// Executed directly by Playwright's webServer, imported by the unit test.
if (process.argv[1]?.endsWith('mailStub.ts')) {
  const port = Number(process.env.MAIL_STUB_PORT ?? 4310);
  void startMailStub(port).then(({ url }) => {
    console.log(`mail stub listening on ${url}`);
  });
}
