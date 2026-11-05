import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  EXPORT_SIZE,
  arcEndpointToCenter,
  parseMarkSvg,
  PNG_PATH,
  SVG_PATH,
  buildMarkPng,
} from '../scripts/build-email-mark.mjs';

/**
 * The email carries a raster because mail clients will not render SVG. It must
 * be an export of the registered mark, not a redrawing of it.
 *
 * An earlier draft hard-coded the arc centre as (48, 48), the value a reader
 * guesses from a 96-unit viewBox. The SVG's endpoint arc actually implies
 * (48.5757147144, 48). The export was off by more than half a unit and looked
 * fine. So byte-equality is treated here as reproducibility only; fidelity is
 * established against the SVG itself, using arithmetic this test derives
 * independently of the script.
 */

const svgText = readFileSync(SVG_PATH, 'utf8');

/**
 * Independent oracle. Rather than repeat the script's F.6.5 conversion, this
 * derives the centre of a circular arc geometrically: the centre lies on the
 * perpendicular bisector of the chord, at sqrt(r^2 - (chord/2)^2) from its
 * midpoint. Different arithmetic, same answer, so a consistently wrong
 * generator cannot agree with it.
 */
function centreFromChord(svg: string): { cx: number; cy: number; r: number } {
  const d = /<path[^>]*\bd="([^"]+)"/.exec(svg)?.[1];
  if (!d) throw new Error('no path');
  const n = '[-+]?[0-9]*\\.?[0-9]+';
  const m = new RegExp(
    `M\\s*(${n})[\\s,]+(${n})\\s*A\\s*(${n})[\\s,]+(${n})[\\s,]+(${n})[\\s,]+([01])[\\s,]+([01])[\\s,]+(${n})[\\s,]+(${n})`,
  ).exec(d);
  if (!m) throw new Error('no arc');
  const [x1, y1, r, , , largeArc, sweep, x2, y2] = m.slice(1).map(Number);

  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const chord = Math.hypot(x2 - x1, y2 - y1);
  const offset = Math.sqrt(r * r - (chord / 2) ** 2);
  // Unit normal to the chord. Both candidate centres lie along it.
  const nx = -(y2 - y1) / chord;
  const ny = (x2 - x1) / chord;
  const candidates = [
    { cx: mx + offset * nx, cy: my + offset * ny, r },
    { cx: mx - offset * nx, cy: my - offset * ny, r },
  ];

  // Disambiguate by the flags' own definition rather than by a sign
  // convention: traverse each candidate's arc in the `sweep` direction and
  // keep the one whose angular extent matches `largeArc`.
  const TAU = Math.PI * 2;
  const chosen = candidates.find((c) => {
    const t1 = Math.atan2(y1 - c.cy, x1 - c.cx);
    const t2 = Math.atan2(y2 - c.cy, x2 - c.cx);
    let delta = t2 - t1;
    if (sweep === 1 && delta < 0) delta += TAU;
    if (sweep === 0 && delta > 0) delta -= TAU;
    return (Math.abs(delta) > Math.PI) === (largeArc === 1);
  });
  if (!chosen) throw new Error('no candidate centre matches the arc flags');
  return chosen;
}

describe('the exported mark', () => {
  it('is a 56px opaque PNG', () => {
    const bytes = readFileSync(PNG_PATH);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect(bytes.readUInt32BE(16)).toBe(EXPORT_SIZE);
    expect(bytes.readUInt32BE(20)).toBe(EXPORT_SIZE);
    expect(bytes[24]).toBe(8); // bit depth
    expect(bytes[25]).toBe(2); // truecolour, no alpha
  });

  it('is the asset the current source produces', () => {
    // A stale checked-in PNG fails here, so the SVG and the export cannot drift.
    expect(buildMarkPng().png.equals(readFileSync(PNG_PATH))).toBe(true);
  });

  it('regenerates byte for byte', () => {
    // Reproducibility only. This proves the generator repeats itself; it says
    // nothing about whether it is right.
    expect(buildMarkPng().png.equals(buildMarkPng().png)).toBe(true);
  });
});

describe('arc geometry', () => {
  it('derives the centre the SVG implies, not the one the viewBox suggests', () => {
    const oracle = centreFromChord(svgText);
    const derived = arcEndpointToCenter(parseMarkSvg(svgText).arc);

    expect(derived.cx).toBeCloseTo(oracle.cx, 9);
    expect(derived.cy).toBeCloseTo(oracle.cy, 9);
    expect(derived.rx).toBeCloseTo(oracle.r, 9);

    // The specific trap: the centre is measurably not (48, 48).
    expect(Math.abs(derived.cx - 48)).toBeGreaterThan(0.5);
    expect(derived.cx).toBeCloseTo(48.5757147144, 9);
  });

  it('keeps the centre out of the generator as a constant', () => {
    // The value must be computed from the asset every time, so that editing the
    // SVG moves the export.
    const script = readFileSync(resolve(process.cwd(), 'scripts/build-email-mark.mjs'), 'utf8');
    const code = script.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    expect(code).not.toContain('48.57');
  });
});

