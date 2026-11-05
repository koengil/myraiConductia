// Demo-only (#460): the identities a proposal row carries. Delete this folder when #459 lands.
//
// A row is one message, not one text: two distinct messages with the same
// subject and body share a content hash, so the row's identity is the message
// itself. The Internet message id is discovery's dedupe identity already
// (normalizeMessage, source_items), but the sender writes it and it can look
// like an address, so a row stores only its hash.

import { createHash } from 'node:crypto';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** sha256 hex of the trimmed Internet message id: the proposal row's identity, never the raw id. */
export function messageKey(internetMessageId: string): string {
  return sha256(internetMessageId.trim());
}

/** The longest slug a model-named deal key carries. */
const MAX_SLUG = 64;

/**
 * The slug of a deal name the model proposed: lowercase ASCII letters, digits and dashes, so
 * "Project Kestrel" and "project  kestrel" are one deal. A name with nothing left after folding
 * (a non-Latin script, say) falls back to a hash of the lowercased name, so it still has one key.
 */
export function dealSlug(name: string): string {
  const folded = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
  return folded || `h-${sha256(name.trim().toLowerCase()).slice(0, 16)}`;
}

/**
 * A deal key's shape: the CHECK on discovery_model_proposals.deal_key and on the dismissals table
 * (20261023120100), so a request that cannot name a row is refused before the database is asked.
 */
export const DEAL_KEY_RX = /^(c:[0-9a-f-]{36}|m:[a-z0-9-]{1,64})$/;

/** An `m:` key alone: the CHECK on discovery_model_proposal_accepts.deal_key (20261023140100). Only these can be accepted. */
export const MODEL_DEAL_KEY_RX = /^m:[a-z0-9-]{1,64}$/;

/** A station id's shape, as discovery_accept_model_proposal checks it (20261023140100). */
export const PROPOSED_STEP_ID_RX = /^p[1-5]-s[0-9]+$/;

/** The deal key of a rules-found candidate. */
export const candidateKey = (candidateId: string) => `c:${candidateId}`;
/** The deal key of a deal only the model has named. */
export const modelKey = (name: string) => `m:${dealSlug(name)}`;
