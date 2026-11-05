import { describe, expect, it, afterEach } from 'vitest';
import { startMailStub } from '../e2e/support/mailStub';

let close: (() => Promise<void>) | null = null;

afterEach(async () => {
  await close?.();
  close = null;
});

describe('the E2E mail stub', () => {
  it('accepts a Resend-shaped send and reads it back in arrival order', async () => {
    const stub = await startMailStub(0);
    close = stub.close;

    await fetch(`${stub.url}/emails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-code' },
      body: JSON.stringify({
        from: 'Conductia <invites@e2e.local>',
        to: ['director@e2e-external.test'],
        subject: 'Your Conductia verification code (1)',
        html: '<p>Your Conductia verification code is <strong>314159</strong>.</p>',
      }),
    });
    await fetch(`${stub.url}/emails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-link' },
      body: JSON.stringify({
        from: 'Conductia <invites@e2e.local>',
        to: ['director@e2e-external.test'],
        subject: 'You have a Conductia invitation',
        html: '<a href="http://127.0.0.1:54321/auth/v1/verify?token=abc">Continue securely</a>',
      }),
    });

    const res = await fetch(`${stub.url}/messages?to=director@e2e-external.test`);
    const body = (await res.json()) as { messages: Array<Record<string, unknown>> };

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].subject).toBe('Your Conductia verification code (1)');
    expect(body.messages[0].idempotencyKey).toBe('k-code');
    expect(body.messages[1].subject).toBe('You have a Conductia invitation');
    expect(body.messages[0].seq).toBeLessThan(body.messages[1].seq as number);
  });

  it('answers a send with an id, the way Resend does', async () => {
    const stub = await startMailStub(0);
    close = stub.close;

    const res = await fetch(`${stub.url}/emails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'a@b.test', to: ['c@d.test'], subject: 's', html: 'h' }),
    });

    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as { id?: unknown }).id).toBe('string');
  });

  it('filters by recipient, case-insensitively', async () => {
    const stub = await startMailStub(0);
    close = stub.close;

    await fetch(`${stub.url}/emails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'a@b.test', to: ['Someone@E2E.test'], subject: 's', html: 'h' }),
    });

    const res = await fetch(`${stub.url}/messages?to=someone@e2e.test`);
    expect(((await res.json()) as { messages: unknown[] }).messages).toHaveLength(1);
  });
});
