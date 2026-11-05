// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GMAIL_METADATA_HEADERS } from '@/lib/constants/googleReader';
import { GMAIL_REPLAY_FORMAT, type GmailReplay } from '@/lib/google/replay/format';

import { DEFAULT_RECORDED_DIR, TRANSFORMED_NOTE, transformReplay } from '../../scripts/google/rekey-recorded-replays';

// #263: the three recorded Gmail replays are re-keyed and masked by a committed, deterministic transform (R13). The
// committed files are its fixed point, carry the note, hold no body excerpt in any answer read before the policy's
// verdict, and keep every format=raw answer exactly as Google recorded it. The hashes below are of those raw answers
// in the recordings before the transform (89bf8fc0), so a transform that touched a raw body would fail here.
const RAW_ANSWERS_BEFORE_TRANSFORM: Record<string, string> = {
  'alex.chen@bank.example': '55b1b01e6a40bc997f65aecf02acf8e06d783bc8289aa39a6642f7f526716c49',
  'morgan.vale@bank.example': '99d08d92c8c9c3faab9fac5b19ed3fa771a80cae63e7a98140a6b4f5c87fc056',
  'storm.duncan@bank.example': 'd787a7df9a1d2f2c420ceab8a4d8cfaff72a3ec6b3b844b58a3c14793bf87b37',
};

const isRaw = (key: string) => /[?&]format=raw(&|$)/.test(key);

function rawAnswersHash(replay: GmailReplay): string {
  const raw: Array<[string, unknown]> = [];
  for (const [phase, entries] of Object.entries(replay.phases)) {
    for (const [key, responses] of Object.entries(entries)) if (isRaw(key)) raw.push([`${phase} ${key}`, responses]);
  }
  raw.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(raw)).digest('hex');
}

describe.each(Object.keys(RAW_ANSWERS_BEFORE_TRANSFORM))('the recorded replay of %s', (mailbox) => {
  const committed = JSON.parse(readFileSync(join(DEFAULT_RECORDED_DIR, `${mailbox}.replay.json`), 'utf8')) as GmailReplay;

  it('is the fixed point of the transform', () => {
    expect(transformReplay(committed)).toEqual(committed);
  });

  it('says it was transformed, and stays a recording', () => {
    expect(committed.transformed).toBe(TRANSFORMED_NOTE);
    expect(committed.synthetic).toBe(false);
  });

  it('holds no snippet or sizeEstimate in any answer read before the verdict', () => {
    for (const entries of Object.values(committed.phases)) {
      for (const [key, responses] of Object.entries(entries)) {
        if (isRaw(key)) continue;
        const text = JSON.stringify(responses);
        expect(text, key).not.toContain('"snippet"');
        expect(text, key).not.toContain('"sizeEstimate"');
      }
    }
  });

  it('keeps every format=raw answer as recorded', () => {
    expect(rawAnswersHash(committed)).toBe(RAW_ANSWERS_BEFORE_TRANSFORM[mailbox]);
  });

  it('holds no metadata header the reader does not ask for (#337)', () => {
    const allowed = new Set<string>(GMAIL_METADATA_HEADERS.map((h) => h.toLowerCase()));
    for (const entries of Object.values(committed.phases)) {
      for (const [key, responses] of Object.entries(entries)) {
        if (isRaw(key) || !key.includes('format=metadata')) continue;
        for (const name of JSON.stringify(responses).matchAll(/"name":"([^"]+)"/g)) expect(allowed.has(name[1].toLowerCase()), `${key} ${name[1]}`).toBe(true);
      }
    }
  });
});

describe('the rekey transform on a synthetic metadata answer (#337)', () => {
  const KEY = 'GET /gmail/v1/users/storm.duncan@bank.example/messages/m1?format=metadata&metadataHeaders=Subject&fields=id';
  const input: GmailReplay = {
    format: GMAIL_REPLAY_FORMAT,
    mailbox: 'storm.duncan@bank.example',
    synthetic: false,
    phases: {
      seeded: {
        [KEY]: [
          {
            status: 200,
            body: {
              id: 'm1',
              payload: {
                mimeType: 'text/plain',
                headers: [
                  { name: 'Subject', value: 'SECRETSUBJECT' },
                  { name: 'Date', value: 'Wed, 7 Oct 2026 09:00:00 +0000' },
                  { name: 'Bcc', value: 'partner@counsel.example' },
                  { name: 'reply-to', value: 'desk@counsel.example' },
                  { name: 'Message-ID', value: '<m1@bank.example>' },
                ],
              },
            },
          },
        ],
      },
    },
  };

  it('keeps only the headers the reader asks for, in their recorded order and casing, and is idempotent', () => {
    const once = transformReplay(input);
    const [[key, responses]] = Object.entries(once.phases.seeded);
    expect(key).toContain('metadataHeaders=Bcc');
    expect((responses[0].body as { payload: { headers: Array<{ name: string }> } }).payload.headers.map((h) => h.name)).toEqual([
      'Bcc',
      'reply-to',
      'Message-ID',
    ]);
    expect(JSON.stringify(once)).not.toContain('SECRETSUBJECT');
    expect(transformReplay(once)).toEqual(once);
  });
});
