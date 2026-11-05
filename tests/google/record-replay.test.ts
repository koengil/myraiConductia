// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { requireLiveRun } from '../../scripts/google/lib/live';
import { scrubReplay } from '../../scripts/google/lib/scrub';
import {
  assertRecordingTarget,
  historyIdFromReplay,
  recordMailbox,
  scrubReplay as scrubReplayFromRecorder,
} from '../../scripts/google/record-replay';
import { GMAIL_REPLAY_FORMAT, replayKey, type GmailReplay, type ReplayResponse } from '@/lib/google/replay/format';

const TRIAL = 'storm@trial.example';
const PERSONA = 'storm.duncan@bank.example';

function replayWith(body: unknown, key = `GET /gmail/v1/users/${TRIAL}/profile`): GmailReplay {
  return {
    format: GMAIL_REPLAY_FORMAT,
    mailbox: TRIAL,
    synthetic: false,
    phases: { seeded: { [key]: [{ status: 200, body }] } },
  };
}

describe('scrubReplay', () => {
  it('is the recorder export', () => {
    expect(scrubReplayFromRecorder).toBe(scrubReplay);
  });

  it.each([
    ['a bearer string', { note: 'Authorization: Bearer abc' }],
    ['an access token', { note: 'ya29.a0AfB_byC' }],
    ['a private_key field', { note: 'x "private_' + 'key" y' }],
    ['a PEM block', { note: '-----' + 'BEGIN PRIVATE KEY-----' }],
  ])('rejects %s', (_label, body) => {
    expect(() => scrubReplay(replayWith(body), { [TRIAL]: PERSONA })).toThrow(/secret-shaped string/);
  });

  it('rejects a secret-shaped string in a key', () => {
    expect(() => scrubReplay(replayWith({}, 'GET /x?token=ya29.abc'), {})).toThrow(/secret-shaped string/);
  });

  it('rewrites the trial address to the persona address in paths and in identity fields', () => {
    const scrubbed = scrubReplay(
      replayWith({ emailAddress: TRIAL, userId: TRIAL, snippet: 'unchanged' }),
      { [TRIAL]: PERSONA },
    );
    expect(scrubbed.mailbox).toBe(PERSONA);
    expect(Object.keys(scrubbed.phases.seeded)).toEqual([`GET /gmail/v1/users/${PERSONA}/profile`]);
    expect(scrubbed.phases.seeded[`GET /gmail/v1/users/${PERSONA}/profile`][0].body).toEqual({
      emailAddress: PERSONA,
      userId: PERSONA,
      snippet: 'unchanged',
    });
  });

  it('refuses to return a replay that still names the trial address', () => {
    expect(() => scrubReplay(replayWith({ snippet: `write to ${TRIAL}` }), { [TRIAL]: PERSONA })).toThrow(
      /trial address remains/,
    );
  });
});

const b64url = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
const unb64url = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

function rawMessage(eol: string): string {
  return [
    `Delivered-To: storm@trial.example`,
    `Received: by 2002:a05:6000:1:b0:1 with SMTP id abc;`,
    `        Thu, 1 Oct 2026 09:00:00 -0700 (PDT)`,
    `X-Received: by 2002:a05:6000:2 with SMTP id def; Thu, 1 Oct 2026 09:00:00 -0700 (PDT)`,
    `X-Forwarded-Encrypted: i=1; AJvYcCX; storm@trial.example`,
    `ARC-Seal: i=1; a=rsa-sha256; d=google.com; s=arc`,
    `From: Morgan Vale <morgan.vale@bank.example>`,
    `To: Storm Duncan <${PERSONA}>`,
    `Subject: Project Falcon,`,
    `  next steps`,
    `Date: Thu, 1 Oct 2026 09:00:00 -0700`,
    `Message-ID: <falcon-001@bank.example>`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    `Received: this line is body text, not a header.`,
    ``,
  ].join(eol);
}

describe('scrubReplay on raw MIME (#259, recorded replay)', () => {
  const key = `GET /gmail/v1/users/${TRIAL}/messages/m1?format=raw`;

  it.each([['CRLF', '\r\n'], ['LF', '\n']])(
    'keeps only the headers the reader reads and drops transport headers Gmail adds (%s)',
    (_label, eol) => {
      const scrubbed = scrubReplay(replayWith({ id: 'm1', raw: b64url(rawMessage(eol)) }, key), { [TRIAL]: PERSONA });
      const body = scrubbed.phases.seeded[`GET /gmail/v1/users/${PERSONA}/messages/m1?format=raw`][0].body as { raw: string };
      const text = unb64url(body.raw);
      const [head, ...rest] = text.split(`${eol}${eol}`);
      expect(head.split(eol).map((line) => line.split(':')[0])).toEqual([
        'From',
        'To',
        'Subject',
        '  next steps',
        'Date',
        'Message-ID',
        'MIME-Version',
        'Content-Type',
      ]);
      expect(text).not.toMatch(/trial\.example|Delivered-To|X-Received|X-Forwarded|ARC-Seal|SMTP id/);
      // The body is untouched, even a body line that looks like a header.
      expect(rest.join(`${eol}${eol}`)).toBe(`Received: this line is body text, not a header.${eol}`);
    },
  );

  it('refuses a raw message that still names the trial address in a header the reader keeps', () => {
    const raw = b64url(`From: Storm <${TRIAL}>\r\nSubject: x\r\n\r\nbody\r\n`);
    expect(() => scrubReplay(replayWith({ id: 'm1', raw }, key), { [TRIAL]: PERSONA })).toThrow(/trial address remains/);
  });
});

