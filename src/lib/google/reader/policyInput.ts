// Gmail metadata into the exclusion policy's input (#263): the only
// Gmail-specific mapping the policy has. Everything a rule may read is here, and
// MessageMetadata (src/lib/discovery/exclusion/types.ts) has no field that could
// hold anything else: the Subject header, the snippet, the body and display names
// are never copied, so none of them can steer a verdict.
//
// What is copied is untrusted text (marker header values, addr-specs) that a
// sender controls. It is kept verbatim for a literal comparison, never interpreted.

import { addressParser } from 'postal-mime';

import { GMAIL_CLASSIFICATION_FIELD_VERIFIED, GMAIL_SYSTEM_LABEL_IDS } from '@/lib/constants/googleReader';
import type { ClassificationValue, MessageMetadata } from '@/lib/discovery/exclusion/types';

type GmailHeader = { name: string; value: string };
type GmailClassificationLabel = { labelId?: string; fields?: Array<{ fieldId?: string; selection?: string }> };

/** The parts of a metadata response the policy reads. Structural, so mail.ts's own type satisfies it. */
export type GmailPolicySource = {
  labelIds?: string[];
  payload?: { headers?: GmailHeader[] };
  classificationLabelValues?: GmailClassificationLabel[];
};

/** Every occurrence of a header, joined: a second Sensitivity header must not hide the first. */
function headerValues(headers: GmailHeader[], name: string): string[] {
  const wanted = name.toLowerCase();
  return headers.filter((h) => typeof h.name === 'string' && h.name.toLowerCase() === wanted).map((h) => String(h.value ?? ''));
}

/**
 * The addr-specs of an address header, lowercased, with one trailing dot dropped from
 * the domain; null when the header cannot be read as addresses (an entry with no
 * address, no local part, no domain, or more than one '@'). Display names are dropped
 * here. An absent header is an empty list, not unparseable.
 *
 * Exactly one '@' (#337 F1): the evaluator takes the domain after the last '@', so
 * `p@counsel.example@outside.example` would miss a counsel.example rule. Not a
 * deliverable mailbox, so it fails closed, as does a quoted local part holding an '@'.
 */
export function addressesOf(headers: GmailHeader[], name: string): string[] | null {
  const out: string[] = [];
  for (const value of headerValues(headers, name)) {
    if (value.trim() === '') continue;
    let parsed;
    try {
      parsed = addressParser(value);
    } catch {
      return null;
    }
    for (const entry of parsed) {
      const members = entry.group ?? [entry];
      for (const member of members) {
        const parts = (member.address ?? '').trim().toLowerCase().split('@');
        if (parts.length !== 2) return null;
        const [local, domain] = [parts[0], parts[1].replace(/\.$/, '')];
        if (local === '' || domain === '') return null;
        out.push(`${local}@${domain}`);
      }
    }
  }
  return out;
}

function classificationOf(values: GmailClassificationLabel[] | undefined, verified: boolean): ClassificationValue[] | 'unavailable' {
  // Absent could mean "no label" or "not returned for this format and scope": unavailable until the field is
  // verified on a live read (GMAIL_CLASSIFICATION_FIELD_VERIFIED), after which absent means none.
  if (!Array.isArray(values)) return verified ? [] : 'unavailable';
  const out: ClassificationValue[] = [];
  for (const value of values) {
    if (typeof value?.labelId !== 'string') continue;
    const fields = Array.isArray(value.fields) ? value.fields : [];
    if (fields.length === 0) out.push({ labelId: value.labelId });
    for (const field of fields) {
      out.push({
        labelId: value.labelId,
        ...(typeof field?.fieldId === 'string' ? { fieldId: field.fieldId } : {}),
        ...(typeof field?.selection === 'string' ? { selectionId: field.selection } : {}),
      });
    }
  }
  return out;
}

/** Label id to name, from one labels.list for the pass. */
export type GmailLabelNames = ReadonlyMap<string, string>;

export type PolicyInputOptions = {
  /** The pass's label names; null when no rule needs them (a rule that names only system labels matches on the ids). */
  labelNames?: GmailLabelNames | null;
  /** Overridable for tests only: the reader always uses GMAIL_CLASSIFICATION_FIELD_VERIFIED. */
  classificationVerified?: boolean;
};

/** The ids a message carries, with the names a rule may match. A user label the list did not name is `unavailable`: fails closed. */
export function labelsOf(ids: string[], names: GmailLabelNames | null | undefined): MessageMetadata['labels'] {
  if (!names) return { ids: [...ids], names: [] };
  const resolved: string[] = [];
  for (const id of ids) {
    const name = names.get(id);
    if (name !== undefined) resolved.push(name);
    else if (!GMAIL_SYSTEM_LABEL_IDS.has(id)) return { ids: [...ids], names: 'unavailable' };
  }
  return { ids: [...ids], names: resolved };
}

export function toPolicyInput(meta: GmailPolicySource, options: PolicyInputOptions = {}): MessageMetadata {
  const headers = meta.payload?.headers ?? [];
  const from = addressesOf(headers, 'From');
  const to = addressesOf(headers, 'To');
  const cc = addressesOf(headers, 'Cc');
  const bcc = addressesOf(headers, 'Bcc');
  const replyTo = addressesOf(headers, 'Reply-To');
  const sender = addressesOf(headers, 'Sender');
  const marker = (name: string): string | null => {
    const values = headerValues(headers, name);
    return values.length > 0 ? values.join('\n') : null;
  };
  return {
    labels: labelsOf(meta.labelIds ?? [], options.labelNames),
    classification: classificationOf(meta.classificationLabelValues, options.classificationVerified ?? GMAIL_CLASSIFICATION_FIELD_VERIFIED),
    // All or nothing (#263): one unreadable address header fails every participant rule closed.
    participants: from && to && cc && bcc && replyTo && sender ? { from, to, cc, bcc, replyTo, sender } : 'unparseable',
    markers: { sensitivity: marker('Sensitivity'), msip_labels: marker('msip_labels') },
  };
}
