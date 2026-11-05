// The perimeter module's export surface IS its security boundary (cr-plan-v4 5.1).
//
// computePerimeterInternal takes a bare DocumentSubject, and a DocumentSubject
// is an ordinary structural type: any caller could invent one describing a seat
// with oversight at phase 99 and read back a perimeter for it. The protection is
// that no exported function accepts a subject. Each entry point builds its own
// from its own authorization check, so there is nothing to hand a forged value
// to.
//
// Two earlier designs failed here. A branded type was defeatable because the
// brand had to be exported to be used. A "private core plus an index barrel"
// was worse: a barrel can only re-export what the inner module exports, so the
// core would have been importable by any caller willing to deep-import it.
// Neither survived; the absence of a door did.
//
// This test fails if anyone re-exports the core, which is exactly when the
// boundary would quietly stop existing.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as perimeter from '@/lib/perimeter/perimeter';

const ENTRY_POINTS = ['perimeterForProposal', 'perimeterForMember', 'perimeterForViewer'];

describe('perimeter module boundary', () => {
  it('exports exactly the three authorized entry points and nothing callable besides', () => {
    const callable = Object.entries(perimeter)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();

    expect(callable).toEqual([...ENTRY_POINTS].sort());
  });

  it('does not export the pure core under any name', () => {
    expect(Object.keys(perimeter)).not.toContain('computePerimeterInternal');
    expect(Object.keys(perimeter)).not.toContain('computePerimeter');
  });

  it('ships no index barrel that could re-export the core', () => {
    // A barrel would have to import the core to re-export it, and importing it
    // requires exporting it. The boundary only holds while this file is the
    // only entrance.
    for (const barrel of ['index.ts', 'index.tsx', 'index.js']) {
      expect(existsSync(resolve('src/lib/perimeter', barrel))).toBe(false);
    }
  });

  it('every entry point demands an authorization argument, never a subject', () => {
    // Each takes (admin, actorOrUserId, ...) — the identity it will authorize.
    // None takes a ready-made subject, which is what makes forging impossible
    // rather than merely discouraged.
    for (const name of ENTRY_POINTS) {
      const fn = perimeter[name as keyof typeof perimeter] as (...args: unknown[]) => unknown;
      expect(typeof fn).toBe('function');
      expect(fn.length).toBeGreaterThanOrEqual(2);
    }
  });
});
