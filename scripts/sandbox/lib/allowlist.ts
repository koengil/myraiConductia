import {
  SANDBOX_FIRM_MAIL_DOMAINS,
  SANDBOX_WORKSPACE_DOMAIN,
  assertSandboxMailAddress,
  emailDomain,
} from './domains';
import type { Address, SandboxFixture, SandboxMessage } from './types';

export { emailDomain, assertSandboxMailAddress } from './domains';

export function sandboxAllowedDomains(_fixture?: SandboxFixture): readonly string[] {
  return SANDBOX_FIRM_MAIL_DOMAINS;
}

export function isSandboxAllowedEmail(email: string): boolean {
  try {
    assertSandboxMailAddress(email);
    return true;
  } catch {
    return false;
  }
}

export function collectAddresses(message: SandboxMessage): string[] {
  const all: Address[] = [message.from, ...message.to, ...message.cc];
  return all.map((a) => a.address);
}

/** Hard allow-list: every participant must be on an approved firm subdomain (#658, #746). */
export function assertSandboxRecipients(_fixture: SandboxFixture, messages: SandboxMessage[]): void {
  for (const message of messages) {
    for (const email of collectAddresses(message)) {
      assertSandboxMailAddress(email);
    }
  }
}

/** Impersonation / import mailbox must match the cast address and firm allow-list. */
export function assertSandboxMailbox(mailbox: string): void {
  assertSandboxMailAddress(mailbox.toLowerCase());
}

export function assertFixtureMatchesSandboxPins(fixture: SandboxFixture): void {
  if (fixture.domain.toLowerCase() !== SANDBOX_WORKSPACE_DOMAIN) {
    throw new Error(`sandbox fixture: domain must be ${SANDBOX_WORKSPACE_DOMAIN}`);
  }
  for (const [key, org] of Object.entries(fixture.orgs)) {
    const domain = org.domain?.toLowerCase();
    if (!domain || !SANDBOX_FIRM_MAIL_DOMAINS.includes(domain as (typeof SANDBOX_FIRM_MAIL_DOMAINS)[number])) {
      throw new Error(`sandbox fixture: orgs.${key}.domain must be one of the sandbox firm domains`);
    }
  }
  for (const member of fixture.cast) {
    if (emailDomain(member.email) !== fixture.orgs[member.org]?.domain.toLowerCase()) {
      throw new Error(`sandbox fixture: cast ${member.id} email must match org domain`);
    }
    assertSandboxMailAddress(member.email);
  }
}
