// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { afterQuery, floorMsOf, inWindow, isWindowDate } from '@/lib/google/reader/window';

// The ingestion window's pure helpers (#353): the floor is 00:00 UTC of the first day, the listing query is one day
// early in epoch seconds, and the per-message check is a half-open range.
describe('the ingestion window helpers (#353)', () => {
  it('reads the floor as 00:00 UTC of the window day, and no window as none', () => {
    expect(floorMsOf('2026-07-17')).toBe(Date.UTC(2026, 6, 17));
    expect(new Date(floorMsOf('2026-07-17')!).toISOString()).toBe('2026-07-17T00:00:00.000Z');
    expect(floorMsOf(null)).toBeNull();
    expect(floorMsOf(undefined)).toBeNull();
  });

  it('refuses a window start that is not a real YYYY-MM-DD day', () => {
    for (const bad of ['2026-7-17', '2026/07/17', '2026-02-30', '2026-13-01', '17-07-2026', '2026-07-17T00:00:00Z', '']) {
      expect(isWindowDate(bad), bad).toBe(false);
      expect(() => floorMsOf(bad), bad).toThrow('gmail reader: unreadable window start');
    }
    expect(isWindowDate(20260717)).toBe(false);
    expect(isWindowDate('2024-02-29')).toBe(true);
  });

  it('asks Gmail for one day of slack before the floor, in epoch seconds', () => {
    const floor = Date.UTC(2026, 6, 17);
    expect(afterQuery(floor)).toBe(`after:${floor / 1000 - 86_400}`);
    expect(afterQuery(floor)).toBe('after:1784160000');
  });

  it('keeps a message at the floor, drops one a millisecond before it, and keeps everything without a floor', () => {
    const floor = Date.UTC(2026, 6, 17);
    expect(inWindow(String(floor), floor)).toBe(true);
    expect(inWindow(String(floor - 1), floor)).toBe(false);
    expect(inWindow(floor + 86_400_000, floor)).toBe(true);
    expect(inWindow('0', null)).toBe(true);
    expect(inWindow(undefined, null)).toBe(true);
  });

  it('leaves out a message with no usable date from a bounded read', () => {
    const floor = Date.UTC(2026, 6, 17);
    expect(inWindow(undefined, floor)).toBe(false);
    expect(inWindow('not a number', floor)).toBe(false);
  });

  it('is range-shaped: a ceiling is exclusive, for the gap read a later slice adds', () => {
    const floor = Date.UTC(2026, 3, 18);
    const ceiling = Date.UTC(2026, 6, 17);
    expect(inWindow(String(floor), floor, ceiling)).toBe(true);
    expect(inWindow(String(ceiling - 1), floor, ceiling)).toBe(true);
    expect(inWindow(String(ceiling), floor, ceiling)).toBe(false);
    expect(inWindow(String(ceiling), null, ceiling)).toBe(false);
  });
});
