import { OperatorCopyError, errorCodeOf } from '@/lib/errors/upstream';

/**
 * The one place that decides what a failed provider send says to the sender
 * (#331). A provider's own text can quote the recipient, the sender domain or
 * the message, so it never reaches the response:
 *
 *   OperatorCopyError   fixed first-party copy written in this repo (a
 *                       reconnect prompt, a sender remedy); shown word for word.
 *   UpstreamHttpError   the provider and status only, as a code.
 *   anything else       an unexpected code; the message is not read.
 */
export function providerFailureCopy(err: unknown): string {
  if (err instanceof OperatorCopyError) return `Email provider send failed: ${err.message}`;
  return `Email provider send failed (${errorCodeOf(err)})`;
}
