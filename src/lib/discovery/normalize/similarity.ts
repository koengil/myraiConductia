// How far two messages that claim the same Internet message id differ. The
// store keeps the first and ledgers the other as an id collision; these two
// numbers go on the ledger row (never the text), so the eval can tell a
// legitimate per-mailbox variant (an [EXTERNAL] banner, a rewritten link)
// from two unrelated messages, and so whether merging near-duplicates is
// worth its risk.

const TOKEN = /[\p{L}\p{N}]+/gu;

/** Four decimals: enough to read a distribution, and free of float noise (0.9999999999999998). */
const round = (value: number) => Math.round(value * 10_000) / 10_000;

function termCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of text.toLowerCase().match(TOKEN) ?? []) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/** Cosine similarity of the word-count vectors, 0 (no word shared) to 1 (same words, same proportions). */
export function cosineSimilarity(a: string, b: string): number {
  const left = termCounts(a);
  const right = termCounts(b);
  if (left.size === 0 && right.size === 0) return 1;
  let dot = 0;
  for (const [token, count] of left) dot += count * (right.get(token) ?? 0);
  const norm = (counts: Map<string, number>) => Math.sqrt([...counts.values()].reduce((sum, c) => sum + c * c, 0));
  const denominator = norm(left) * norm(right);
  return denominator === 0 ? 0 : round(Math.min(1, dot / denominator));
}

/** The shorter text's length over the longer's, 0 to 1 (1 when both are empty). */
export function lengthRatio(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  return longer === 0 ? 1 : round(Math.min(a.length, b.length) / longer);
}

export type CollisionMetrics = { similarity: number; lengthRatio: number };

/** Compares two items on what contentHash covers: the subject, then the body text. */
export function collisionMetrics(
  kept: { subject: string; bodyText: string },
  incoming: { subject: string; bodyText: string },
): CollisionMetrics {
  const a = `${kept.subject}\n${kept.bodyText}`;
  const b = `${incoming.subject}\n${incoming.bodyText}`;
  return { similarity: cosineSimilarity(a, b), lengthRatio: lengthRatio(a, b) };
}
