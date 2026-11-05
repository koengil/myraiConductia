// Text normalization for discovered mail: HTML to plain text, and quoted
// history dropped so a reply is stored and routed on what its author wrote
// (Q5). A reply about Falcon can quote an older thread about another deal;
// the quoted message is its own item when it is in scope. Quote stripping on
// Outlook HTML is heuristic, and the eval measures it.

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** Plain text from a Graph HTML body: block elements become line breaks, tags go, entities decode. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<(p|div|li|tr|h[1-6]|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return collapseWhitespace(decodeEntities(text));
}

export function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Lines that open a quoted-history block in common clients. */
export const QUOTE_OPENERS: readonly RegExp[] = [
  /^On .+ wrote:$/i, // Gmail, Apple Mail
  /^-{2,}\s*Original Message\s*-{2,}$/i, // Outlook plain text
  /^-{2,}\s*Forwarded message\s*-{2,}$/i, // Gmail forward
  /^_{8,}$/, // Outlook HTML separator
  /^From: .+$/i, // Outlook header block, when followed by Sent: / Date:
];

/**
 * The top of a message: everything before the first quoted-history opener,
 * with any `>`-quoted lines dropped. A bare `From:` line opens a quote only
 * when the next line is a `Sent:` or `Date:` header, so a body that merely
 * starts a sentence with "From:" is kept.
 */
export function stripQuotedHistory(text: string): string {
  const lines = collapseWhitespace(text).split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const opener = QUOTE_OPENERS.find((pattern) => pattern.test(line));
    if (opener) {
      const isHeaderBlock = opener.source.startsWith('^From:');
      if (!isHeaderBlock || /^(Sent|Date):/i.test(lines[i + 1] ?? '')) break;
    }
    if (line.startsWith('>')) continue;
    kept.push(line);
  }
  return collapseWhitespace(kept.join('\n'));
}

/** The normalized body of a Graph message: HTML flattened, quoted history dropped. */
export function bodyText(body: { contentType: 'html' | 'text'; content: string }): string {
  const text = body.contentType === 'html' ? htmlToText(body.content) : body.content;
  return stripQuotedHistory(text);
}

/**
 * A subject without reply and forward prefixes, for thread continuation:
 * "RE: FW: Heliotrope next steps" and "Heliotrope next steps" match.
 */
export function normalizeSubject(subject: string | null | undefined): string {
  return stripReplyPrefixes(subject).replace(/\s+/g, ' ').toLowerCase();
}

// The reply tokens (English, German, Scandinavian) and the forward ones, shared by the two readers below.
const REPLY_TOKENS = 're|aw|sv';
const FORWARD_TOKENS = 'fw|fwd|wg|tr';
const REPLY_PREFIX = new RegExp(`^(${REPLY_TOKENS})\\s*(\\[\\d+\\])?\\s*:`, 'i');
const ANY_PREFIX = new RegExp(`^(${REPLY_TOKENS}|${FORWARD_TOKENS})\\s*(\\[\\d+\\])?\\s*:\\s*`, 'i');

/** A subject without reply and forward prefixes, case kept: "RE: FW: Kestrel: lender feedback" is "Kestrel: lender feedback". */
export function stripReplyPrefixes(subject: string | null | undefined): string {
  let value = (subject ?? '').trim();
  let previous = '';
  while (value !== previous) {
    previous = value;
    value = value.replace(ANY_PREFIX, '').trim();
  }
  return value;
}

/**
 * True when the subject opens with a reply token ("RE:", "AW:", "SV:", with an optional "[n]"). A subject
 * heuristic only: it reads no thread headers, so a sender who writes "Re:" on an original passes it.
 * "FW: RE: x" opens with a forward token and is not a reply.
 */
export function isReplySubject(subject: string | null | undefined): boolean {
  return REPLY_PREFIX.test((subject ?? '').trim());
}
