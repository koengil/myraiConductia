// Content tags at upload (Lance, Oct 9 and Oct 12): when a document is
// uploaded and the server holds its bytes, its text is read once and the
// deterministic rules (the same rule layer and lexicon the send screen uses,
// no model call) tag it, so a document is searchable by what it contains and
// is not re-read every time it is looked at.
//
// Tags carry categories only, never content: no text, no excerpt, no matched
// phrase (D80 spirit). A tag is a rule kind ('mnpi', 'promissory') or a
// lexicon category id ('lexicon-<n>').
//
// Never clean when unread: `tags` is present only when ALL of the text was
// read (textStatus 'ok'). An empty list means read in full with no signal;
// a missing list means the document was not screened.
//
// Fail open for the upload: tagging never blocks an upload. It runs in
// after(), so the upload answers without waiting for extraction and a fresh
// upload may briefly have no tags. Any failure to read or to store tags
// leaves the document untagged or with its textStatus, and the send path
// still reads an untagged attachment in full.

import { createHash } from 'node:crypto';
import { after } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '@/lib/constants/tables';
import { errorCodeOf } from '@/lib/errors/upstream';
import {
  ATTACHMENT_TEXT_FAILURE,
  MAX_ATTACHMENT_BYTES,
  extractAttachmentText,
  type AttachmentTextFailure,
} from './attachmentText';
import { LEXICON_TIER_SURFACE, LEXICON_VERSION, findLexiconHits } from './lexicon';
import { findScreenHits } from './screen';

/** Names the rule set that produced a tag. Bump the date when the patterns in
 *  screen.ts change; the lexicon carries its own version. Tags under an older
 *  version are stale and must be read again before reuse. */
export const DOCUMENT_TAG_RULES_VERSION = `rules-2026-10-15+lexicon-${LEXICON_VERSION}`;

export type DocumentContentTags = {
  /** sha256 of the uploaded bytes, hex. Equals attachmentText's contentHash for the same bytes. */
  contentDigest: string;
  textStatus: 'ok' | AttachmentTextFailure;
  rulesVersion: string;
  taggedAt: string;
  /** Present only when ALL of the text was read. [] = read in full, no signal. */
  tags?: string[];
};

const TAG_FILTER = /^(?:mnpi|promissory|lexicon-\d{1,3})$/;

/** A `?tag=` value, or null when it is not a tag this module writes. */
export function parseDocumentTag(raw: string | null): string | null {
  const tag = (raw ?? '').trim().toLowerCase();
  return TAG_FILTER.test(tag) ? tag : null;
}

export async function tagDocumentContent(
  input: { name: string; type: string | null; bytes: Uint8Array },
  now: Date = new Date(),
): Promise<DocumentContentTags> {
  const bytes = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  const base = {
    contentDigest: createHash('sha256').update(bytes).digest('hex'),
    rulesVersion: DOCUMENT_TAG_RULES_VERSION,
    taggedAt: now.toISOString(),
  };
  // Checked before encoding: a data-room file may be far larger than an attachment.
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    return { ...base, textStatus: ATTACHMENT_TEXT_FAILURE.TOO_LARGE };
  }
  const read = await extractAttachmentText({
    name: input.name,
    type: input.type,
    contentBase64: bytes.toString('base64'),
  });
  if (!read.ok) return { ...base, textStatus: read.reason };

  const kinds = findScreenHits(read.text).map((hit) => hit.kind);
  // Tiers the screen hands to the AI (1 and 2). Tier 3 is ordinary business
  // language and would tag nearly every document.
  const categories = findLexiconHits(read.text)
    .filter((hit) => LEXICON_TIER_SURFACE[hit.tier].ai)
    .map((hit) => `lexicon-${hit.category}`);
  return { ...base, textStatus: 'ok', tags: [...new Set([...kinds, ...categories])].sort() };
}

/** Tags a stored document. Never throws: the upload already succeeded. */
export async function storeDocumentContentTags(
  admin: SupabaseClient,
  documentId: string,
  input: { name: string; type: string | null; bytes: Uint8Array },
): Promise<void> {
  const logFailure = (code: string) =>
    console.error('[documents] content tags not stored', { documentId, code });
  try {
    const contentTags = await tagDocumentContent(input);
    const { error } = await admin
      .from(TABLE.DOCUMENTS)
      .update({ content_tags: contentTags })
      .eq('id', documentId);
    if (error) logFailure(errorCodeOf(error));
  } catch (err) {
    logFailure(errorCodeOf(err));
  }
}

/** Tags a stored document after the response is sent, so the upload never
 *  waits for extraction. Where after() is not available the write simply
 *  runs unanchored (as src/lib/ignatious/benchRequest.ts does). */
export function scheduleDocumentContentTags(
  admin: SupabaseClient,
  documentId: string,
  input: { name: string; type: string | null; bytes: Uint8Array },
): void {
  const task = () => storeDocumentContentTags(admin, documentId, input);
  try {
    after(task);
  } catch {
    void task();
  }
}
