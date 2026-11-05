// Ordering that does not depend on the machine (review item 10).
// localeCompare follows the host's ICU data and locale, so two machines can
// sort the same ids differently; a scorecard must render byte for byte the
// same from the same inputs, whatever their order and wherever it runs.

/** Compares two strings by UTF-16 code unit, the same everywhere. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A sorted copy, by the key each value gives, in code-point order. */
export function sortedBy<T>(values: Iterable<T>, key: (value: T) => string): T[] {
  return [...values].sort((a, b) => byCodePoint(key(a), key(b)));
}
