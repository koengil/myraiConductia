import type { RecipientBoundary } from '@/lib/constants/outbox';

export type { RecipientBoundary };
export type MailDomainPolicy = { verifiedDomains: string[] };

function asciiDomain(raw: string): string | null {
  // URL parsing supplies IDNA conversion, never permissive URL syntax.
  if (!raw || /[\s/@:#?%\\]/.test(raw)) return null;
  try {
    const domain = new URL(`https://${raw}`).hostname.toLowerCase().replace(/\.$/, '');
    if (domain.length > 253 || !domain.includes('.') || !/^[a-z0-9.-]+$/.test(domain)) return null;
    if (domain.split('.').some((part) => !part || part.length > 63 || part.startsWith('-') || part.endsWith('-'))) return null;
    return domain;
  } catch { return null; }
}

export function recipientBoundary(recipients: readonly string[], verifiedDomains: readonly string[]): RecipientBoundary {
  const trusted = verifiedDomains.map(asciiDomain).filter((domain): domain is string => domain !== null);
  if (!recipients.length || !trusted.length) return 'unverified';
  let incomplete = false;
  for (const recipient of recipients) {
    const parts = recipient.trim().split('@');
    const domain = parts.length === 2 && parts[0] && !/\s/.test(parts[0]) ? asciiDomain(parts[1]) : null;
    if (!domain) {
      // A complete address whose domain we cannot parse is not ours to trust:
      // the outbox accepts it and it leaves the firm, so it is external. Only
      // a still-unfinished address (no local part, no domain) stays unverified.
      const complete = parts.length === 2 && Boolean(parts[0]) && /\S+\.\S+/.test(parts[1] ?? '');
      if (complete) return 'external';
      incomplete = true;
      continue;
    }
    if (!trusted.some((value) => domain === value || domain.endsWith(`.${value}`))) return 'external';
  }
  return incomplete ? 'unverified' : 'internal';
}
