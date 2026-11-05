import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendInviteEmail, sendInviteVerificationEmail } from '../src/lib/email/resend';
import { EMAIL_PALETTE, EMAIL_FONTS } from '../src/lib/email/workbenchEmail';

/**
 * The invitation is the first thing a counterparty sees from Conductia, so it
 * carries the Workbench register. These tests measure the rendered template
 * rather than inspecting the source: they parse the HTML, resolve each text
 * element's declared colour pair, and compute the actual contrast ratio.
 */

const ORIGIN = 'https://app.example';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function capture(send: () => Promise<void>): Promise<string> {
  vi.stubEnv('RESEND_API_KEY', 'test-key');
  // develop fails closed on an unset sender; supply a verified-domain one.
  vi.stubEnv('RESEND_FROM', 'Conductia <invites@conductia.com>');
  const fetchMock = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  await send();
  const [, init] = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit];
  return (JSON.parse(init.body as string) as { html: string }).html;
}

const inviteHtml = () =>
  capture(() =>
    sendInviteEmail({
      to: 'recipient@example.com',
      origin: ORIGIN,
      acceptUrl: 'https://app.example/accept-invite?opaque=1',
      inviterName: 'Storm Duncan',
      companyName: 'Futureproofing Capital',
      dealCodename: 'Project North',
    }),
  );

const verifyHtml = () =>
  capture(() =>
    sendInviteVerificationEmail({
      to: 'recipient@example.com',
      origin: ORIGIN,
      verificationCode: '123456',
      challengeVersion: 2,
    }),
  );

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const v = parseInt(hex.replace('#', ''), 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((v >> 16) & 0xff) +
    0.7152 * channel((v >> 8) & 0xff) +
    0.0722 * channel(v & 0xff)
  );
}

function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** Elements holding their own visible text. */
function textElements(doc: Document): HTMLElement[] {
  return [...doc.body.querySelectorAll<HTMLElement>('*')].filter((el) =>
    [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0),
  );
}

function declared(el: HTMLElement, property: 'color' | 'background-color'): string | null {
  const match = (el.getAttribute('style') ?? '').match(
    new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i'),
  );
  return match ? match[1].trim() : null;
}

const BODIES: [string, () => Promise<string>][] = [
  ['invitation', inviteHtml],
  ['verification', verifyHtml],
];

describe.each(BODIES)('%s email', (_name, html) => {
  it('declares a colour pair on every element that renders text', async () => {
    const doc = parse(await html());
    for (const el of textElements(doc)) {
      if (el.tagName === 'STRONG' && el.attributes.length === 0) {
        // The one exception: the hermetic mail parser matches a bare
        // <strong>, so it cannot carry a style. Its parent answers for it.
        const parent = el.parentElement as HTMLElement;
        expect(declared(parent, 'color'), 'code parent color').toBeTruthy();
        expect(declared(parent, 'background-color'), 'code parent background').toBeTruthy();
        continue;
      }
      expect(declared(el, 'color'), `${el.tagName}: ${el.textContent?.slice(0, 30)}`).toBeTruthy();
      expect(
        declared(el, 'background-color'),
        `${el.tagName}: ${el.textContent?.slice(0, 30)}`,
      ).toBeTruthy();
    }
  });

  it('clears WCAG AA on every declared pair', async () => {
    const doc = parse(await html());
    for (const el of textElements(doc)) {
      const source =
        el.tagName === 'STRONG' && el.attributes.length === 0
          ? (el.parentElement as HTMLElement)
          : el;
      const fg = declared(source, 'color');
      const bg = declared(source, 'background-color');
      if (!fg || !bg) continue;
      expect(
        contrast(fg, bg),
        `${el.tagName} ${fg} on ${bg}: ${el.textContent?.slice(0, 30)}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('uses only Workbench palette values', async () => {
    const allowed = new Set(Object.values(EMAIL_PALETTE).map((c) => c.toLowerCase()));
    const used = (await html()).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    for (const colour of used) {
      expect(allowed, `unregistered colour ${colour}`).toContain(colour.toLowerCase());
    }
  });

  it('carries no trace of the retired navy register', async () => {
    const body = (await html()).toLowerCase();
    for (const retired of ['#0b1226', '#111a33', '#232d4d', '#3d6bff', 'manrope', 'jetbrains']) {
      expect(body, retired).not.toContain(retired);
    }
  });

  it('declares a light colour scheme so clients do not invent one', async () => {
    const body = await html();
    expect(body).toContain('name="color-scheme" content="light"');
    expect(body).toContain('supported-color-schemes');
  });

  it('requests no webfont', async () => {
    const body = await html();
    expect(body).not.toContain('fonts.googleapis');
    expect(body).not.toContain('@import');
    expect(body).toContain(EMAIL_FONTS.interface);
  });

  it('carries the canonical mark as its only image, from the application origin', async () => {
    const doc = parse(await html());
    const images = [...doc.querySelectorAll('img')];
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute('src')).toBe(
      `${ORIGIN}/conductia/email/conductia-mark-ink.png`,
    );
    expect(images[0].getAttribute('alt')).toBe('Conductia');
    // No marketing or third-party host.
    expect(await html()).not.toContain('conductia.com/assets');
  });

  it('survives image suppression with the brand and the critical content intact', async () => {
    const doc = parse(await html());
    doc.querySelectorAll('img').forEach((img) => img.remove());
    const text = doc.body.textContent ?? '';
    // The wordmark is live text, not part of the raster.
    expect(text).toContain('Conductia');
    expect(text).toMatch(/expires/i);
  });

  it('keeps em-dashes out of visible copy', async () => {
    const doc = parse(await html());
    expect(doc.body.textContent ?? '').not.toContain('—');
  });
});

describe('invitation email', () => {
  it('keeps the action link and the audit guarantee', async () => {
    const body = await inviteHtml();
    const doc = parse(body);
    const link = doc.querySelector('a[href]');
    expect(link?.getAttribute('href')).toBe('https://app.example/accept-invite?opaque=1');
    expect(doc.body.textContent).toContain('recorded in the deal audit log');
    // develop states the real TTL rather than a hard-coded "7 days".
    expect(doc.body.textContent).toMatch(/expires within \d+ hours/);
  });

  it('spends the register’s one serif moment on the headline', async () => {
    const body = await inviteHtml();
    expect(body).toContain(EMAIL_FONTS.serif);
    // Georgia is the letterhead voice, not a wordmark substitute.
    expect(body.match(new RegExp(EMAIL_FONTS.serif.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')))
      .toHaveLength(1);
  });
});

describe('verification email', () => {
  it('keeps the code in the bare element the mail parser matches', async () => {
    const body = await verifyHtml();
    expect(body).toMatch(/<strong>(\d{6})<\/strong>/);
    expect(/<strong>(\d{6})<\/strong>/.exec(body)?.[1]).toBe('123456');
  });

  it('keeps the supersession and non-sharing guarantees', async () => {
    const text = parse(await verifyHtml()).body.textContent ?? '';
    expect(text).toContain('use the one with the highest code number');
    expect(text).toContain('Each resend replaces the previous code.');
    expect(text).toContain('Do not share it with anyone.');
    // The body-visible code number develop added must survive the restyle.
    expect(text).toContain('This is code number 2 for your invitation.');
  });
});
