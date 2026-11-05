import { describe, expect, it } from 'vitest';

import { artifactHeaders } from '@/lib/ignatious/artifactHeaders';

/*
 * #226 part A: the artifact proxy routes must never echo an upstream media type
 * that a browser would render as a document on Conductia's origin.
 */

const h = (init: Record<string, string> = {}) => new Headers(init);

describe('artifactHeaders: non-inert or unknown types become an opaque download', () => {
  it.each([
    ['text/html; charset=utf-8'],
    ['image/svg+xml'],
    ['application/xml'],
    ['text/xml'],
    ['application/x-new'],
    ['TEXT/HTML'],
  ])('%s', (type) => {
    const out = artifactHeaders(h({ 'content-type': type }));
    expect(out['content-type']).toBe('application/octet-stream');
    expect(out['content-disposition']).toBe('attachment');
    expect(out['x-content-type-options']).toBe('nosniff');
  });

  it('a missing content-type is treated as unknown', () => {
    const out = artifactHeaders(h());
    expect(out['content-type']).toBe('application/octet-stream');
    expect(out['content-disposition']).toBe('attachment');
    expect(out['x-content-type-options']).toBe('nosniff');
  });

  it('ignores an upstream inline disposition on a non-inert type', () => {
    const out = artifactHeaders(h({ 'content-type': 'text/html', 'content-disposition': 'inline' }));
    expect(out['content-type']).toBe('application/octet-stream');
    expect(out['content-disposition']).toBe('attachment');
  });
});

describe('artifactHeaders: allowlisted inert types pass through', () => {
  it.each([
    ['text/markdown'],
    ['text/plain; charset=utf-8'],
    ['text/csv'],
    ['application/json'],
    ['application/pdf'],
    ['image/png'],
    ['image/jpeg'],
    ['image/gif'],
    ['image/webp'],
  ])('%s keeps its type and falls back to attachment', (type) => {
    const out = artifactHeaders(h({ 'content-type': type }));
    expect(out['content-type']).toBe(type);
    expect(out['content-disposition']).toBe('attachment');
    expect(out['x-content-type-options']).toBe('nosniff');
  });

  it('keeps the upstream disposition when it sends one', () => {
    const out = artifactHeaders(
      h({ 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="a.pdf"' }),
      { filename: 'other.pdf' },
    );
    expect(out['content-disposition']).toBe('attachment; filename="a.pdf"');
  });
});

describe('artifactHeaders: filename fallback', () => {
  it('names the attachment after the artifact (md-briefing download name kept)', () => {
    const out = artifactHeaders(h({ 'content-type': 'text/markdown' }), { filename: 'brief.md' });
    expect(out['content-disposition']).toBe(`attachment; filename="brief.md"; filename*=UTF-8''brief.md`);
  });

  it('neutralises quotes, CR, LF and non-ASCII in filename=, real name only in filename*', () => {
    const hostile = artifactHeaders(h({ 'content-type': 'text/html' }), {
      filename: 'x".html\r\nSet-Cookie: a',
    });
    expect(hostile['content-type']).toBe('application/octet-stream');
    const disposition = hostile['content-disposition'];
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toMatch(/^attachment; filename="x_\.html__Set-Cookie: a"; filename\*=UTF-8''/);
    expect(disposition).toContain('%0D%0A');

    const accented = artifactHeaders(h({ 'content-type': 'text/html' }), { filename: 'mémo.md' });
    expect(accented['content-disposition']).toBe(
      `attachment; filename="m_mo.md"; filename*=UTF-8''m%C3%A9mo.md`,
    );
  });
});
