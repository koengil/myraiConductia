// Attachment content in the pre-send screen (Storm, Oct 9, Option B): every
// attachment's text is read and screened with the body. The outbox route adds
// the text of each attachment read in full as one more screened field, so the
// rule pack and the AI pass read it exactly as they read the body.
//
// Fail closed: an attachment not read in full (partial, unreadable, an
// unsupported type, too large, encrypted, empty, timed out) is never treated
// as clean. It turns a compliant screen into a hold, with one reason per
// attachment, so it reaches the sender as risk issues and, if sent as-is,
// lands in the CCO's queue like any other flagged send.
//
// The audit names attachments by POSITION (1-based, the order sent), never by
// name and never with their text: a screen returned to the sender is a record
// of mail that was not sent (D80), so it gains no content. A sent message's
// stored attachment metadata lists the names in the same order.

import { findScreenHits } from './screen';
import type { ScreenedVerdict } from './llm';
import {
  extractAttachmentText,
  type AttachmentInput,
  type AttachmentTextFailure,
} from './attachmentText';

export type AttachmentFinding = {
  /** 1-based, in the order the attachments were sent. */
  position: number;
  /** 'ok' when all of the text was read; otherwise why it was not. */
  read: 'ok' | AttachmentTextFailure;
  /** Rule-layer hit kinds found in this attachment's name or text. The AI
   *  pass reads all fields together, so its concerns are not attributed. */
  ruleHits?: Array<'promissory' | 'mnpi'>;
};

const UNREAD_COPY: Record<AttachmentTextFailure, string> = {
  partial: 'only part of its text could be read',
  unreadable: 'its content could not be read',
  unsupported_type: 'its file type cannot be read',
  too_large: 'it is too large to read',
  encrypted: 'it is password protected',
  empty: 'it has no readable text, such as a scanned page',
  timeout: 'reading it took too long',
};

export function unreadAttachmentReason(position: number, read: AttachmentTextFailure): string {
  return `Attachment ${position} was not screened: ${UNREAD_COPY[read]}. Review it before sending.`;
}

/** Attachment text the screen takes per message, all attachments together (twice
 *  the body cap). Past it the AI prompt would outgrow the model and the screen
 *  would fall back to rules only, so an attachment that does not fit is not
 *  screened and holds like any other unread attachment (PR #495 review). */
export const MAX_SCREENED_ATTACHMENT_CHARS = 100_000;

/** Reads every attachment: the text of those read in full (to screen) and one finding per attachment (to audit). */
export async function readAttachments(
  attachments: AttachmentInput[],
): Promise<{ texts: string[]; findings: AttachmentFinding[] }> {
  const results = await Promise.all(attachments.map((attachment) => extractAttachmentText(attachment)));
  const texts: string[] = [];
  let budget = MAX_SCREENED_ATTACHMENT_CHARS;
  const findings = results.map((result, i): AttachmentFinding => {
    const text = result.ok && result.text.length <= budget ? result.text : null;
    if (text !== null) {
      texts.push(text);
      budget -= text.length;
    }
    const kinds = new Set(
      [attachments[i].name, text ?? ''].flatMap((field) => findScreenHits(field).map((hit) => hit.kind)),
    );
    return {
      position: i + 1,
      read: text !== null ? 'ok' : result.ok ? 'too_large' : result.reason,
      ...(kinds.size ? { ruleHits: [...kinds].sort() } : {}),
    };
  });
  return { texts, findings };
}

/** A fresh screen with the unread attachments applied: never clean while any attachment went unscreened. */
export function withUnreadAttachments(screened: ScreenedVerdict, findings: AttachmentFinding[]): ScreenedVerdict {
  const unread = findings.flatMap((f) => (f.read === 'ok' ? [] : [unreadAttachmentReason(f.position, f.read)]));
  if (unread.length === 0) return screened;
  if (screened.verdict === 'compliant') return { ...screened, verdict: 'hold', reasons: unread };
  return { ...screened, reasons: [...screened.reasons, ...unread] };
}
