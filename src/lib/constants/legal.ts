/**
 * Legal document versions. The invite acceptance attestation records this
 * value (audit_log attest, detail.tos_version) so every acceptance is bound
 * to the exact text that was live. Bump on every published revision.
 *
 * draft-2026-10-18: the privacy policy moved to its own page (/privacy), so
 * /terms is now the Terms of Service alone and links to it (#490 S5).
 */
export const TOS_VERSION = 'draft-2026-10-18';

/**
 * The privacy policy's version, shown on /privacy. Bump on every published
 * revision. The acceptance attestation does not record it yet: it records
 * TOS_VERSION only (open point for counsel, docs/03-engineering/google-oauth-verification.md).
 */
export const PRIVACY_VERSION = 'draft-2026-10-18';

/**
 * Where privacy questions and data requests go, shown on /privacy.
 * TODO(owner): confirm this mailbox exists and is monitored before the page
 * is submitted to Google (T4).
 */
export const PRIVACY_CONTACT_EMAIL = 'privacy@conductia.com';
