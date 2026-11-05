/**
 * The Workbench register, for email.
 *
 * The invitation is the first thing a counterparty ever sees from Conductia, so
 * it carries the same brand as the app: warm neutrals, ink as the only strong
 * accent, hairlines rather than shadows, and one serif moment.
 *
 * This module exists so there is exactly one copy of that chrome. Two
 * hand-maintained templates drifting apart is the same failure this issue fixes
 * in the perimeter preview.
 *
 * Two email constraints shape everything here:
 *   - Tables, not flexbox. Outlook's Word engine has no flex.
 *   - Inline styles are the guarantee. Many clients strip <style>, so the meta
 *     and rule below are an enhancement, never the contract.
 */

/** Workbench palette (docs/design/workbench/tokens.css). No other colour
 *  literal belongs in an email. `ink-quiet` is deliberately absent: it computes
 *  to 2.81:1 on white and would fail the contrast floor. */
export const EMAIL_PALETTE = {
  ink: '#191919',
  inkSecondary: '#55534e',
  inkTertiary: '#6b6b68',
  surface: '#ffffff',
  surfaceWarm: '#f5f4f1',
  surfaceSubtle: '#f1f0ec',
  stroke: '#eceae5',
} as const;

/** System stacks only. An email must not fetch a webfont. */
export const EMAIL_FONTS = {
  interface: "Inter, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;

/** The canonical mark, exported to PNG by scripts/build-email-mark.mjs and
 *  served from the application's own origin. Never a marketing host. */
export const MARK_PATH = '/conductia/email/conductia-mark-ink.png';

export function markUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${MARK_PATH}`;
}

const P = EMAIL_PALETTE;
const F = EMAIL_FONTS;

/**
 * Mark beside wordmark, which is what the brand register calls the lockup. The
 * wordmark is live text in the interface stack at 650 / -0.02em, so with images
 * suppressed the recipient still reads "Conductia".
 */
function lockup(origin: string): string {
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="background-color: ${P.surface};"><tr>`,
    `<td style="padding: 0 10px 0 0; background-color: ${P.surface}; line-height: 0;">`,
    `<img src="${markUrl(origin)}" width="28" height="28" alt="Conductia" border="0" style="display: block; border: 0; outline: none; text-decoration: none;" />`,
    `</td>`,
    `<td style="background-color: ${P.surface}; font-family: ${F.interface}; font-size: 18px; font-weight: 650; letter-spacing: -0.02em; color: ${P.ink};">Conductia</td>`,
    `</tr></table>`,
  ].join('');
}

export interface EmailShellParams {
  /** The application's own origin. Required: the mark is never optional. */
  origin: string;
  /** Small mono kicker above the headline. */
  eyebrow: string;
  headline: string;
  /** The register spends its one serif moment on deal identity. */
  headlineFace?: 'serif' | 'interface';
  /** Pre-built <tr> rows for the body. */
  rows: string[];
  /** Fine print inside the card, above the hairline. */
  footer: string;
}

/**
 * The document. Every element that renders text declares its own `color` and
 * `background-color` inline, so a client that inverts or re-themes has an
 * explicit pair to work from rather than an inherited guess.
 */
export function emailShell({
  origin,
  eyebrow,
  headline,
  headlineFace = 'interface',
  rows,
  footer,
}: EmailShellParams): string {
  const headlineFont = headlineFace === 'serif' ? F.serif : F.interface;
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="color-scheme" content="light" />',
    '<meta name="supported-color-schemes" content="light" />',
    '<style>:root { color-scheme: light; supported-color-schemes: light; }</style>',
    '</head>',
    `<body style="margin: 0; padding: 0; background-color: ${P.surfaceWarm}; color: ${P.ink};">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${P.surfaceWarm}; padding: 40px 16px;"><tr><td align="center" style="background-color: ${P.surfaceWarm};">`,
    `<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="max-width: 520px; width: 100%; background-color: ${P.surface}; border: 1px solid ${P.stroke}; border-radius: 12px;">`,
    `<tr><td style="padding: 28px 32px 24px; background-color: ${P.surface}; border-bottom: 1px solid ${P.stroke};">`,
    lockup(origin),
    '</td></tr>',
    `<tr><td style="padding: 28px 32px 8px; background-color: ${P.surface};">`,
    `<p style="margin: 0 0 10px; font-family: ${F.mono}; font-size: 11px; font-weight: 500; letter-spacing: 0.09em; text-transform: uppercase; color: ${P.inkTertiary}; background-color: ${P.surface};">${eyebrow}</p>`,
    `<p style="margin: 0; font-family: ${headlineFont}; font-size: 24px; font-weight: 400; letter-spacing: -0.01em; line-height: 1.3; color: ${P.ink}; background-color: ${P.surface};">${headline}</p>`,
    '</td></tr>',
    ...rows,
    `<tr><td style="padding: 18px 32px 24px; background-color: ${P.surface}; border-top: 1px solid ${P.stroke};">`,
    `<p style="margin: 0; font-family: ${F.interface}; font-size: 12px; line-height: 1.6; color: ${P.inkSecondary}; background-color: ${P.surface};">${footer}</p>`,
    '</td></tr>',
    '</table>',
    `<p style="margin: 18px 0 0; font-family: ${F.interface}; font-size: 11px; color: ${P.inkTertiary}; background-color: ${P.surfaceWarm};">Conductia. AI operating system for investment banking.</p>`,
    '</td></tr></table>',
    '</body>',
    '</html>',
  ].join('\n');
}

/** A body paragraph row. */
export function textRow(html: string, { padding = '12px 32px 24px' } = {}): string {
  return [
    `<tr><td style="padding: ${padding}; background-color: ${P.surface};">`,
    `<p style="margin: 0; font-family: ${F.interface}; font-size: 15px; line-height: 1.6; color: ${P.inkSecondary}; background-color: ${P.surface};">${html}</p>`,
    '</td></tr>',
  ].join('');
}

/** The primary action. Ink fill, white label. Outlook ignores the radius and
 *  renders a rectangle, which is legible and accepted. */
export function ctaRow(href: string, label: string): string {
  return [
    `<tr><td style="padding: 0 32px 28px; background-color: ${P.surface};">`,
    `<a href="${href}" style="display: inline-block; background-color: ${P.ink}; color: ${P.surface}; font-family: ${F.interface}; font-size: 15px; font-weight: 600; padding: 13px 28px; border-radius: 8px; text-decoration: none;">${label}</a>`,
    '</td></tr>',
  ].join('');
}

/**
 * The verification code.
 *
 * The hermetic mail parser matches `<strong>(\d{6})</strong>`, so that element
 * must carry no attributes and therefore no inline style. It is the one
 * exception to the explicit-colour rule: it inherits, and this parent declares
 * both `color` and `background-color` so the code's effective pair is still
 * explicit and still measurable.
 */
export function codeRow(sentence: string): string {
  return [
    `<tr><td style="padding: 12px 32px 20px; background-color: ${P.surface};">`,
    `<p style="margin: 0; font-family: ${F.mono}; font-size: 20px; font-weight: 600; letter-spacing: 0.08em; line-height: 1.5; color: ${P.ink}; background-color: ${P.surface};">${sentence}</p>`,
    '</td></tr>',
  ].join('');
}
