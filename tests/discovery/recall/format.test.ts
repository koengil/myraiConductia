import { describe, expect, it } from 'vitest';

import { inRepoCorpusFiles } from './corpus';
import { parseRecallCorpus, RecallFormatError, type RecallCorpusFiles } from './format';

// The loader's contract with the held-out corpus author (corpora/README.md): it round-trips what the builder
// emits, and fails closed on anything it does not know.

const clone = (): RecallCorpusFiles => JSON.parse(JSON.stringify(inRepoCorpusFiles())) as RecallCorpusFiles;
const refusal = (files: unknown) => {
  try {
    parseRecallCorpus(files as RecallCorpusFiles);
  } catch (error) {
    expect(error).toBeInstanceOf(RecallFormatError);
    return (error as Error).message;
  }
  throw new Error('expected the corpus to be refused');
};

describe('parseRecallCorpus', () => {
  it('round-trips the in-repo corpus through JSON', () => {
    const files = inRepoCorpusFiles();
    const parsed = parseRecallCorpus(JSON.parse(JSON.stringify(files)));
    expect(parsed.messages).toEqual(files.messages.messages);
    expect(parsed.labels).toEqual(files.labels.labels);
    expect(parsed.world).toEqual({
      firm: files.world.firm,
      sources: files.world.sources,
      people: files.world.people,
      companies: files.world.companies,
      deals: files.world.deals,
    });
  });

  it('refuses a field it does not know, in each of the three files', () => {
    const message = clone();
    (message.messages.messages[0] as unknown as Record<string, unknown>).expectedDeal = 'aster';
    expect(refusal(message)).toContain('unknown field "expectedDeal"');

    const label = clone();
    const key = Object.keys(label.labels.labels)[0];
    (label.labels.labels[key] as unknown as Record<string, unknown>).confidence = 1;
    expect(refusal(label)).toContain('unknown field "confidence"');

    const world = clone();
    (world.world.firm as unknown as Record<string, unknown>).rules = [];
    expect(refusal(world)).toContain('unknown field "rules"');
  });

  it('refuses a label for a message that is not in the corpus', () => {
    const files = clone();
    files.labels.labels['<missing@harrow.example>'] = { deal: null, form: 'noise' };
    expect(refusal(files)).toContain('a label for a message that is not in the corpus');
  });

  it('refuses a message without a label', () => {
    const files = clone();
    delete files.labels.labels[Object.keys(files.labels.labels)[0]];
    expect(refusal(files)).toContain('a message without a label');
  });

  it('refuses a source or a deal the world does not define', () => {
    const source = clone();
    (source.messages.messages[0] as { sources: string[] }).sources = ['src-nowhere'];
    expect(refusal(source)).toContain('read in a source the world does not define');

    const deal = clone();
    const key = Object.keys(deal.labels.labels).find((k) => deal.labels.labels[k].deal !== null)!;
    deal.labels.labels[key] = { ...deal.labels.labels[key], deal: 'nowhere' };
    expect(refusal(deal)).toContain('a deal the world does not define');
  });

  it('refuses another format version, an unknown form and a world without exactly one headline source', () => {
    const version = clone();
    (version.labels as { format: string }).format = 'conductia.recall-corpus/v2';
    expect(refusal(version)).toContain('format must be conductia.recall-corpus/v1');

    const form = clone();
    const key = Object.keys(form.labels.labels)[0];
    (form.labels.labels[key] as { form: string }).form = 'free_text';
    expect(refusal(form)).toContain('not an allowed value');

    const headline = clone();
    for (const source of headline.world.sources) delete source.headline;
    expect(refusal(headline)).toContain('exactly one source must be the headline');
  });

  it('looks deals and labels up as own properties: an inherited name is not defined', () => {
    // `in` would find Object.prototype's members: a deal named "toString" passed, then failed later as a TypeError.
    const deal = clone();
    const first = Object.keys(deal.labels.labels)[0];
    deal.labels.labels[first] = { ...deal.labels.labels[first], deal: 'toString' };
    expect(refusal(deal)).toMatch(/a deal the world does not define/);
    const label = clone();
    const message = label.messages.messages.find((m) => !('kind' in m))!;
    const id = (message as { internetMessageId: string }).internetMessageId;
    delete label.labels.labels[id];
    (message as { internetMessageId: string }).internetMessageId = 'constructor';
    expect(refusal(label)).toMatch(/a message without a label/);
  });

  it('refuses a repeated message id', () => {
    const files = clone();
    files.messages.messages.push(files.messages.messages[0]);
    expect(refusal(files)).toContain('duplicate entries');
  });

  it('names a path and a field, never a value', () => {
    const files = clone();
    const first = files.messages.messages[0] as { subject: string };
    const subject = first.subject;
    (first as unknown as Record<string, unknown>).subject = 42;
    expect(refusal(files)).not.toContain(subject);
  });
});
