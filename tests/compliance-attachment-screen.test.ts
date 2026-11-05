import { describe, expect, it } from 'vitest';
import { MAX_SCREENED_ATTACHMENT_CHARS, readAttachments } from '@/lib/compliance/attachmentScreen';

const textFile = (name: string, text: string) => ({ name, type: 'text/plain', contentBase64: Buffer.from(text).toString('base64') });

describe('readAttachments: the screened text budget (PR #495 review)', () => {
  it('screens attachments that fit together, and holds the one that would push the prompt past the budget', async () => {
    const half = 'a'.repeat(MAX_SCREENED_ATTACHMENT_CHARS / 2);
    const { texts, findings } = await readAttachments([
      textFile('one.txt', half),
      textFile('two.txt', half),
      textFile('three.txt', 'b'),
    ]);
    expect(texts).toEqual([half, half]);
    expect(findings.map((f) => f.read)).toEqual(['ok', 'ok', 'too_large']);
  });

  it('a later small attachment still fits after a skipped large one', async () => {
    const { findings } = await readAttachments([
      textFile('big.txt', 'a'.repeat(MAX_SCREENED_ATTACHMENT_CHARS + 1)),
      textFile('small.txt', 'fine'),
    ]);
    expect(findings.map((f) => f.read)).toEqual(['too_large', 'ok']);
  });
});
