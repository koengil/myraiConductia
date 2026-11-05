#!/usr/bin/env node
/**
 * Export the canonical Conductia mark to a raster for email.
 *
 * Mail clients do not render SVG reliably, so the invitation carries a PNG.
 * That PNG must be the *registered* mark, not a redrawing of it, so this script
 * takes `conductia-mark-ink.svg` as input and derives every coordinate from it.
 *
 * The one thing this script must not do is write down the arc's centre. The SVG
 * declares the arc in endpoint form:
 *
 *     M 70 27 A 30 30 0 1 0 70 69
 *
 * Those are endpoints. The implied centre is (48.5757147144, 48), which is not
 * the (48, 48) a reader guesses from the 96-unit viewBox. An earlier draft of
 * this script hard-coded that guess and was off by 0.58 units, exporting a mark
 * that was nearly right and therefore wrong. The endpoint-to-centre conversion
 * below is the SVG implementation-notes F.6.5 algorithm, and it is the only
 * source of the centre.
 *
 * Dependency-free by construction: node:fs and node:zlib only.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SVG_PATH = resolve(HERE, '../src/components/brand/assets/conductia-mark-ink.svg');
export const PNG_PATH = resolve(HERE, '../public/conductia/email/conductia-mark-ink.png');

/** Displayed at 28px; exported at 2x so it stays crisp on high-density mail. */
export const EXPORT_SIZE = 56;
/** Coverage samples per axis, per output pixel. */
export const SUPERSAMPLE = 4;
/** The mark is composited at generation time against the header's flat white,
 *  because alpha is the least consistent part of the mail-client matrix. */
export const BACKGROUND = { r: 0xff, g: 0xff, b: 0xff };

const num = '[-+]?[0-9]*\\.?[0-9]+(?:[eE][-+]?[0-9]+)?';

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

function hexToRgb(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`mark: expected a 6-digit hex colour, got ${hex}`);
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

/**
 * Parse the two primitives the registered mark is made of. Anything else is a
 * different asset, and a build that quietly approximated it would reintroduce
 * exactly the defect this script exists to prevent.
 */
export function parseMarkSvg(svgText) {
  const viewBox = attr(svgText, 'viewBox');
  if (!viewBox) throw new Error('mark: the SVG declares no viewBox');
  const vb = viewBox.trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) {
    throw new Error(`mark: unreadable viewBox "${viewBox}"`);
  }

  const paths = svgText.match(/<path\b[^>]*>/g) ?? [];
  const circles = svgText.match(/<circle\b[^>]*>/g) ?? [];
  if (paths.length !== 1 || circles.length !== 1) {
    throw new Error(
      `mark: expected exactly one <path> and one <circle>, found ${paths.length} and ${circles.length}`,
    );
  }

  const d = attr(paths[0], 'd');
  if (!d) throw new Error('mark: the <path> has no d');
  const arcRe = new RegExp(
    `^\\s*M\\s*(${num})[\\s,]+(${num})\\s*A\\s*(${num})[\\s,]+(${num})[\\s,]+(${num})[\\s,]+([01])[\\s,]+([01])[\\s,]+(${num})[\\s,]+(${num})\\s*$`,
  );
  const a = arcRe.exec(d);
  if (!a) {
    throw new Error(
      `mark: the path must be exactly one moveto plus one arc, got "${d}". A new brand asset must stop this build rather than be approximated.`,
    );
  }
  const [, x1, y1, rx, ry, phi, fA, fS, x2, y2] = a.map(Number);

  const strokeWidth = Number(attr(paths[0], 'stroke-width'));
  if (!Number.isFinite(strokeWidth)) throw new Error('mark: the <path> has no stroke-width');
  const strokeLinecap = attr(paths[0], 'stroke-linecap') ?? 'butt';
  const stroke = attr(paths[0], 'stroke');
  if (!stroke) throw new Error('mark: the <path> has no stroke colour');

  const circle = {
    cx: Number(attr(circles[0], 'cx')),
    cy: Number(attr(circles[0], 'cy')),
    r: Number(attr(circles[0], 'r')),
    fill: attr(circles[0], 'fill'),
  };
  if (![circle.cx, circle.cy, circle.r].every(Number.isFinite) || !circle.fill) {
    throw new Error('mark: the <circle> is missing cx, cy, r or fill');
  }

  return {
    viewBox: { minX: vb[0], minY: vb[1], width: vb[2], height: vb[3] },
    arc: { x1, y1, rx, ry, phi, largeArc: fA, sweep: fS, x2, y2 },
    strokeWidth,
    strokeLinecap,
    stroke,
    circle,
  };
}

/**
 * SVG endpoint-to-centre arc conversion (implementation notes F.6.5), in full
 * generality: the phi rotation, the out-of-range radius correction, and the
 * `largeArc !== sweep` sign rule. This is the arithmetic that says the centre
 * is (48.5757147144, 48) and not (48, 48).
 */
