import { describe, it, expect } from 'vitest';
import { GET } from '../src/app/api/intellibank/acquirers/route';

/**
 * Smoke test for the representative /api/intellibank/acquirers route
 * handler (Phase F sandbox merge, 2026-05-20). Calls the handler
 * directly — Next.js App Router route handlers are plain async functions
 * returning a Response, so the test runtime can invoke them without a
 * server. Verifies the network surface returns the same shape as the
 * in-process getApi().getAcquirers() call.
 */
describe('GET /api/intellibank/acquirers', () => {
  it('returns the acquirer list as JSON', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    // 5 acquirers in the fixture set (Anthropic, Salesforce, Microsoft,
    // Adobe, ServiceNow).
    expect(data.length).toBe(5);
  });

  it('the returned acquirers carry an id and a name field', async () => {
    const res = await GET();
    const data = (await res.json()) as Array<{ id: string; name: string }>;
    for (const a of data) {
      expect(typeof a.id).toBe('string');
      expect(typeof a.name).toBe('string');
    }
  });

  it('returns Anthropic and Salesforce as known fixture identifiers', async () => {
    const res = await GET();
    const data = (await res.json()) as Array<{ id: string }>;
    const ids = data.map((a) => a.id);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('salesforce');
  });
});
