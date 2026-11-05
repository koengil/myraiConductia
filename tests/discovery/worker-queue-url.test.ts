// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { databaseUrlFromEnv } from '../../worker/boss';

// The queue connection logs in as discovery_queue
// (20260925160000_discovery_queue_role.sql). In production the worker never
// falls back to DATABASE_URL, the table owner.
const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

describe('the discovery worker queue connection', () => {
  const queue = 'postgresql://discovery_queue.ref:pw@pooler.example:5432/postgres';
  const owner = 'postgresql://postgres.ref:pw@pooler.example:5432/postgres';

  it('uses DISCOVERY_QUEUE_DATABASE_URL when it is set', () => {
    expect(databaseUrlFromEnv(env({ DISCOVERY_QUEUE_DATABASE_URL: queue, DATABASE_URL: owner }))).toBe(queue);
    expect(databaseUrlFromEnv(env({ DISCOVERY_QUEUE_DATABASE_URL: queue, NEXT_PUBLIC_APP_ENV: 'prod' }))).toBe(queue);
  });

  it('falls back to DATABASE_URL outside production only', () => {
    expect(databaseUrlFromEnv(env({ DATABASE_URL: owner }))).toBe(owner);
    expect(() => databaseUrlFromEnv(env({ DATABASE_URL: owner, NEXT_PUBLIC_APP_ENV: ' Production ' }))).toThrow(
      /DISCOVERY_QUEUE_DATABASE_URL in production/,
    );
    expect(() => databaseUrlFromEnv(env({ DATABASE_URL: owner, NEXT_PUBLIC_APP_ENV: 'prod' }))).toThrow(
      /DISCOVERY_QUEUE_DATABASE_URL in production/,
    );
  });

  it('refuses to start with neither', () => {
    expect(() => databaseUrlFromEnv(env({}))).toThrow(/DISCOVERY_QUEUE_DATABASE_URL/);
  });
});
