import { collapseWhitespace, htmlToText, QUOTE_OPENERS } from '@/lib/discovery/normalize/text';
import type { MailMessage } from '@/lib/discovery/source/types';

const GMAIL_FORWARD_OPENER = /^-{2,}\s*Forwarded message\s*-{2,}$/i;
/** FW: / Fwd:, also after a gateway tag ("[EXTERNAL] FW:") or a reply prefix ("RE: FW:"). */
const FORWARD_SUBJECT = /^(?:\[[^\]]{0,40}\]\s*|(?:re|aw|sv|wg)\s*(?:\[\d+\])?\s*:\s*)*(?:fw|fwd)\s*(?:\[\d+\])?\s*:/i;

/**
 * The content a message forwards, for compliance screening only.
 *
 * Normalization drops everything from the first quote marker down, so routing
 * and the content hash see only what the author wrote (Q5); that stays
 * untouched (Guillermo, Oct 7). A forward's block is exactly what screening
 * must read, though, since forwarding is how material information leaves a
 * thread. So this reads the raw message on its own and returns that block,
 * unquoted, or '' when the message forwards nothing.
 *
 * A message is a forward when its quote block opens with Gmail's "Forwarded
 * message" line, or when its subject starts with FW: / Fwd: (an Outlook
 * forward opens with the same From: / Sent: header block as a reply). A
 * reply's quoted history is the earlier thread, already read, so it returns
 * ''. In memory only: nothing here is stored (ADR-0017).
 */
export function forwardedBlock(message: Pick<MailMessage, 'subject' | 'body'>): string {
  const body = message.body ?? { contentType: 'text', content: '' };
  const content = body.content ?? '';
  const text = body.contentType === 'html' ? htmlToText(content) : content;
  const lines = collapseWhitespace(text).split('\n');
  // The same opener rule as stripQuotedHistory: an Outlook "From:" line opens
  // the block only when the next line is its Sent: / Date: header.
  const start = lines.findIndex((line, i) => {
    const opener = QUOTE_OPENERS.find((pattern) => pattern.test(line));
    if (!opener) return false;
    return !opener.source.startsWith('^From:') || /^(Sent|Date):/i.test(lines[i + 1] ?? '');
  });
  if (start < 0) return '';
  const isForward = GMAIL_FORWARD_OPENER.test(lines[start]) || FORWARD_SUBJECT.test((message.subject ?? '').trim());
  if (!isForward) return '';
  return collapseWhitespace(lines.slice(start + 1).map((line) => line.replace(/^>+\s?/, '')).join('\n'));
}
