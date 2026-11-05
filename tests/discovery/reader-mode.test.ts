// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { READER_MODE } from '@/lib/constants/discovery';
import { readerModeFromEnv } from '@/lib/discovery/source/mode';

describe('readerModeFromEnv (#259, C12)', () => {
  it('reads DISCOVERY_READER_MODE: fixture and live', () => {
    expect(readerModeFromEnv({ DISCOVERY_READER_MODE: 'fixture' })).toBe(READER_MODE.FIXTURE);
    expect(readerModeFromEnv({ DISCOVERY_READER_MODE: ' live ' })).toBe(READER_MODE.LIVE);
  });

  it('keeps GRAPH_READER_PROVIDER and the value graph as aliases for one release', () => {
    expect(readerModeFromEnv({ GRAPH_READER_PROVIDER: 'fixture' })).toBe(READER_MODE.FIXTURE);
    expect(readerModeFromEnv({ GRAPH_READER_PROVIDER: 'graph' })).toBe(READER_MODE.LIVE);
    expect(readerModeFromEnv({ DISCOVERY_READER_MODE: 'graph' })).toBe(READER_MODE.LIVE);
  });

  it('prefers DISCOVERY_READER_MODE over the old name', () => {
    expect(readerModeFromEnv({ DISCOVERY_READER_MODE: 'live', GRAPH_READER_PROVIDER: 'fixture' })).toBe(READER_MODE.LIVE);
  });

  it('has no default: a worker started without a mode must not guess', () => {
    expect(() => readerModeFromEnv({})).toThrow('DISCOVERY_READER_MODE must be set to "fixture" or "live"');
    expect(() => readerModeFromEnv({ DISCOVERY_READER_MODE: '' })).toThrow(/must be set/);
    expect(() => readerModeFromEnv({ DISCOVERY_READER_MODE: 'gmail' })).toThrow(/must be set/);
  });

  it('refuses the fixture in production, under either name', () => {
    expect(() => readerModeFromEnv({ DISCOVERY_READER_MODE: 'fixture', NEXT_PUBLIC_APP_ENV: 'prod' })).toThrow(/refused in production/);
    expect(() => readerModeFromEnv({ GRAPH_READER_PROVIDER: 'fixture', NEXT_PUBLIC_APP_ENV: 'prod' })).toThrow(/refused in production/);
    for (const appEnv of [' PROD', 'production', 'Production\n']) {
      expect(() => readerModeFromEnv({ DISCOVERY_READER_MODE: 'fixture', NEXT_PUBLIC_APP_ENV: appEnv }), appEnv).toThrow(/refused in production/);
    }
    expect(readerModeFromEnv({ DISCOVERY_READER_MODE: 'live', NEXT_PUBLIC_APP_ENV: 'prod' })).toBe(READER_MODE.LIVE);
  });
});
