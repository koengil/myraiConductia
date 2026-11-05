import { describe, expect, it } from 'vitest';

import {
  contentDispositionAttachment,
  sanitizeDownloadFilename,
} from '@/lib/http/contentDisposition';

describe('contentDispositionAttachment', () => {
  it('strips CRLF and quotes that could inject response headers', () => {
    expect(sanitizeDownloadFilename('report\r\nEvil: yes.pdf')).toBe('reportEvil: yes.pdf');
    expect(contentDispositionAttachment('report\r\nEvil: yes.pdf')).toBe(
      'attachment; filename="reportEvil: yes.pdf"',
    );
  });

  it('falls back when the sanitized name is empty', () => {
    expect(sanitizeDownloadFilename('\r\n"')).toBe('download');
  });
});
