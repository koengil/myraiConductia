import { describe, expect, it } from 'vitest';
import {
  secondsRemainingInStep,
  totpCode,
} from '../e2e/support/totp';

// RFC 6238 Appendix B, SHA-1, 8 digits, on the ASCII secret "12345678901234567890".
// Base32 of that secret is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ; the RFC's vectors
// are 8-digit, so the 6-digit expectation is the RFC value truncated on the
// left, which is exactly what a 6-digit authenticator shows.
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totpCode', () => {
  it('matches the RFC 6238 vector at T = 59s', () => {
    expect(totpCode(RFC_SECRET_BASE32, 59_000)).toBe('287082');
  });

  it('matches the RFC 6238 vector at T = 1111111109s', () => {
    expect(totpCode(RFC_SECRET_BASE32, 1_111_111_109_000)).toBe('081804');
  });

  it('matches the RFC 6238 vector at T = 1234567890s', () => {
    expect(totpCode(RFC_SECRET_BASE32, 1_234_567_890_000)).toBe('005924');
  });

  it('tolerates a lowercase, padded secret the way an authenticator app does', () => {
    expect(totpCode('gezdgnbvgy3tqojqgezdgnbvgy3tqojq====', 59_000)).toBe('287082');
  });

  it('returns the same code across one 30-second step', () => {
    expect(totpCode(RFC_SECRET_BASE32, 30_000)).toBe(totpCode(RFC_SECRET_BASE32, 59_999));
  });
});

describe('secondsRemainingInStep', () => {
  it('is 30 at the top of a step and 1 at its end', () => {
    expect(secondsRemainingInStep(30_000)).toBe(30);
    expect(secondsRemainingInStep(59_000)).toBe(1);
  });
});