describe('replayKey', () => {
  it('sorts query parameters and keeps repeated historyTypes in order', () => {
    const url =
      'https://gmail.googleapis.com/gmail/v1/users/a%40b.example/history?startHistoryId=9&historyTypes=messageAdded&maxResults=100&historyTypes=labelRemoved';
    expect(replayKey('get', url)).toBe(
      'GET /gmail/v1/users/a@b.example/history?historyTypes=messageAdded&historyTypes=labelRemoved&maxResults=100&startHistoryId=9',
    );
  });

  it('has no query separator when there are no parameters', () => {
    expect(replayKey('GET', 'https://gmail.googleapis.com/gmail/v1/users/a%40b.example/profile')).toBe(
      'GET /gmail/v1/users/a@b.example/profile',
    );
  });
});

describe('recordMailbox', () => {
  it('records the superset under persona-addressed keys and follows pagination', async () => {
    const asked: string[] = [];
    const answers: Record<string, unknown> = {
      profile: { emailAddress: TRIAL, historyId: '77' },
    };
    const get = async (url: string): Promise<ReplayResponse> => {
      asked.push(url);
      const u = new URL(url);
      const path = decodeURIComponent(u.pathname);
      if (path.endsWith('/profile')) return { status: 200, body: answers.profile };
      if (path.endsWith('/threads')) {
        return u.searchParams.get('pageToken')
          ? { status: 200, body: { threads: [{ id: 't2' }] } }
          : { status: 200, body: { threads: [{ id: 't1' }], nextPageToken: 'p2' } };
      }
      if (path.endsWith('/messages')) return { status: 200, body: { messages: [{ id: 'm1' }] } };
      if (path.endsWith('/history')) return { status: 200, body: { history: [] } };
      return { status: 200, body: { id: 'x' } };
    };

    const replay = await recordMailbox({ get, trialAddress: TRIAL, persona: PERSONA, phase: 'after-imports', startHistoryId: '77' });
    const keys = Object.keys(replay.phases['after-imports']);
    expect(keys.every((k) => k.includes(PERSONA) && !k.includes(TRIAL))).toBe(true);
    // Keys sort their query parameters by name; the listing carries the reader's fields mask (#263).
    expect(keys.some((k) => k.includes('/threads?fields=threads(id,historyId),nextPageToken&includeSpamTrash=false&maxResults=100&pageToken=p2'))).toBe(true);
    expect(keys.some((k) => k.includes('/threads/t1?') && k.includes('format=metadata') && k.includes('metadataHeaders=From'))).toBe(true);
    expect(keys.some((k) => k.includes('/messages/m1?format=raw'))).toBe(true);
    expect(keys.some((k) => /\/messages\/m1\?fields=[^&]+&format=metadata/.test(k))).toBe(true);
    expect(
      keys.some((k) => k.includes('/history?fields=history(') && k.includes('historyTypes=messageAdded&historyTypes=labelRemoved&maxResults=100&startHistoryId=77')),
    ).toBe(true);
    // Requests go to the trial address; only the recording names the persona.
    expect(asked.every((u) => u.includes(encodeURIComponent(TRIAL)))).toBe(true);

    const seeded = await recordMailbox({ get, trialAddress: TRIAL, persona: PERSONA, phase: 'seeded' });
    expect(Object.keys(seeded.phases.seeded).some((k) => k.includes('/history'))).toBe(false);
    expect(historyIdFromReplay(seeded, 'seeded')).toBe('77');
  });
});

describe('recording guards', () => {
  it('refuses a repo path outside evals/out and allows evals/out and paths outside the repo', () => {
    const root = '/work/repo';
    expect(() => assertRecordingTarget('/work/repo/tests/fixtures', root)).toThrow(/inside the repo/);
    expect(() => assertRecordingTarget('/work/repo', root)).toThrow(/inside the repo/);
    expect(() => assertRecordingTarget('/work/repo/evals/other', root)).toThrow(/inside the repo/);
    expect(assertRecordingTarget('/work/repo/evals/out/replays', root)).toBe('/work/repo/evals/out/replays');
    expect(assertRecordingTarget('/home/owner/recordings', root)).toBe('/home/owner/recordings');
  });

  it('refuses a domain that is not a listed test domain, and a run without --live or the domain confirmation', () => {
    const testDomains = ['trial.example'];
    const ok = ['--live', '--confirm-domain', 'trial.example'];
    expect(() => requireLiveRun(ok, 'trial.example', { testDomains })).not.toThrow();
    expect(() => requireLiveRun(ok, 'bank.example', { testDomains })).toThrow(/--confirm-domain must equal bank.example/);
    expect(() => requireLiveRun(['--live', '--confirm-domain', 'bank.example'], 'bank.example', { testDomains })).toThrow(
      /not a test domain/,
    );
    expect(() => requireLiveRun(['--confirm-domain', 'trial.example'], 'trial.example', { testDomains })).toThrow(/--live/);
    expect(() => requireLiveRun(['--live'], 'trial.example', { testDomains })).toThrow(/--confirm-domain/);
  });
});
