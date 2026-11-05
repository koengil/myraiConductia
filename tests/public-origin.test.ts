import { describe, expect, it } from 'vitest';
import { resolvePublicOrigin } from '../src/lib/api/v1/publicOrigin';

const request = (url: string) => new Request(url);

describe('resolvePublicOrigin', () => {
  it('prefers the configured public origin over the incoming request host', () => {
    expect(
      resolvePublicOrigin(request('http://internal-runner:3000/api/v1/invites'), {
        NEXT_PUBLIC_APP_URL: 'https://app.conductia.com',
      }),
    ).toBe('https://app.conductia.com');
  });

  it('discards a path, query and trailing slash from the configured value', () => {
    expect(
      resolvePublicOrigin(request('http://localhost:3000/api/v1/invites'), {
        NEXT_PUBLIC_APP_URL: 'https://app.conductia.com/accept-invite?x=1',
      }),
    ).toBe('https://app.conductia.com');
  });

  it('falls back to the request origin when the var is unset or blank', () => {
    expect(resolvePublicOrigin(request('http://localhost:3000/api/v1/invites'), {})).toBe(
      'http://localhost:3000',
    );
    expect(
      resolvePublicOrigin(request('http://localhost:3000/api/v1/invites'), {
        NEXT_PUBLIC_APP_URL: '  ',
      }),
    ).toBe('http://localhost:3000');
  });

  it('throws rather than minting links against a malformed origin', () => {
    expect(() =>
      resolvePublicOrigin(request('http://localhost:3000/api/v1/invites'), {
        NEXT_PUBLIC_APP_URL: 'app.conductia.com',
      }),
    ).toThrow(/NEXT_PUBLIC_APP_URL is not an absolute URL/);
  });
});
