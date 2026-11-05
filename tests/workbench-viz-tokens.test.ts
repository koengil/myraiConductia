import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VIZ_CATEGORICAL_COLORS, VIZ_CLIENT_COLOR } from '@/lib/leads/crmNetwork';

/*
 * The CRM network graph carries its cluster colours as hex in the API payload
 * (and derives alpha tints from them), so the scale lives in TS as well as in
 * CSS. This pins the three copies together and guards the scale's rules:
 * no violet (reserved for Casey), no status hue, graphic contrast on canvas.
 */

const NAMES = ['--viz-client', ...VIZ_CATEGORICAL_COLORS.map((_, i) => `--viz-${i + 1}`)];
const EXPECTED = [VIZ_CLIENT_COLOR, ...VIZ_CATEGORICAL_COLORS];

function workbenchVizTokens(path: string): Record<string, string> {
  const css = readFileSync(join(process.cwd(), path), 'utf8');
  const start = css.indexOf("[data-palette='workbench'] {");
  expect(start, `${path} has a workbench block`).toBeGreaterThanOrEqual(0);
  const block = css.slice(start, css.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--viz-[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function hue(hex: string): number {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

describe('workbench data-viz scale', () => {
  it('globals.css and tokens.css define the same values as crmNetwork.ts', () => {
    const expected = Object.fromEntries(NAMES.map((n, i) => [n, EXPECTED[i]]));
    expect(workbenchVizTokens('src/app/globals.css')).toEqual(expected);
    expect(workbenchVizTokens('docs/design/workbench/tokens.css')).toEqual(expected);
  });

  it('keeps graphic contrast (>= 3:1) on the graph canvas (--surface-warm #f5f4f1)', () => {
    for (const color of EXPECTED) {
      expect(contrast(color, '#f5f4f1'), color).toBeGreaterThanOrEqual(3);
    }
  });

  it('uses no violet or purple hue and stays clear of the status and Casey hues', () => {
    const reserved = ['#17b26a', '#f5a524', '#e5484d', '#2e90fa', '#5e5ce6'].map(hue);
    for (const color of VIZ_CATEGORICAL_COLORS) {
      const h = hue(color);
      expect(h >= 250 && h <= 330, `${color} hue ${h.toFixed(0)} is violet/purple`).toBe(false);
      for (const r of reserved) {
        expect(hueDistance(h, r), `${color} too close to reserved hue ${r.toFixed(0)}`).toBeGreaterThanOrEqual(15);
      }
    }
  });
});
