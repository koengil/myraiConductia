// @vitest-environment node
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TEXT_CHARS,
  MAX_PDF_INFLATED_BYTES,
  MAX_PDF_PAGES,
  extractAttachmentText,
} from '../src/lib/compliance/attachmentText';
import { buildCompressedPdf, buildPdf, buildPdfPages, buildZip } from './helpers/attachmentFixtures';

// ── Synthetic fixtures, built in memory ──────────────────────────────────────

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
function buildDocx(): Buffer {
  return buildZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'word/document.xml':
      `<?xml version="1.0"?><w:document ${W}><w:body>` +
      '<w:p><w:r><w:t>Project Falcon</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">  is   confidential</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Price &amp; terms &lt;draft&gt;</w:t></w:r></w:p>' +
      '</w:body></w:document>',
    'word/footer1.xml': `<?xml version="1.0"?><w:ftr ${W}><w:p><w:r><w:t>Strictly private</w:t></w:r></w:p></w:ftr>`,
  });
}

/** An OLE compound file header, optionally naming an EncryptedPackage stream. */
function buildCompoundFile(encrypted: boolean): Buffer {
  const header = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const body = Buffer.alloc(512);
  if (encrypted) Buffer.from('EncryptedPackage', 'utf16le').copy(body, 128);
  return Buffer.concat([header, body]);
}

