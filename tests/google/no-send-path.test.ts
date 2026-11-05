// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GMAIL_READER_SCOPE } from '@/lib/constants/googleReader';

const root = process.cwd();

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const IMPORT_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
const importsOf = (path: string): string[] => [...readFileSync(path, 'utf8').matchAll(IMPORT_RE)].map((m) => m[1]);

describe('the Google reader has no send path', () => {
  const googleFiles = walk(join(root, 'src/lib/google'));

  it('finds the Google reader files', () => {
    expect(googleFiles.length).toBeGreaterThan(0);
  });

  it('imports nothing from src/lib/email, and nothing under src/lib/email imports Google', () => {
    for (const file of googleFiles) {
      const bad = importsOf(file).filter((spec) => /(^|\/)lib\/email(\/|$)/.test(spec) || /(^|\/)email(\/|$)/.test(spec));
      expect(bad, relative(root, file)).toEqual([]);
    }
    for (const file of walk(join(root, 'src/lib/email'))) {
      const bad = importsOf(file).filter((spec) => /(^|\/)lib\/google(\/|$)/.test(spec) || spec.startsWith('google-auth-library') || spec === 'googleapis');
      expect(bad, relative(root, file)).toEqual([]);
    }
  });

  it('requests only the two mail reader scopes, plus cloud-platform in credentials.ts', () => {
    const allowedEverywhere = new Set<string>(Object.values(GMAIL_READER_SCOPE));
    for (const file of walk(join(root, 'src/lib/google/reader'))) {
      const scopes = [...readFileSync(file, 'utf8').matchAll(/https:\/\/www\.googleapis\.com\/auth\/[a-z._-]+/g)].map((m) => m[0]);
      const allowed = new Set(allowedEverywhere);
      if (file.endsWith('credentials.ts')) allowed.add('https://www.googleapis.com/auth/cloud-platform');
      const extra = scopes.filter((s) => !allowed.has(s));
      expect(extra, relative(root, file)).toEqual([]);
    }
  });
});
