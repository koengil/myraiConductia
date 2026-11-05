import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT_ID,
  resolveProjectId,
  withProjectId,
} from '@/lib/project/resolveProjectId';

describe('resolveProjectId', () => {
  it('returns a plain string segment unchanged', () => {
    expect(resolveProjectId('project-summit')).toBe('project-summit');
  });

  it('collapses a string[] to the first segment', () => {
    expect(resolveProjectId(['project-summit', 'extra'])).toBe('project-summit');
  });

  it('falls back to the sandbox default for undefined', () => {
    expect(resolveProjectId(undefined)).toBe(DEFAULT_PROJECT_ID);
  });

  it('falls back to the default for an empty/whitespace segment', () => {
    expect(resolveProjectId('')).toBe(DEFAULT_PROJECT_ID);
    expect(resolveProjectId('   ')).toBe(DEFAULT_PROJECT_ID);
  });

  it('passes a real deal CODE segment through unchanged (G14 URL scheme)', () => {
    expect(resolveProjectId('SUM-2026-014')).toBe('SUM-2026-014');
  });
});

describe('withProjectId — in-context deal switch', () => {
  it('swaps the deal but keeps the sub-route', () => {
    expect(withProjectId('/projects/project-summit/acquirers', 'project-harbor')).toBe(
      '/projects/project-harbor/acquirers',
    );
    expect(withProjectId('/projects/project-summit/rail', 'project-harbor')).toBe(
      '/projects/project-harbor/rail',
    );
  });

  it('handles the deal root (no sub-route)', () => {
    expect(withProjectId('/projects/project-summit', 'project-harbor')).toBe(
      '/projects/project-harbor',
    );
  });

  it('keeps deeper nested sub-routes intact', () => {
    expect(
      withProjectId('/projects/project-summit/acquirers/anthropic', 'project-harbor'),
    ).toBe('/projects/project-harbor/acquirers/anthropic');
  });

  it('leaves a non-project pathname unchanged', () => {
    expect(withProjectId('/companies', 'project-harbor')).toBe('/companies');
    expect(withProjectId('/profile', 'project-harbor')).toBe('/profile');
  });

  it('swaps to a real deal CODE segment (G14 URL scheme)', () => {
    expect(withProjectId('/projects/SUM-2026-014/rail', 'HAR-2026-021')).toBe(
      '/projects/HAR-2026-021/rail',
    );
  });
});
