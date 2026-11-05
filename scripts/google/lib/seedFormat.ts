/** conductia.gmail-seed/v1, one JSON object per line (plan D9). */
export type SeedAddress = { name?: string; address: string };
export type SeedClassificationLabel = { labelId: string; fields?: Array<{ fieldId: string; selection: string }> };
export type SeedMessage = {
  /** "<…@…>", kept verbatim in every copy. */
  messageId: string;
  /** RFC 5322 date; import keeps it (internalDateSource=dateHeader). */
  date: string;
  from: SeedAddress;
  to: SeedAddress[];
  cc: SeedAddress[];
  subject: string;
  inReplyTo?: string;
  references?: string[];
  body: { contentType: 'html' | 'text'; content: string };
  /** Persona addresses holding a copy. */
  mailboxes: string[];
  /**
   * 'SPAM' seeds the message into SPAM for the after-unspam phase. Any other name is a user label the twin
   * gives the message and lists in labels.list (#263): the exclusion twin's label rules read them. The live
   * seeding script (seed-gmail) inserts into INBOX or SPAM only and ignores the rest.
   */
  labels?: string[];
  /**
   * Workspace classification label values on the message (#263), written into its metadata answer as Gmail's
   * `classificationLabelValues`: `fields[].selection` is a selection id.
   */
  classification?: SeedClassificationLabel[];
  /**
   * Extra marker headers on the message (#263): the two the exclusion policy matches on,
   * written into the raw message and the metadata answer verbatim.
   */
  headers?: { Sensitivity?: string; msip_labels?: string };
  phase?: 'seeded' | 'after-imports';
};

export const SEED_MARKER_HEADERS = ['Sensitivity', 'msip_labels'] as const;

export const SEED_FORMAT = 'conductia.gmail-seed/v1' as const;

export function parseSeedJsonl(text: string): SeedMessage[] {
  const out: SeedMessage[] = [];
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    let value: SeedMessage;
    try {
      value = JSON.parse(line) as SeedMessage;
    } catch {
      throw new Error(`seed line ${index + 1} is not JSON`);
    }
    const errors: string[] = [];
    if (typeof value.messageId !== 'string' || !/^<[^<>\s]+@[^<>\s]+>$/.test(value.messageId)) errors.push('messageId');
    if (typeof value.date !== 'string' || Number.isNaN(Date.parse(value.date))) errors.push('date');
    if (!value.from || typeof value.from.address !== 'string') errors.push('from');
    if (!Array.isArray(value.to)) errors.push('to');
    if (!Array.isArray(value.cc)) errors.push('cc');
    if (typeof value.subject !== 'string') errors.push('subject');
    if (!value.body || typeof value.body.content !== 'string' || !['html', 'text'].includes(value.body.contentType)) {
      errors.push('body');
    }
    if (!Array.isArray(value.mailboxes) || value.mailboxes.length === 0) errors.push('mailboxes');
    if (value.headers !== undefined) {
      const h = value.headers as Record<string, unknown> | null;
      const known = SEED_MARKER_HEADERS as readonly string[];
      if (!h || typeof h !== 'object' || Array.isArray(h) || Object.entries(h).some(([k, v]) => !known.includes(k) || typeof v !== 'string')) {
        errors.push('headers');
      }
    }
    if (value.labels !== undefined && (!Array.isArray(value.labels) || value.labels.some((l) => typeof l !== 'string' || l.trim() === ''))) {
      errors.push('labels');
    }
    if (value.classification !== undefined) {
      const ok =
        Array.isArray(value.classification) &&
        value.classification.every(
          (c) =>
            c &&
            typeof c.labelId === 'string' &&
            (c.fields === undefined ||
              (Array.isArray(c.fields) && c.fields.every((f) => f && typeof f.fieldId === 'string' && typeof f.selection === 'string'))),
        );
      if (!ok) errors.push('classification');
    }
    if (errors.length > 0) throw new Error(`seed line ${index + 1} has invalid fields: ${errors.join(', ')}`);
    out.push(value);
  });
  return out;
}

export function toJsonl(messages: SeedMessage[]): string {
  return messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
}
