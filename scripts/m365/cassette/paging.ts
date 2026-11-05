// Graph paging tokens ($skiptoken, $deltatoken, the delta(token='…') form) are opaque values a tenant
// issues; a cassette stores them as r1, r2, … so no recorded blob survives. Shared by scrub (rewrite),
// lint (verify) and the tests (mask before comparing checkpoints).

// $skiptoken / $deltatoken (either spelling of $), token= in a query, and the delta(token='…') form.
export const PAGING = /([?&](?:\$|%24)(?:skiptoken|deltatoken)=|[?&]token=|\(token=')([^&'")#\s]+)/gi;

/** Replaces every paging-token value with `*`, so two links can be compared without their tokens. */
export const maskTokens = (text: string) => text.replace(PAGING, (_match, prefix: string) => `${prefix}*`);

/** The paging-token values in `text`, in order. */
export const pagingValues = (text: string): string[] => [...text.matchAll(PAGING)].map((match) => match[2]);

/** Maps each raw token value to `r<n>` in first-seen order; one value always maps to one placeholder. */
export function createTokenRewriter(): (text: string) => string {
  const placeholders = new Map<string, string>();
  return (text) =>
    text.replace(PAGING, (_match, prefix: string, value: string) => {
      let placeholder = placeholders.get(value);
      if (!placeholder) {
        placeholder = `r${placeholders.size + 1}`;
        placeholders.set(value, placeholder);
      }
      return `${prefix}${placeholder}`;
    });
}