describe('the raster agrees with the source geometry', () => {
  /**
   * Fidelity is established without the production parser, converter or
   * renderer. This block reads the SVG's numbers itself, derives the centre,
   * start angle and sweep itself, rasterises with its own sampler, decodes the
   * committed PNG itself, and compares every pixel. A generator that is
   * consistently wrong, or a brand asset that changes, fails here.
   */
  const geom = (() => {
    const viewBox = /viewBox="([\d.\-\s]+)"/.exec(svgText);
    if (!viewBox) throw new Error('no viewBox');
    const [minX, minY, vbW] = viewBox[1].trim().split(/\s+/).map(Number);
    const d = /<path[^>]*\sd="([^"]+)"/.exec(svgText);
    if (!d) throw new Error('no path');
    const a =
      /M\s*([\d.\-]+)[\s,]+([\d.\-]+)\s*A\s*([\d.\-]+)[\s,]+([\d.\-]+)[\s,]+([\d.\-]+)[\s,]+([01])[\s,]+([01])[\s,]+([\d.\-]+)[\s,]+([\d.\-]+)/.exec(
        d[1],
      );
    if (!a) throw new Error('unrecognised arc');
    const [x1, y1] = [Number(a[1]), Number(a[2])];
    const [x2, y2] = [Number(a[8]), Number(a[9])];
    const sweepFlag = Number(a[7]);
    const sw = Number(/stroke-width="([\d.]+)"/.exec(svgText)?.[1]);
    const cap = /stroke-linecap="(\w+)"/.exec(svgText)?.[1] ?? 'butt';
    const stroke = /stroke="(#[0-9a-fA-F]{6})"/.exec(svgText)?.[1];
    const c = /<circle[^>]*cx="([\d.]+)"[^>]*cy="([\d.]+)"[^>]*r="([\d.]+)"/.exec(svgText);
    if (!c || !stroke || !Number.isFinite(sw)) throw new Error('unrecognised mark');
    const { cx, cy, r } = centreFromChord(svgText);
    // Start angle and sweep, derived here rather than imported.
    const theta1 = Math.atan2(y1 - cy, x1 - cx);
    let delta = Math.atan2(y2 - cy, x2 - cx) - theta1;
    const TAU = Math.PI * 2;
    if (sweepFlag === 1 && delta < 0) delta += TAU;
    if (sweepFlag === 0 && delta > 0) delta -= TAU;
    const ink = {
      r: parseInt(stroke.slice(1, 3), 16),
      g: parseInt(stroke.slice(3, 5), 16),
      b: parseInt(stroke.slice(5, 7), 16),
    };
    return {
      minX, minY, vbW, x1, y1, x2, y2, sw, cap, ink, cx, cy, r, theta1, delta,
      dot: { cx: Number(c[1]), cy: Number(c[2]), r: Number(c[3]) },
    };
  })();

  /** Decode the committed PNG here; the encoder is not consulted. */
  const decoded = (() => {
    const buf = readFileSync(PNG_PATH);
    let off = 8;
    const idat: Buffer[] = [];
    let width = 0;
    let height = 0;
    while (off < buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const data = buf.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        expect(data[8], 'bit depth').toBe(8);
        expect(data[9], 'colour type').toBe(2);
      }
      if (type === 'IDAT') idat.push(data);
      if (type === 'IEND') break;
      off += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * 3;
    const px = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * (stride + 1);
      expect(raw[rowStart], `filter byte on row ${y}`).toBe(0);
      px.set(raw.subarray(rowStart + 1, rowStart + 1 + stride), y * stride);
    }
    return { width, height, px };
  })();

  /** Coverage from an 8x8 grid: a different sampler to the generator's 4x4. */
  const coverageAt = (px: number, py: number, dx = 0) => {
    const scale = geom.vbW / EXPORT_SIZE;
    const cx = geom.cx + dx;
    const half = geom.sw / 2;
    const TAU = Math.PI * 2;
    let hits = 0;
    for (let j = 0; j < 8; j += 1) {
      for (let i = 0; i < 8; i += 1) {
        const ux = geom.minX + (px + (i + 0.5) / 8) * scale;
        const uy = geom.minY + (py + (j + 0.5) / 8) * scale;
        let inside = Math.hypot(ux - geom.dot.cx, uy - geom.dot.cy) <= geom.dot.r;
        if (!inside && Math.abs(Math.hypot(ux - cx, uy - geom.cy) - geom.r) <= half) {
          let s = Math.atan2(uy - geom.cy, ux - cx) - geom.theta1;
          if (geom.delta > 0) {
            while (s < 0) s += TAU;
            inside = s <= geom.delta;
          } else {
            while (s > 0) s -= TAU;
            inside = s >= geom.delta;
          }
        }
        if (!inside && geom.cap === 'round') {
          inside =
            Math.hypot(ux - (geom.x1 + dx), uy - geom.y1) <= half ||
            Math.hypot(ux - (geom.x2 + dx), uy - geom.y2) <= half;
        }
        if (inside) hits += 1;
      }
    }
    return hits / 64;
  };

  it('matches the source geometry at every pixel', () => {
    expect(decoded.width).toBe(EXPORT_SIZE);
    expect(decoded.height).toBe(EXPORT_SIZE);
    let inked = 0;
    let paper = 0;
    let edge = 0;
    for (let py = 0; py < EXPORT_SIZE; py += 1) {
      for (let px = 0; px < EXPORT_SIZE; px += 1) {
        const o = (py * EXPORT_SIZE + px) * 3;
        const got = { r: decoded.px[o], g: decoded.px[o + 1], b: decoded.px[o + 2] };
        const cov = coverageAt(px, py);
        const where = `${px},${py}`;
        if (cov === 1) {
          // Wholly inside a primitive: the ink the SVG declares, exactly.
          expect(got, `ink at ${where}`).toEqual(geom.ink);
          inked += 1;
        } else if (cov === 0) {
          // Wholly outside: paper, exactly. Tolerance is confined to edges.
          expect(got, `paper at ${where}`).toEqual({ r: 255, g: 255, b: 255 });
          paper += 1;
        } else {
          expect(got.r, `blend at ${where}`).toBeGreaterThanOrEqual(geom.ink.r);
          expect(got.r, `blend at ${where}`).toBeLessThanOrEqual(255);
          edge += 1;
        }
      }
    }
    // The comparison is only meaningful if it is mostly decisive pixels.
    expect(inked).toBeGreaterThan(200);
    expect(paper).toBeGreaterThan(1000);
    expect(edge).toBeLessThan(EXPORT_SIZE * EXPORT_SIZE * 0.3);
  });

  it('would not match if the centre moved by the error an earlier draft made', () => {
    // Mutation sensitivity: reclassify against centre 48 and require the
    // committed raster to disagree on decisive pixels.
    const dx = 48 - geom.cx;
    let disagreements = 0;
    for (let py = 0; py < EXPORT_SIZE; py += 1) {
      for (let px = 0; px < EXPORT_SIZE; px += 1) {
        const cov = coverageAt(px, py, dx);
        if (cov !== 1 && cov !== 0) continue;
        const o = (py * EXPORT_SIZE + px) * 3;
        const isInk = decoded.px[o] === geom.ink.r;
        if ((cov === 1) !== isInk) disagreements += 1;
      }
    }
    expect(disagreements).toBeGreaterThan(0);
  });
});

