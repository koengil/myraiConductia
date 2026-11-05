import { describe, expect, it } from 'vitest';

import { loadConfig, matchesGlob, route } from '../../scripts/ai-review/router';

const { profiles, fence } = loadConfig('.github/ai-review');
const file = (path: string, additions = 100, deletions = 0) => ({ path, additions, deletions });

describe('matchesGlob', () => {
  it('treats ** as any depth, including none', () => {
    expect(matchesGlob('supabase/migrations/2026_a.sql', 'supabase/migrations/**')).toBe(true);
    expect(matchesGlob('a.test.ts', '**/*.test.ts')).toBe(true);
    expect(matchesGlob('src/deep/x.test.ts', '**/*.test.ts')).toBe(true);
    expect(matchesGlob('infra/envs/prod/iam.tf', 'infra/**/iam.tf')).toBe(true);
    expect(matchesGlob('infra/iam.tf', 'infra/**/iam.tf')).toBe(true);
  });

  it('keeps * inside one segment', () => {
    expect(matchesGlob('src/lib/api/v1/orgAccess.ts', 'src/lib/api/v1/*Access*.ts')).toBe(true);
    expect(matchesGlob('src/lib/api/v1/sub/orgAccess.ts', 'src/lib/api/v1/*Access*.ts')).toBe(false);
    expect(matchesGlob('tests/a/fence.test.ts', 'tests/*fence*.test.ts')).toBe(false);
  });

  it('treats dots and other characters literally', () => {
    expect(matchesGlob('src/middlewarexts', 'src/middleware.ts')).toBe(false);
    expect(matchesGlob('eslint.config.mjs', 'eslint.config.mjs')).toBe(true);
  });
});

describe('route', () => {
  it('always runs the generalist', () => {
    const r = route({ files: [file('README.md')], labels: [] }, profiles, fence);
    expect(r.lenses).toEqual(['generalist']);
    expect(r.small).toBe(false);
    expect(r.runEvaluator).toBe(true);
  });

  it('adds governance for an api path and tests-agentic for a test file', () => {
    const r = route({ files: [file('src/app/api/v1/x/route.ts'), file('tests/x.test.ts')], labels: [] }, profiles, fence);
    expect(r.lenses).toEqual(['generalist', 'governance', 'tests-agentic']);
  });

  it('adds a lens from a label alone', () => {
    const r = route({ files: [file('README.md')], labels: ['Security'] }, profiles, fence);
    expect(r.lenses).toEqual(['generalist', 'governance']);
  });

  it('marks a small PR with no fenced file: generalist only, no evaluator', () => {
    const r = route({ files: [file('src/app/api/v1/x/route.ts', 10, 5)], labels: [] }, profiles, fence);
    expect(r).toEqual({ lenses: ['generalist'], small: true, fenced: [], runEvaluator: false, strictness: 'light' });
  });

  it('still adds a labelled lens to a small PR, with the evaluator', () => {
    const r = route({ files: [file('src/app/api/v1/x/route.ts', 10, 5)], labels: ['security'] }, profiles, fence);
    expect(r).toEqual({ lenses: ['generalist', 'governance'], small: true, fenced: [], runEvaluator: true, strictness: 'light' });
  });

  it('is not small at the threshold', () => {
    const r = route({ files: [file('README.md', 30, 20)], labels: [] }, profiles, fence);
    expect(r.small).toBe(false);
  });

  it('is never small when a fenced file changes, and lists it', () => {
    const r = route({ files: [file('src/middleware.ts', 1, 1)], labels: [] }, profiles, fence);
    expect(r.small).toBe(false);
    expect(r.fenced).toEqual(['src/middleware.ts']);
    expect(r.lenses).toEqual(['generalist', 'governance', 'tests-agentic']);
    expect(r.runEvaluator).toBe(true);
    expect(r.strictness).toBe('strict');
  });

  it('treats requested lenses exactly like labels, even on a small PR', () => {
    const small = [file('README.md', 3, 1)];
    const r = route({ files: small, labels: [] }, profiles, fence, ['tests']);
    expect(r.lenses).toEqual(['generalist', 'tests-agentic']);
    expect(r.runEvaluator).toBe(true);
    expect(route({ files: small, labels: [] }, profiles, fence, []).lenses).toEqual(['generalist']);
  });

  it('reports standard strictness for a normal PR', () => {
    expect(route({ files: [file('README.md')], labels: [] }, profiles, fence).strictness).toBe('standard');
  });

  it('is fenced when a rename moves a file out of a fenced directory', () => {
    const renamed = { path: 'src/lib/session.ts', previousPath: 'src/lib/auth/session.ts', additions: 0, deletions: 0 };
    const r = route({ files: [renamed], labels: [] }, profiles, fence);
    expect(r.small).toBe(false);
    expect(r.fenced).toEqual(['src/lib/auth/session.ts']);
    expect(r.runEvaluator).toBe(true);
  });

  it('routes a lens when a rename moves a file into or out of its path', () => {
    const into = { path: 'src/app/api/v1/x/route.ts', previousPath: 'docs/old-route.ts', additions: 100, deletions: 0 };
    expect(route({ files: [into], labels: [] }, profiles, fence).lenses).toContain('governance');
    const out = { path: 'docs/moved.ts', previousPath: 'src/app/api/v1/x/route.ts', additions: 100, deletions: 0 };
    expect(route({ files: [out], labels: [] }, profiles, fence).lenses).toContain('governance');
  });

  it('lists a fenced path once when both paths match', () => {
    const same = { path: 'src/middleware.ts', previousPath: 'src/middleware.ts', additions: 1, deletions: 1 };
    const r = route({ files: [same], labels: [] }, profiles, fence);
    expect(r.fenced).toEqual(['src/middleware.ts']);
  });
});
