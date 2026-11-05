import type { LifecycleCategory } from '@/lib/constants/deals';

const MARKER = /^\[confidential\]\s*/i;
const THREAD_PREFIX = /^(?:re|fw|fwd)\s*:\s*/i;
const LABEL = '[Confidential]';

/** The server supplies lifecycle; a client preview is never send authority. */
export function requiresConfidential(category: LifecycleCategory): boolean {
  return category === 'live' || category === 'pitch';
}

/**
 * One leading label, however the subject arrives. A reply comes back as
 * "Re: [Confidential] …", so the label is looked for across the whole leading
 * chain of Re:/Fw: prefixes and labels, not only at position 0; otherwise every
 * round trip of a thread would add another label. A subject that already leads
 * with exactly one label is returned untouched, so a hand-typed label keeps the
 * banker's casing and the function stays idempotent across the client/server
 * boundary (the send token binds the marked subject).
 */
export function confidentialSubject(subject: string, required: boolean): string {
  if (!required) return subject;
  let rest = subject;
  let thread = '';
  let labels = 0;
  let labelLeads = false;
  for (;;) {
    const label = rest.match(MARKER);
    if (label) {
      if (labels === 0 && thread === '') labelLeads = true;
      labels += 1;
      rest = rest.slice(label[0].length);
      continue;
    }
    const prefix = rest.match(THREAD_PREFIX);
    if (prefix) {
      thread += prefix[0];
      rest = rest.slice(prefix[0].length);
      continue;
    }
    break;
  }
  if (labels === 1 && labelLeads) return subject;
  return `${LABEL} ${thread}${rest}`;
}

/**
 * "Re:" / "Fw:" for a reply or forward, looking past a leading label so a
 * marked thread does not grow "Re: Re: …" (the label sits in front of the
 * prefix the plain startsWith check was looking for).
 */
export function threadSubject(subject: string, prefix: 'Re' | 'Fw'): string {
  const label = subject.match(MARKER);
  const rest = label ? subject.slice(label[0].length) : subject;
  const threaded = new RegExp(`^${prefix}\\s*:`, 'i').test(rest) ? rest : `${prefix}: ${rest}`;
  return label ? `${label[0].trimEnd()} ${threaded}` : threaded;
}
