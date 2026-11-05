import { describe, expect, it } from 'vitest';

import { BOX_NAME_MAX_LENGTH, boxSafeFileName, boxSafeName } from '@/lib/box';

describe('boxSafeName (#328)', () => {
  it('turns forward and back slashes into hyphens', () => {
    expect(boxSafeName('ATLAS-2026-001 — Document Intake / Metadata')).toBe(
      'ATLAS-2026-001 — Document Intake - Metadata',
    );
    expect(boxSafeName('Q3\\board/pack.pdf')).toBe('Q3-board-pack.pdf');
  });

  it('trims whitespace and strips trailing dots', () => {
    expect(boxSafeName('  Board pack  ')).toBe('Board pack');
    expect(boxSafeName('Board pack.')).toBe('Board pack');
    expect(boxSafeName('Board pack. . ..')).toBe('Board pack');
  });

  it('returns the fallback for ".", ".." and an empty name', () => {
    expect(boxSafeName('.')).toBe('Untitled');
    expect(boxSafeName('..')).toBe('Untitled');
    expect(boxSafeName('')).toBe('Untitled');
    expect(boxSafeName('   ')).toBe('Untitled');
    expect(boxSafeName('..', 'brief.docx')).toBe('brief.docx');
  });

  it('returns the fallback for names made only of dots and spaces', () => {
    for (const name of ['...', '. .', ' . . ', '.\u200b.']) {
      expect(boxSafeName(name)).toBe('Untitled');
      expect(boxSafeFileName(name)).toBe('Untitled');
    }
  });

  it('makes the fallback itself safe', () => {
    expect(boxSafeName('..', 'Q3/brief.docx.')).toBe('Q3-brief.docx');
    expect(boxSafeName('..', '...')).toBe('Untitled');
    expect(boxSafeName('', '\u202e\u200b')).toBe('Untitled');
    expect(boxSafeName('', 'b'.repeat(300))).toBe('b'.repeat(BOX_NAME_MAX_LENGTH));
    expect(boxSafeFileName('. .', 'Q3\\brief.docx ')).toBe('Q3-brief.docx');
    expect(boxSafeFileName('', '..')).toBe('Untitled');
  });

  it('strips zero-width and bidi format characters', () => {
    expect(boxSafeName('Board\u200b pack\u200f')).toBe('Board pack');
    expect(boxSafeName('\u202aBoard\u202e pack\u202c')).toBe('Board pack');
    expect(boxSafeName('\u2066Board\u2069 pack\ufeff')).toBe('Board pack');
    expect(boxSafeFileName('invoice\u202efdp.exe')).toBe('invoicefdp.exe');
    expect(boxSafeName('pack.\u200d')).toBe('pack');
  });

  it('strips control characters', () => {
    expect(boxSafeName('Board\u0000 pack\u0007\n\t.pdf\u007f\u0085')).toBe('Board pack.pdf');
    expect(boxSafeName('\u0001\u001f')).toBe('Untitled');
  });

  it('caps a 300-character name at 255', () => {
    const capped = boxSafeName('a'.repeat(300));
    expect(capped).toBe('a'.repeat(BOX_NAME_MAX_LENGTH));
    expect(BOX_NAME_MAX_LENGTH).toBe(255);
  });

  it('never splits a surrogate pair at the cap', () => {
    // 254 ASCII characters, then emoji (two UTF-16 units each): the first
    // emoji straddles the 255 boundary and must be dropped whole.
    const name = `${'a'.repeat(254)}${'\u{1F4C4}'.repeat(23)}`;
    expect(name.length).toBe(300);

    const capped = boxSafeName(name);

    expect(capped).toBe('a'.repeat(254));
    expect(capped.length).toBeLessThanOrEqual(BOX_NAME_MAX_LENGTH);
    expect(/[\ud800-\udbff]$/.test(capped)).toBe(false);
  });

  it('keeps whole surrogate pairs that fit under the cap', () => {
    const name = `${'a'.repeat(253)}${'\u{1F4C4}'.repeat(24)}`;
    const capped = boxSafeName(name);
    expect(capped).toBe(`${'a'.repeat(253)}\u{1F4C4}`);
    expect(capped.length).toBe(BOX_NAME_MAX_LENGTH);
  });

  it('strips a trailing dot the cap exposes', () => {
    const name = `${'a'.repeat(254)}.${'b'.repeat(45)}`;
    expect(boxSafeName(name)).toBe('a'.repeat(254));
  });

  it('returns a safe name byte-identical', () => {
    for (const name of [
      'ATLAS-2026-001 — MD Briefing + Company Backgrounding',
      'ATLAS-2026-001',
      'develop',
      'Conductia',
      'internal',
      'dealroom',
      'Q3 board pack (final).pdf',
      'Café résumé \u{1F4C4}.docx',
      '.hidden',
      'a'.repeat(BOX_NAME_MAX_LENGTH),
    ]) {
      expect(boxSafeName(name)).toBe(name);
    }
  });
});

describe('boxSafeFileName (#328)', () => {
  it('keeps the extension and cuts an ASCII stem', () => {
    const safe = boxSafeFileName(`${'a'.repeat(300)}.pdf`);
    expect(safe).toBe(`${'a'.repeat(BOX_NAME_MAX_LENGTH - 4)}.pdf`);
    expect(safe.length).toBe(BOX_NAME_MAX_LENGTH);
  });

  it('keeps the extension and cuts a multibyte stem', () => {
    const safe = boxSafeFileName(`${'\u00e9'.repeat(300)}.docx`);
    expect(safe).toBe(`${'\u00e9'.repeat(BOX_NAME_MAX_LENGTH - 5)}.docx`);
    expect(safe.length).toBe(BOX_NAME_MAX_LENGTH);
  });

  it('never splits a surrogate pair in the stem', () => {
    // The stem gets 251 units: 250 ASCII, then an emoji straddling the cut.
    const safe = boxSafeFileName(`${'a'.repeat(250)}${'\u{1F4C4}'.repeat(30)}.pdf`);
    expect(safe).toBe(`${'a'.repeat(250)}.pdf`);
    expect(safe.length).toBeLessThanOrEqual(BOX_NAME_MAX_LENGTH);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(safe)).toBe(false);
  });

  it('keeps an extension of exactly ten characters', () => {
    const safe = boxSafeFileName(`${'a'.repeat(300)}.abcdefghij`);
    expect(safe).toBe(`${'a'.repeat(BOX_NAME_MAX_LENGTH - 11)}.abcdefghij`);
  });

  it('treats an "extension" over ten characters as stem', () => {
    const safe = boxSafeFileName(`${'a'.repeat(300)}.abcdefghijk`);
    expect(safe).toBe('a'.repeat(BOX_NAME_MAX_LENGTH));
  });

  it('treats a leading dot as stem, not as an extension', () => {
    const safe = boxSafeFileName(`.${'a'.repeat(300)}`);
    expect(safe).toBe(`.${'a'.repeat(BOX_NAME_MAX_LENGTH - 1)}`);
  });

  it('sanitizes like boxSafeName and passes a safe name through byte-identical', () => {
    expect(boxSafeFileName('Q3\\board/pack.pdf.')).toBe('Q3-board-pack.pdf');
    for (const name of ['Q3 board pack (final).pdf', 'Café résumé \u{1F4C4}.docx', '.hidden']) {
      expect(boxSafeFileName(name)).toBe(name);
    }
  });
});