const b64 = (bytes: Buffer | string) => (typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes).toString('base64');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('extractAttachmentText', () => {
  it('reads the text layer of a PDF', async () => {
    const bytes = buildPdf('Project Falcon is confidential');
    const result = await extractAttachmentText({ name: 'teaser.pdf', type: 'application/pdf', contentBase64: b64(bytes) });
    expect(result).toEqual({
      ok: true,
      kind: 'pdf',
      text: 'Project Falcon is confidential',
      contentHash: sha256(bytes),
      charCount: 30,
    });
  });

  it('detects a PDF by its bytes when nothing is declared', async () => {
    const result = await extractAttachmentText({ name: 'attachment', contentBase64: b64(buildPdf('Hidden deal')) });
    expect(result).toMatchObject({ ok: true, kind: 'pdf', text: 'Hidden deal' });
  });

  it('reads every page of a multi-page PDF', async () => {
    const result = await extractAttachmentText({ name: 'cim.pdf', contentBase64: b64(buildPdfPages(['Page one text', 'Page two text'])) });
    expect(result).toMatchObject({ ok: true, kind: 'pdf', text: 'Page one text\nPage two text' });
  });

  it('separates words across page breaks and tabs with attributes, adds chart text and alt text, strips zero-width characters', async () => {
    const docx = buildZip({
      'word/document.xml':
        `<?xml version="1.0"?><w:document ${W}><w:body>` +
        '<w:p><w:r><w:t>end</w:t><w:br w:type="page"/><w:t>start</w:t><w:tab /><w:t>con\u200bfidential</w:t></w:r></w:p>' +
        '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="Draft valuation 412M"/></wp:inline></w:drawing></w:r></w:p>' +
        '</w:body></w:document>',
      'word/charts/chart1.xml': '<c:chartSpace><c:tx><a:t>Bid</a:t><a:t>ladder</a:t></c:tx></c:chartSpace>',
    });
    const result = await extractAttachmentText({ name: 'memo.docx', contentBase64: b64(docx) });
    if (!result.ok) throw new Error(`expected text, got ${result.reason}`);
    expect(result.text).toContain('end\nstart confidential');
    expect(result.text).toContain('Draft valuation 412M');
    expect(result.text).toContain('Bid ladder');
  });

  it('reads a compressed PDF stream under the cap', async () => {
    expect(await extractAttachmentText({ name: 'teaser.pdf', contentBase64: b64(buildCompressedPdf('Project Falcon', 4096)) })).toMatchObject({
      ok: true,
      kind: 'pdf',
      text: 'Project Falcon',
    });
  });

  it('reads document variables from DOCX settings (a DOCVARIABLE field shows them), not the rest of the settings', async () => {
    const docx = buildZip({
      'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>See below</w:t></w:r></w:p></w:body></w:document>`,
      'word/settings.xml': `<w:settings ${W}><w:zoom w:percent="100"/><w:docVars><w:docVar w:name="Price" w:val="Falcon floor $510M &amp; rising"/></w:docVars></w:settings>`,
    });
    const result = await extractAttachmentText({ name: 'memo.docx', contentBase64: b64(docx) });
    if (!result.ok) throw new Error(`expected text, got ${result.reason}`);
    expect(result.text).toContain('Falcon floor $510M & rising');
    expect(result.text).not.toContain('100');
  });

  it('reads a DOCX with the parts Word always writes, document properties included', async () => {
    const docx = buildZip({
      '[Content_Types].xml': '<Types/>',
      '_rels/.rels': '<Relationships/>',
      'docProps/core.xml': '<cp:coreProperties><dc:title>Project Falcon board pack</dc:title></cp:coreProperties>',
      'docProps/app.xml': '<Properties><Company>Ignatious</Company></Properties>',
      'word/_rels/document.xml.rels': '<Relationships/>',
      'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>Kickoff on Tuesday</w:t></w:r></w:p></w:body></w:document>`,
      'word/styles.xml': '<w:styles/>',
      'word/settings.xml': '<w:settings/>',
      'word/webSettings.xml': '<w:webSettings/>',
      'word/fontTable.xml': '<w:fonts/>',
      'word/numbering.xml': '<w:numbering/>',
      'word/theme/theme1.xml': '<a:theme/>',
      'word/theme/themeOverride1.xml': '<a:themeOverride/>',
      'word/printerSettings/printerSettings1.bin': 'printer bytes',
      'customXml/itemProps1.xml': '<ds:datastoreItem/>',
      'customXml/_rels/item1.xml.rels': '<Relationships/>',
    });
    const result = await extractAttachmentText({ name: 'memo.docx', contentBase64: b64(docx) });
    if (!result.ok) throw new Error(`expected text, got ${result.reason}`);
    expect(result.text).toContain('Kickoff on Tuesday');
    expect(result.text).toContain('Project Falcon board pack');
    expect(result.text).toContain('Ignatious');
  });

  it('reads a DOCX body and footer, with entities decoded and whitespace normalized', async () => {
    const result = await extractAttachmentText({ name: 'memo.docx', contentBase64: b64(buildDocx()) });
    expect(result).toMatchObject({
      ok: true,
      kind: 'docx',
      text: 'Project Falcon is confidential\nPrice & terms <draft>\n\nStrictly private',
    });
  });

  it.each(['notes.txt', 'buyers.csv', 'README.md'])('reads plain text from %s', async (name) => {
    const result = await extractAttachmentText({ name, contentBase64: b64('﻿Line one\r\n\r\n\r\n\r\nLine   two\t\t\n') });
    expect(result).toMatchObject({ ok: true, kind: 'text', text: 'Line one\n\nLine two', charCount: 18 });
  });

  it('accepts text declared only by MIME type', async () => {
    const result = await extractAttachmentText({ name: 'export', type: 'text/csv; charset=utf-8', contentBase64: b64('a,b\n1,2') });
    expect(result).toMatchObject({ ok: true, kind: 'text', text: 'a,b\n1,2' });
  });

  it('gives the same hash for the same bytes and a different one for different bytes', async () => {
    const bytes = Buffer.from('Same content', 'utf8');
    const a = await extractAttachmentText({ name: 'a.txt', contentBase64: b64(bytes) });
    const b = await extractAttachmentText({ name: 'renamed.md', type: 'text/markdown', contentBase64: b64(bytes) });
    const c = await extractAttachmentText({ name: 'a.txt', contentBase64: b64('Other content') });
    if (!a.ok || !b.ok || !c.ok) throw new Error('expected text');
    expect(a.contentHash).toBe(sha256(bytes));
    expect(b.contentHash).toBe(a.contentHash);
    expect(c.contentHash).not.toBe(a.contentHash);
    // The outbox route retains sha256(Buffer.from(contentBase64, 'base64')); the tag key matches it.
    expect(a.contentHash).toBe(createHash('sha256').update(Buffer.from(b64(bytes), 'base64')).digest('hex'));
  });

  it('reads text right up to the cap', async () => {
    const result = await extractAttachmentText({ name: 'long.txt', contentBase64: b64('x'.repeat(MAX_ATTACHMENT_TEXT_CHARS)) });
    expect(result).toMatchObject({ ok: true, charCount: MAX_ATTACHMENT_TEXT_CHARS });
  });

  describe('fails closed with a reason', () => {
    it('partial: text past the cap would go unscreened', async () => {
      expect(await extractAttachmentText({ name: 'long.txt', contentBase64: b64('x'.repeat(MAX_ATTACHMENT_TEXT_CHARS + 1)) })).toEqual({
        ok: false,
        reason: 'partial',
      });
    });

    it('partial: a PDF with a text page and a scanned page', async () => {
      expect(await extractAttachmentText({ name: 'mixed.pdf', contentBase64: b64(buildPdfPages(['Readable page', null])) })).toEqual({
        ok: false,
        reason: 'partial',
      });
    });

    it('partial: a DOCX that embeds a file', async () => {
      const docx = buildZip({
        'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>See attached</w:t></w:r></w:p></w:body></w:document>`,
        'word/embeddings/oleObject1.bin': 'binary workbook',
      });
      expect(await extractAttachmentText({ name: 'memo.docx', contentBase64: b64(docx) })).toEqual({ ok: false, reason: 'partial' });
    });

    // PR #536 review (Martín): a part this reader does not read must hold the
    // send, or Word shows text the screen never saw.
    it.each([
      ['an afChunk HTML part', 'word/afchunk.htm', '<html><body>Project Falcon closes at $510M before the announcement</body></html>'],
      ['an image', 'word/media/image1.png', 'PNG bytes'],
      ['glossary building blocks', 'word/glossary/document.xml', '<w:glossaryDocument/>'],
      ['customXml data', 'customXml/item1.xml', '<deal>Falcon</deal>'],
      ['an ActiveX control', 'word/activeX/activeX1.xml', '<ax:ocx/>'],
      ['a chart workbook', 'word/charts/embeddings/Microsoft_Excel_Worksheet.xlsx', 'xlsx bytes'],
    ])('partial: a DOCX with %s', async (_label, part, content) => {
      const docx = buildZip({
        'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>See attached</w:t></w:r></w:p></w:body></w:document>`,
        [part]: content,
      });
      expect(await extractAttachmentText({ name: 'memo.docx', contentBase64: b64(docx) })).toEqual({ ok: false, reason: 'partial' });
    });

    it('too_large: a small PDF whose stream decompresses past the cap, refused before PDF.js runs', async () => {
      const bomb = buildCompressedPdf('Falcon', MAX_PDF_INFLATED_BYTES + 1024);
      expect(bomb.length).toBeLessThan(MAX_ATTACHMENT_BYTES);
      const before = process.memoryUsage().rss;
      expect(await extractAttachmentText({ name: 'bomb.pdf', contentBase64: b64(bomb) })).toEqual({ ok: false, reason: 'too_large' });
      // The check inflates at most the cap, never the whole stream through PDF.js.
      expect(process.memoryUsage().rss - before).toBeLessThan(MAX_PDF_INFLATED_BYTES * 3);
    });

    // PR #537 review: ways to hide a stream from a scan that reads the PDF's
    // structure. Each must still be measured, or fail closed.
    describe('a decompression bomb hidden from a structural scan', () => {
      const bomb = (corruptAdler = false) => {
        const data = Buffer.from(deflateSync(Buffer.alloc(MAX_PDF_INFLATED_BYTES + 1024, 0x20)));
        if (corruptAdler) data[data.length - 1] ^= 0xff;
        return data;
      };
      const pdf = (dict: string, eol: string, data: Buffer, extra = '') =>
        Buffer.concat([
          Buffer.from(`%PDF-1.4\n${extra}1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n4 0 obj\n${dict}\nstream${eol}`, 'latin1'),
          data,
          Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
        ]);

      it.each([
        ['a fake stream keyword in a comment before it', pdf('<< /Filter /FlateDecode >>', '\n', bomb(), '%stream\n%endstream\n')],
        ['" obj" inside a string in its dictionary', pdf('<< /Z (a obj) /Filter /FlateDecode >>', '\n', bomb())],
        ['an indirect filter', pdf('<< /Filter 6 0 R >>', '\n', bomb())],
        ['a #-escaped filter name', pdf('<< /Filter /#46lateDecode >>', '\n', bomb())],
        ['a CR-only line end after stream', pdf('<< /Filter /FlateDecode >>', '\r', bomb())],
        ['spaces after stream', pdf('<< /Filter /FlateDecode >>', '  \n', bomb())],
        ['a long line after stream', pdf('<< /Filter /FlateDecode >>', `${' '.repeat(4096)}\r\n`, bomb())],
        ['a damaged checksum', pdf('<< /Filter /FlateDecode >>', '\n', bomb(true))],
      ])('too_large: %s', async (_label, bytes) => {
        expect(bytes.length).toBeLessThan(MAX_ATTACHMENT_BYTES);
        expect(await extractAttachmentText({ name: 'bomb.pdf', contentBase64: b64(bytes) })).toEqual({ ok: false, reason: 'too_large' });
      });

      it('too_large: a stream compressed twice, which PDF.js decodes layer by layer', async () => {
        const twice = Buffer.from(deflateSync(deflateSync(Buffer.alloc(MAX_PDF_INFLATED_BYTES * 4, 0x20), { level: 9 }), { level: 9 }));
        const bytes = pdf('<< /Filter [/FlateDecode /FlateDecode] >>', '\n', twice);
        expect(bytes.length).toBeLessThan(4096);
        expect(await extractAttachmentText({ name: 'bomb.pdf', contentBase64: b64(bytes) })).toEqual({ ok: false, reason: 'too_large' });
      });

      it.each([
        ['many `stream` keywords with no line end (no quadratic scan)', Buffer.from(`%PDF-1.4\n${'stream'.repeat(400_000)}`, 'latin1')],
        ['many invalid deflate blocks', Buffer.concat([Buffer.from('%PDF-1.4\n'), ...Array.from({ length: 200_000 }, () => Buffer.from([...Buffer.from('stream\n'), 0x78, 0x01, 0x07]))])],
        ['many deflate streams that break a few bytes in', Buffer.concat([Buffer.from('%PDF-1.4\n'), ...Array.from({ length: 200_000 }, () => Buffer.from([...Buffer.from('stream\n'), 0x78, 0x01, 0x00, 0x05, 0x00, 0x00, 0x00]))])],
      ])('fails closed fast on %s', async (_label, bytes) => {
        const started = Date.now();
        const result = await extractAttachmentText({ name: 'odd.pdf', contentBase64: b64(bytes) });
        expect(result.ok).toBe(false);
        expect(Date.now() - started).toBeLessThan(5_000);
      });

      it('too_large: many streams under the cap that add up past it', async () => {
        const piece = Buffer.from(deflateSync(Buffer.alloc(8 * 1024 * 1024, 0x20)));
        const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
        for (let i = 0; i < 7; i += 1) {
          parts.push(Buffer.from(`${i + 4} 0 obj\n<< /Filter /FlateDecode >>\nstream\n`, 'latin1'), piece, Buffer.from('\nendstream\nendobj\n', 'latin1'));
        }
        expect(await extractAttachmentText({ name: 'bomb.pdf', contentBase64: b64(Buffer.concat(parts)) })).toEqual({ ok: false, reason: 'too_large' });
      });

      it.each([
        ['a #-escaped LZW name', '<< /Filter /#4CZWDecode >>', 'unreadable'],
        ['a Brotli stream', '<< /Filter /BrotliDecode >>', 'unreadable'],
        ['a short filter name, which PDF.js accepts on any stream', '<< /Filter /RL >>', 'unreadable'],
        ['a #-escaped Encrypt name in the trailer', '<< /#45ncrypt 9 0 R >>', 'encrypted'],
      ])('%s fails closed', async (_label, dict, reason) => {
        const bytes = pdf(dict, '\n', Buffer.from('BT ET'));
        expect(await extractAttachmentText({ name: 'odd.pdf', contentBase64: b64(bytes) })).toEqual({ ok: false, reason });
      });

      it('unreadable: an LZW filter named only inside a compressed object stream', async () => {
        const objStm = Buffer.from(deflateSync(Buffer.from('6 0 /LZWDecode', 'latin1')));
        const bytes = pdf('<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode >>', '\n', objStm);
        expect(await extractAttachmentText({ name: 'odd.pdf', contentBase64: b64(bytes) })).toEqual({ ok: false, reason: 'unreadable' });
      });
    });

    it.each([
      ['an LZW stream', '/LZWDecode'],
      ['a filter chain', '[/ASCII85Decode /FlateDecode]'],
    ])('unreadable: a PDF with %s it cannot measure', async (_label, filter) => {
      expect(await extractAttachmentText({ name: 'odd.pdf', contentBase64: b64(buildCompressedPdf('Falcon', 0, filter)) })).toEqual({
        ok: false,
        reason: 'unreadable',
      });
    });

    it('unreadable: the name says DOCX but the bytes are a PDF (a polyglot is not guessed at)', async () => {
      expect(await extractAttachmentText({ name: 'memo.docx', contentBase64: b64(buildPdf('Hidden deal')) })).toEqual({
        ok: false,
        reason: 'unreadable',
      });
    });

    it('unreadable: a DOCX part that inflates past the zip-bomb limit', async () => {
      const bomb = buildZip({ 'word/document.xml': `<w:document ${W}>${'a'.repeat(21 * 1024 * 1024)}</w:document>` });
      expect(await extractAttachmentText({ name: 'memo.docx', contentBase64: b64(bomb) })).toEqual({ ok: false, reason: 'unreadable' });
    });

    it('unsupported_type: an image', async () => {
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
      expect(await extractAttachmentText({ name: 'chart.png', type: 'image/png', contentBase64: b64(png) })).toEqual({
        ok: false,
        reason: 'unsupported_type',
      });
    });

    it('unsupported_type: an unknown binary', async () => {
      const bin = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00, 0x00, 0xff, 0xfe]);
      expect(await extractAttachmentText({ name: 'tool.bin', contentBase64: b64(bin) })).toEqual({ ok: false, reason: 'unsupported_type' });
    });

    it('unsupported_type: a legacy .doc compound file', async () => {
      expect(await extractAttachmentText({ name: 'old.doc', contentBase64: b64(buildCompoundFile(false)) })).toEqual({
        ok: false,
        reason: 'unsupported_type',
      });
    });

    it('unsupported_type: a zip that is not a Word document (a spreadsheet)', async () => {
      const xlsx = buildZip({ 'xl/workbook.xml': '<workbook/>' });
      expect(await extractAttachmentText({ name: 'model.xlsx', contentBase64: b64(xlsx) })).toEqual({ ok: false, reason: 'unsupported_type' });
    });

    it('too_large: decoded bytes over the cap', async () => {
      const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61);
      expect(await extractAttachmentText({ name: 'big.txt', contentBase64: b64(big) })).toEqual({ ok: false, reason: 'too_large' });
    });

    it('too_large: base64 far over the cap is refused before decoding', async () => {
      const contentBase64 = 'A'.repeat(MAX_ATTACHMENT_BYTES * 2);
      expect(await extractAttachmentText({ name: 'big.txt', contentBase64 })).toEqual({ ok: false, reason: 'too_large' });
    });

    it('too_large: a PDF past the page limit is refused before any page is read', async () => {
      const pages = Array.from({ length: MAX_PDF_PAGES + 1 }, (_, i) => `Page ${i + 1}`);
      expect(await extractAttachmentText({ name: 'long.pdf', contentBase64: b64(buildPdfPages(pages)) })).toEqual({
        ok: false,
        reason: 'too_large',
      });
    });

    it('timeout: a PDF that takes longer than the send path allows, and the read is stopped', async () => {
      // A real parse of a small fixture finishes before any timer fires, so the
      // parser is replaced with one that never finishes.
      const destroy = vi.fn(() => Promise.resolve());
      vi.resetModules();
      vi.doMock('unpdf', () => ({
        getDocumentProxy: () => Promise.resolve({ numPages: 1, loadingTask: { destroy } }),
        extractText: () => new Promise(() => undefined),
      }));
      try {
        const fresh = await import('../src/lib/compliance/attachmentText');
        expect(
          await fresh.extractAttachmentText({ name: 'slow.pdf', contentBase64: b64(buildPdf('Slow page')) }, { pdfTimeoutMs: 10 }),
        ).toEqual({ ok: false, reason: 'timeout' });
        expect(destroy).toHaveBeenCalledTimes(1);
      } finally {
        vi.doUnmock('unpdf');
        vi.resetModules();
      }
    });

    it('unreadable: named .pdf but the bytes are not a PDF', async () => {
      expect(await extractAttachmentText({ name: 'deck.pdf', type: 'application/pdf', contentBase64: b64('just some text') })).toEqual({
        ok: false,
        reason: 'unreadable',
      });
    });

    it('unreadable: named .docx but the bytes are not a zip', async () => {
      expect(await extractAttachmentText({ name: 'memo.docx', contentBase64: b64('plain words') })).toEqual({ ok: false, reason: 'unreadable' });
    });

    it('unreadable: a damaged PDF', async () => {
      expect(await extractAttachmentText({ name: 'broken.pdf', contentBase64: b64('%PDF-1.4\ngarbage with no objects') })).toEqual({
        ok: false,
        reason: 'unreadable',
      });
    });

    it('unreadable: a damaged DOCX', async () => {
      const truncatedZip = buildDocx().subarray(0, 60);
      expect(await extractAttachmentText({ name: 'memo.docx', contentBase64: b64(truncatedZip) })).toEqual({ ok: false, reason: 'unreadable' });
    });

    it('unreadable: a .txt that is not UTF-8', async () => {
      const latin1 = Buffer.from('Caf\xe9 r\xe9sum\xe9', 'latin1');
      expect(await extractAttachmentText({ name: 'notes.txt', contentBase64: b64(latin1) })).toEqual({ ok: false, reason: 'unreadable' });
    });

    it('encrypted: a password-protected PDF', async () => {
      expect(await extractAttachmentText({ name: 'locked.pdf', contentBase64: b64(buildPdf('secret', true)) })).toEqual({
        ok: false,
        reason: 'encrypted',
      });
    });

    it('encrypted: a password-protected Office file', async () => {
      expect(await extractAttachmentText({ name: 'locked.docx', contentBase64: b64(buildCompoundFile(true)) })).toEqual({
        ok: false,
        reason: 'encrypted',
      });
    });

    it('empty: a zero-byte file', async () => {
      expect(await extractAttachmentText({ name: 'empty.txt', contentBase64: '' })).toEqual({ ok: false, reason: 'empty' });
    });

    it('empty: whitespace only', async () => {
      expect(await extractAttachmentText({ name: 'blank.txt', contentBase64: b64(' \n\t\r\n ') })).toEqual({ ok: false, reason: 'empty' });
    });

    it('empty: a PDF page with no text layer (a scan)', async () => {
      expect(await extractAttachmentText({ name: 'scan.pdf', contentBase64: b64(buildPdf(null)) })).toEqual({ ok: false, reason: 'empty' });
    });
  });
});
