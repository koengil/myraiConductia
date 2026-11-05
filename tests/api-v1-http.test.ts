import { describe, expect, it } from 'vitest';
import { mintDealCode, safeInternalPath } from '@/lib/api/v1/http';
import { safeAuthDestination } from '@/lib/auth/redirect';

describe('safeAuthDestination', () => {
  it('preserves internal paths and query strings', () => {
    expect(safeAuthDestination('/projects/rangers?tab=mail&view=compact')).toBe(
      '/projects/rangers?tab=mail&view=compact',
    );
  });

  it('falls back for external, malformed, and credential-bearing destinations', () => {
    expect(safeAuthDestination('https://evil.example/steal')).toBe('/projects');
    expect(safeAuthDestination('//evil.example/steal')).toBe('/projects');
    expect(safeAuthDestination('/\\evil.example/steal')).toBe('/projects');
    expect(safeAuthDestination('/projects/%ZZ')).toBe('/projects');
    expect(safeAuthDestination('/accept-invite#access_token=secret')).toBe('/projects');
    expect(safeAuthDestination('/projects?token_hash=secret')).toBe('/projects');
  });

  it('prevents auth completion loops', () => {
    expect(safeAuthDestination('/two-factor?redirectTo=/projects')).toBe('/projects');
    expect(safeAuthDestination('/sign-in')).toBe('/projects');
  });

  it('sends retired marketing paths to the platform home', () => {
    expect(safeAuthDestination('/')).toBe('/projects');
    expect(safeAuthDestination('/about')).toBe('/projects');
  });
});

describe('safeInternalPath (open-redirect guard)', () => {
  it('passes a normal in-app path through', () => {
    expect(safeInternalPath('/projects/p-1/mail')).toBe('/projects/p-1/mail');
  });

  it('rejects protocol-relative //host values (the open-redirect vector)', () => {
    // new URL('//evil.com', origin) resolves OFF-SITE — must never pass.
    expect(safeInternalPath('//evil.com')).toBe('/');
    expect(safeInternalPath('/\\evil.com')).toBe('/');
  });

  it('rejects absolute URLs, empty and missing values', () => {
    expect(safeInternalPath('https://evil.com')).toBe('/');
    expect(safeInternalPath('')).toBe('/');
    expect(safeInternalPath(null)).toBe('/');
    expect(safeInternalPath(undefined)).toBe('/');
  });
});

describe('mintDealCode', () => {
  it('derives a PREFIX-YEAR-NNN code from the distinctive word (skips "Project")', () => {
    // "Project Atlas" -> ATLAS, not PROJE (G21: no more PROJE-… collisions).
    expect(mintDealCode('Project Atlas')).toMatch(/^ATLAS-\d{4}-\d{3}$/);
  });

  it('gives distinct prefixes to distinct "Project X" codenames', () => {
    expect(mintDealCode('Project Falcon')).toMatch(/^FALCO-/);
    expect(mintDealCode('Project Heron')).toMatch(/^HERON-/);
  });

  it('uses the codename as-is when there is no "Project" prefix', () => {
    expect(mintDealCode('Falcon')).toMatch(/^FALCO-/);
  });

  it('pads short codenames', () => {
    expect(mintDealCode('A').startsWith('AXXXX-')).toBe(true);
  });
});