export function arcEndpointToCenter({ x1, y1, rx, ry, phi, largeArc, sweep, x2, y2 }) {
  const rad = (phi * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cos * dx2 + sin * dy2;
  const y1p = -sin * dx2 + cos * dy2;

  let RX = Math.abs(rx);
  let RY = Math.abs(ry);
  // F.6.6: scale radii up if they cannot span the chord.
  const lambda = (x1p * x1p) / (RX * RX) + (y1p * y1p) / (RY * RY);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    RX *= s;
    RY *= s;
  }

  const num0 = RX * RX * RY * RY - RX * RX * y1p * y1p - RY * RY * x1p * x1p;
  const den = RX * RX * y1p * y1p + RY * RY * x1p * x1p;
  const sign = largeArc !== sweep ? 1 : -1;
  const coef = sign * Math.sqrt(Math.max(0, num0 / den));
  const cxp = (coef * (RX * y1p)) / RY;
  const cyp = (coef * -(RY * x1p)) / RX;

  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;

  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / RX, (y1p - cyp) / RY);
  let delta = angle(
    (x1p - cxp) / RX,
    (y1p - cyp) / RY,
    (-x1p - cxp) / RX,
    (-y1p - cyp) / RY,
  );
  const TAU = Math.PI * 2;
  if (sweep === 0 && delta > 0) delta -= TAU;
  if (sweep === 1 && delta < 0) delta += TAU;

  return { cx, cy, rx: RX, ry: RY, theta1, delta };
}

function inSweep(t, theta1, delta) {
  const TAU = Math.PI * 2;
  let d = (t - theta1) * Math.sign(delta);
  d = ((d % TAU) + TAU) % TAU;
  return d <= Math.abs(delta) + 1e-12;
}

/**
 * Rasterize from derived values only. Requires a circular, unrotated arc: a
 * constant stroke distance is not the correct outline for an ellipse, so an
 * elliptical asset must stop the build rather than be rendered incorrectly.
 */
export function renderMark(parsed, centre, { size = EXPORT_SIZE, background = BACKGROUND, centreOffset = { x: 0, y: 0 } } = {}) {
  if (Math.abs(centre.rx - centre.ry) > 1e-9 || parsed.arc.phi !== 0) {
    throw new Error('mark: only a circular, unrotated arc can be rasterized by this script');
  }
  const ink = hexToRgb(parsed.stroke);
  const dotInk = hexToRgb(parsed.circle.fill);
  const { viewBox, strokeWidth, strokeLinecap, circle } = parsed;
  const scale = viewBox.width / size;
  const half = strokeWidth / 2;
  const cx = centre.cx + centreOffset.x;
  const cy = centre.cy + centreOffset.y;

  const pixels = Buffer.alloc(size * size * 3);
  const step = 1 / SUPERSAMPLE;
  const total = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const ux = viewBox.minX + (px + (sx + 0.5) * step) * scale;
          const uy = viewBox.minY + (py + (sy + 0.5) * step) * scale;

          const dr = Math.hypot(ux - cx, uy - cy);
          if (
            Math.abs(dr - centre.rx) <= half &&
            inSweep(Math.atan2(uy - cy, ux - cx), centre.theta1, centre.delta)
          ) {
            hits += 1;
            continue;
          }
          if (
            strokeLinecap === 'round' &&
            (Math.hypot(ux - parsed.arc.x1, uy - parsed.arc.y1) <= half ||
              Math.hypot(ux - parsed.arc.x2, uy - parsed.arc.y2) <= half)
          ) {
            hits += 1;
            continue;
          }
          if (Math.hypot(ux - circle.cx, uy - circle.cy) <= circle.r) hits += 1;
        }
      }
      const a = hits / total;
      const o = (py * size + px) * 3;
      const fg = a > 0 ? ink : dotInk;
      pixels[o] = Math.round(background.r * (1 - a) + fg.r * a);
      pixels[o + 1] = Math.round(background.g * (1 - a) + fg.g * a);
      pixels[o + 2] = Math.round(background.b * (1 - a) + fg.b * a);
    }
  }
  return { pixels, size };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Opaque 8-bit truecolour PNG. */
export function encodePng({ pixels, size }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Parse, convert and rasterize. Exported so the test can compare the derived
 *  geometry against its own independent reading of the same SVG. */
export function buildMarkPng(options = {}) {
  const parsed = parseMarkSvg(readFileSync(SVG_PATH, 'utf8'));
  const centre = arcEndpointToCenter(parsed.arc);
  return { parsed, centre, png: encodePng(renderMark(parsed, centre, options)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const out = process.argv[2] ? resolve(process.argv[2]) : PNG_PATH;
  const { centre, png } = buildMarkPng();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
  process.stdout.write(
    `conductia mark -> ${out}\n  derived centre (${centre.cx}, ${centre.cy}) r=${centre.rx}\n`,
  );
}
