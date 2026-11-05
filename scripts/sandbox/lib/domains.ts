/** Pre-release sandbox Workspace parent (#746). Never a mail participant domain. */
export const SANDBOX_WORKSPACE_DOMAIN = 'conductia-sandbox.com';

/** Firm verified mail domains (exact allow-list for send, import and impersonation). */
export const SANDBOX_FIRM_MAIL_DOMAINS = [
  'halvorsen.conductia-sandbox.com',
  'corvane.conductia-sandbox.com',
  'ashgrove.conductia-sandbox.com',
  'thistlewood.conductia-sandbox.com',
] as const;

export type SandboxFirmMailDomain = (typeof SANDBOX_FIRM_MAIL_DOMAINS)[number];

export const SANDBOX_MAILER_SA = 'sandbox-mailer@conductia-sandbox.iam.gserviceaccount.com';

const FIRM_SET = new Set<string>(SANDBOX_FIRM_MAIL_DOMAINS);

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  if (at === -1) throw new Error(`invalid email: ${email}`);
  return email.slice(at + 1).toLowerCase();
}

export function isSandboxFirmMailDomain(domain: string): domain is SandboxFirmMailDomain {
  return FIRM_SET.has(domain.toLowerCase());
}

/** Every cast/import address must be on a firm subdomain, never the bare parent. */
export function assertSandboxMailAddress(email: string): void {
  const domain = emailDomain(email);
  if (domain === SANDBOX_WORKSPACE_DOMAIN) {
    throw new Error(`Refusing: ${email} uses the bare workspace parent ${SANDBOX_WORKSPACE_DOMAIN}`);
  }
  if (!isSandboxFirmMailDomain(domain)) {
    throw new Error(
      `Refusing: ${email} is outside sandbox firm domains (${SANDBOX_FIRM_MAIL_DOMAINS.join(', ')})`,
    );
  }
}

export function assertSandboxMailAddresses(emails: string[]): void {
  for (const email of emails) assertSandboxMailAddress(email);
}
