import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '@/lib/mail/format';

/*
 * sanitizeHtml guards the reading pane's dangerouslySetInnerHTML. INBOUND
 * HTML is attacker-controlled (any counterparty can mail us), so the exact
 * bypass vectors from the PR #122 review must die here, not just the obvious
 * <script> case. Backed by DOMPurify (HTML-only profile).
 */

describe('sanitizeHtml (inbound XSS vectors)', () => {
  it('keeps benign formatting', () => {
    const out = sanitizeHtml('<p>Monday <strong>works</strong>. <a href="https://a.com">NDA</a></p>');
    expect(out).toContain('<strong>works</strong>');
    expect(out).toContain('href="https://a.com"');
  });

  it('strips scripts and event handlers', () => {
    const out = sanitizeHtml('<img src=x onerror=alert(1)><script>alert(2)</script><p onclick="x()">hi</p>');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onclick');
  });

  it('kills the obfuscated jav\\nascript: URI that beat the old blocklist', () => {
    const out = sanitizeHtml('<a href="jav\nascript:alert(1)">click</a>');
    expect(out.toLowerCase()).not.toContain('script:');
  });

  it('kills base rebasing and svg/math namespace vectors', () => {
    expect(sanitizeHtml('<base href="https://evil.com/">')).not.toContain('<base');
    const svg = sanitizeHtml('<svg><animate onbegin=alert(1) attributeName=x></svg>');
    expect(svg).not.toContain('onbegin');
    expect(svg).not.toContain('<svg');
    const math = sanitizeHtml('<math><mtext><option><style><img src=x onerror=alert(1)></style></option></mtext></math>');
    expect(math).not.toContain('onerror');
  });

  it('strips forms, style and embedding tags', () => {
    const out = sanitizeHtml(
      '<form action="https://evil.com"><input name="a"><button>go</button></form><style>*{display:none}</style><iframe src="https://evil.com"></iframe>',
    );
    for (const tag of ['<form', '<input', '<button', '<style', '<iframe']) {
      expect(out).not.toContain(tag);
    }
  });
});
