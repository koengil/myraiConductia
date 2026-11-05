/**
 * CSS Custom Highlight API styles for the mail composer.
 *
 * These MUST stay out of globals.css. Lightning CSS (Next / Turbopack) does
 * not recognize `::highlight()` and warns on every production build. A raw
 * <style> tag is passed through to the browser, which does understand it.
 * Browsers without the API skip the underline; the chips row still names
 * the terms.
 */
const HIGHLIGHT_API_CSS = `
::highlight(l1-pending) {
  text-decoration: underline;
  text-decoration-color: var(--hold);
  text-decoration-thickness: 1.5px;
}
::highlight(l1-acked) {
  text-decoration: underline dotted;
  text-decoration-color: var(--ink-tertiary);
}
::highlight(lexicon-advisory) {
  text-decoration: underline dotted;
  text-decoration-color: color-mix(in srgb, var(--hold) 55%, transparent);
  text-decoration-thickness: 1.5px;
}
`;

export function HighlightApiStyles() {
  return <style dangerouslySetInnerHTML={{ __html: HIGHLIGHT_API_CSS }} />;
}
