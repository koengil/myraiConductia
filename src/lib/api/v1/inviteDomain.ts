import { domainToASCII } from 'node:url';

export const INVITE_DOMAIN_CLASSIFICATIONS = [
  'match',
  'mismatch',
  'personal',
  'unverified',
] as const;

export type InviteDomainClassification =
  (typeof INVITE_DOMAIN_CLASSIFICATIONS)[number];

export type InviteDomainDecision = {
  normalizedEmail: string;
  classification: InviteDomainClassification;
  confirmationRequired: boolean;
  confirmationId?: string;
};

// Deliberately conservative. A configured consumer domain never becomes
// institutional reference data, even if it was inserted accidentally.
const PERSONAL_EMAIL_DOMAINS = new Set([
  'aol.com',
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'mail.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
  'yandex.com',
  'zoho.com',
]);

export function normalizeInviteEmail(raw: string): string | null {
  const trimmed = raw.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at !== trimmed.indexOf('@') || at === trimmed.length - 1) return null;

  const local = trimmed.slice(0, at).toLowerCase();
  const rawDomain = trimmed.slice(at + 1).replace(/\.$/, '');
  if (!local || /\s/.test(local) || /\s/.test(rawDomain)) return null;

  const domain = domainToASCII(rawDomain).toLowerCase();
  if (!isValidAsciiDomain(domain)) return null;
  return `${local}@${domain}`;
}
export function inviteEmailDomain(normalizedEmail: string): string {
  return normalizedEmail.slice(normalizedEmail.lastIndexOf('@') + 1);
}

export function isPersonalInviteDomain(domain: string): boolean {
  return PERSONAL_EMAIL_DOMAINS.has(domain.toLowerCase());
}

export function domainMatchesVerifiedDomain(domain: string, verifiedDomain: string): boolean {
  const candidate = domain.toLowerCase();
  const trusted = verifiedDomain.toLowerCase();
  return candidate === trusted || candidate.endsWith(`.${trusted}`);
}

export function classifyInviteDomain(
  normalizedEmail: string,
  verifiedDomains: readonly string[],
): InviteDomainClassification {
  const domain = inviteEmailDomain(normalizedEmail);
  if (isPersonalInviteDomain(domain)) return 'personal';
  if (verifiedDomains.length === 0) return 'unverified';
  return verifiedDomains.some((trusted) => domainMatchesVerifiedDomain(domain, trusted))
    ? 'match'
    : 'mismatch';
}

function isValidAsciiDomain(domain: string): boolean {
  if (!domain || domain.length > 253 || !domain.includes('.')) return false;
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.includes('..')) return false;
  return domain.split('.').every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      !label.startsWith('-') &&
      !label.endsWith('-'),
  );
}
