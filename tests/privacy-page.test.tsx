import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PrivacyPage from '@/app/privacy/page';
import TermsPage from '@/app/terms/page';
import { GMAIL_SEND_REQUESTED_SCOPES } from '@/lib/constants/mailboxSend';

/**
 * #490 S5: the public privacy policy Google's sensitive-scope review reads.
 * The Limited Use statement is pinned word for word here, not imported, so an
 * edit to the page cannot quietly change it.
 */
const LIMITED_USE =
  "Conductia's use and transfer to any other app of information received from Google APIs will adhere to Google API Services User Data Policy, including the Limited Use requirements.";

function pageText(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ');
}

describe('/privacy', () => {
  it('renders with no session and no provider', () => {
    render(<PrivacyPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeTruthy();
    expect(screen.getByText(/Draft pending counsel review/)).toBeTruthy();
  });

  it('carries the Limited Use statement verbatim, linked to the policy', () => {
    render(<PrivacyPage />);
    expect(pageText()).toContain(LIMITED_USE);
    const policy = screen.getByRole('link', { name: 'Google API Services User Data Policy' });
    expect(policy.getAttribute('href')).toBe(
      'https://developers.google.com/terms/api-services-user-data-policy',
    );
  });

  it('names every scope the sending client requests', () => {
    render(<PrivacyPage />);
    const text = pageText();
    for (const scope of GMAIL_SEND_REQUESTED_SCOPES) {
      expect(text).toContain(scope.split('/').pop() ?? scope);
    }
  });

  it('discloses the AI processing of mail read for deal discovery, with zero retention and no training (#490 audit 4)', () => {
    render(<PrivacyPage />);
    const text = pageText();
    expect(text).toContain('an AI model provider, Anthropic');
    expect(text).toContain('zero data retention');
    expect(text).toContain('does not use the content to train its models');
  });

  it('says what openid and email are for, sending included, and that a refused connection keeps nothing', () => {
    render(<PrivacyPage />);
    const text = pageText();
    expect(text).toContain('and to send your messages from that address');
    expect(text).toContain('If Conductia refuses a connection');
    expect(text).toContain('stores nothing from that approval');
  });

  it('states only the Limited Use exceptions for personnel access, pending the owner (#490 audit owner item)', () => {
    render(<PrivacyPage />);
    expect(pageText()).not.toContain('personnel do not read Google user data');
    expect(pageText()).toContain('Conductia personnel read Google user data only with your affirmative agreement');
  });

  it('links to the Terms of Service', () => {
    render(<PrivacyPage />);
    expect(screen.getByRole('link', { name: 'Terms of Service' }).getAttribute('href')).toBe('/terms');
  });

  it('uses no dashes and asks no questions in its copy', () => {
    render(<PrivacyPage />);
    const text = pageText();
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toContain('?');
  });
});

describe('/terms', () => {
  it('is the Terms of Service alone and links to the privacy policy', () => {
    render(<TermsPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Terms of Service' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Privacy Policy' }).getAttribute('href')).toBe('/privacy');
    expect(pageText()).not.toMatch(/[–—]/);
  });
});

describe('the middleware matcher', () => {
  const matcher = (() => {
    const source = readFileSync(resolve(process.cwd(), 'src/middleware.ts'), 'utf8');
    const patterns = [...source.matchAll(/'(\/[^']*)'/g)].map((m) => m[1]);
    const guard = patterns.find((p) => p.includes('(?!'));
    if (!guard) throw new Error('no middleware guard pattern found');
    return new RegExp(`^${guard}$`);
  })();

  it('leaves /privacy and /terms readable without a session', () => {
    expect(matcher.test('/privacy')).toBe(false);
    expect(matcher.test('/terms')).toBe(false);
  });

  it('still guards the product', () => {
    expect(matcher.test('/projects')).toBe(true);
    expect(matcher.test('/profile')).toBe(true);
  });
});
