import { describe, expect, it } from 'vitest';

import {
  boxEnvironmentName,
  getBoxClientSecret,
} from '@/lib/box/env';

describe('boxEnvironmentName', () => {
  it('maps app env to the Box root partition folder', () => {
    expect(boxEnvironmentName('dev')).toBe('develop');
    expect(boxEnvironmentName('staging')).toBe('staging');
    expect(boxEnvironmentName('prod')).toBe('production');
    expect(boxEnvironmentName(undefined)).toBe('develop');
  });
});

describe('getBoxClientSecret', () => {
  it('prefers BOX_SECRET and falls back to BOX_CLIENT_SECRET', () => {
    expect(getBoxClientSecret({ BOX_SECRET: ' primary ', BOX_CLIENT_SECRET: 'legacy' })).toBe(
      'primary',
    );
    expect(getBoxClientSecret({ BOX_CLIENT_SECRET: ' legacy ' })).toBe('legacy');
    expect(getBoxClientSecret({})).toBeUndefined();
  });
});
