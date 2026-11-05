/**
 * Conductia Wordmark — the single source of the brand mark.
 *
 * The L1 "Conduit" mark: an open
 * ink arc — the conduit — completed by a step dot. Geometry inlined from
 * src/components/brand/assets/conductia-mark-ink.svg; single-color ink
 * discipline (brand-spirit.md §7): the whole mark renders in one color via
 * currentColor, so it takes ink on light surfaces and white on dark ones.
 * No gradients, no bevels, no second hue.
 *
 * Wordmark text: Inter 650, -0.02em tracking (brand-spirit.md §7), rendered
 * as live text in the interface face rather than outlined paths.
 *
 * Name is always spelled exactly "Conductia" (decision-log D4).
 * No external assets, no icon-library dependency.
 */

export type WordmarkVariant = "full" | "mark";
export type WordmarkTone = "auto" | "on-light" | "on-dark";

export interface WordmarkProps {
  /** "full" = mark + wordmark; "mark" = the Conduit glyph only. */
  variant?: WordmarkVariant;
  /** Rendered height in px (the word scales to match). */
  size?: number;
  /** Color anchor. "auto" inherits currentColor from the surface. */
  tone?: WordmarkTone;
  /** Accessible label. Empty string → decorative (aria-hidden). */
  title?: string;
  className?: string;
}

/** Explicit tones must not depend on inherited currentColor. */
function toneColor(tone: WordmarkTone): string | undefined {
  if (tone === "on-dark") return "var(--ink-on-dark)";
  if (tone === "on-light") return "var(--ink)";
  return undefined; // auto: inherit
}

export function Wordmark({
  variant = "full",
  size = 28,
  tone = "auto",
  title = "Conductia",
  className,
}: WordmarkProps) {
  const decorative = title.trim() === "";
  const color = toneColor(tone);

  // Mark-only: the Conduit glyph in its native square viewBox.
  if (variant === "mark") {
    return (
      <svg
        role={decorative ? undefined : "img"}
        aria-label={decorative ? undefined : title}
        aria-hidden={decorative ? true : undefined}
        width={size}
        height={size}
        viewBox="0 0 96 96"
        fill="none"
        className={className}
        style={color ? { color } : undefined}
      >
        {!decorative && <title>{title}</title>}
        <ConduitGlyph />
      </svg>
    );
  }

  // Full lockup: the Conduit mark beside the wordmark, composed in HTML so
  // the text stays live Inter (assets/README.md: for contexts with Inter
  // loaded, compose the lockup per Wordmark.tsx). Everything inherits one
  // color; `size` maps to the mark's height and the word scales to match.
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : title}
      aria-hidden={decorative ? true : undefined}
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: Math.round(size * 0.32),
        flexShrink: 0,
        ...(color ? { color } : null),
      }}
    >
      <svg
        aria-hidden
        width={size}
        height={size}
        viewBox="0 0 96 96"
        fill="none"
        style={{ display: "block", flexShrink: 0 }}
      >
        <ConduitGlyph />
      </svg>
      <span
        aria-hidden
        style={{
          fontFamily: "var(--font-bank)",
          fontWeight: 650,
          letterSpacing: "-0.02em",
          fontSize: Math.round(size * 0.64),
          lineHeight: 1,
        }}
      >
        Conductia
      </span>
    </span>
  );
}

/**
 * The L1 Conduit mark: an open arc (the conduit) completed by a step dot.
 * Geometry verbatim from assets/conductia-mark-ink.svg (96-unit viewBox),
 * recolored to currentColor so the mark takes the tone of its surface —
 * ink on light, white on ink (assets/README.md placement map).
 */
function ConduitGlyph() {
  return (
    <>
      <path
        d="M 70 27 A 30 30 0 1 0 70 69"
        fill="none"
        stroke="currentColor"
        strokeWidth={12}
        strokeLinecap="round"
      />
      <circle cx={72} cy={48} r={7.5} fill="currentColor" />
    </>
  );
}

export default Wordmark;