describe('the asset route', () => {
  const matcher = (() => {
    const source = readFileSync(resolve(process.cwd(), 'src/middleware.ts'), 'utf8');
    const patterns = [...source.matchAll(/'(\/[^']*)'/g)].map((m) => m[1]);
    const guard = patterns.find((p) => p.includes('(?!'));
    if (!guard) throw new Error('no middleware guard pattern found');
    // Next matches the whole path, so anchor: an unanchored RegExp could
    // resume matching at a later slash and misread the exclusion.
    return new RegExp(`^${guard}$`);
  })();

  it('leaves the brand asset unguarded so a mail client can fetch it', () => {
    expect(matcher.test('/conductia/email/conductia-mark-ink.png')).toBe(false);
  });

  it('still guards the product', () => {
    expect(matcher.test('/projects/PROJECT-X/team')).toBe(true);
    expect(matcher.test('/projects/PROJECT-X/data-room')).toBe(true);
  });

  it('opens nothing else under the public folder', () => {
    expect(matcher.test('/conductia/og-cover.png')).toBe(true);
  });

  it('exempts the directory, not everything whose name starts with it', () => {
    // A bare `conductia/email` alternative would also unguard these, because
    // the lookahead matches a prefix rather than a path segment.
    expect(matcher.test('/conductia/email-private')).toBe(true);
    expect(matcher.test('/conductia/emailAnything')).toBe(true);
    expect(matcher.test('/conductia/emails/private')).toBe(true);
    expect(matcher.test('/conductia/email')).toBe(true);
  });
});
