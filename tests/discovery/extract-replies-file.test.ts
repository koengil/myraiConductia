// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { DEV_TENANT_ID } from '@/lib/db/tenant';
import { OperatorCopyError } from '@/lib/errors/upstream';

import { DEFAULT_REPLIES, STUB_REPLIES, chooseRepliesFile, main, parseExtractArgs, serviceClientFromEnv } from '../../worker/extract';
import { DEMO_REPLY_TABLE } from '../helpers/demoReplyTable';
import { memoryExtractStore } from '../helpers/memoryExtractStore';
import { modelReplyDouble } from '../helpers/modelReplyDouble';
import { RECORDING_PATH, STUB_PATH } from '../helpers/stubReplies';
import { DEMO_GRAPH_DIR } from './demoCorpus';

const only = (...present: string[]) => (p: string) => present.includes(p);

describe('chooseRepliesFile (worker/extract.ts)', () => {
  it('agrees with the paths the journey and the stub builder use', () => {
    expect(DEFAULT_REPLIES).toBe(RECORDING_PATH);
    expect(STUB_REPLIES).toBe(STUB_PATH);
  });

  it('prefers the owner\'s recording when it exists', () => {
    expect(chooseRepliesFile(null, only(DEFAULT_REPLIES, STUB_REPLIES))).toEqual({ path: DEFAULT_REPLIES, kind: 'recording' });
  });

  it('falls back to the stub when the recording is absent', () => {
    expect(chooseRepliesFile(null, only(STUB_REPLIES))).toEqual({ path: STUB_REPLIES, kind: 'stub' });
  });

  it('fails, naming both files, when neither exists', () => {
    expect(() => chooseRepliesFile(null, only())).toThrow(new RegExp(`${DEFAULT_REPLIES}.*${STUB_REPLIES}`));
  });

  it('uses the file it is given, and never falls back from it', () => {
    expect(chooseRepliesFile('x/replies.json', only('x/replies.json', STUB_REPLIES))).toEqual({ path: 'x/replies.json', kind: 'named' });
    expect(() => chooseRepliesFile('x/missing.json', only(STUB_REPLIES))).toThrow(/x\/missing\.json/);
  });

  it('fails setup with operator copy, which the CLI prints as is (#331)', () => {
    expect(() => chooseRepliesFile(null, only())).toThrow(OperatorCopyError);
    expect(() => chooseRepliesFile('x/missing.json', only())).toThrow(OperatorCopyError);
    expect(() => parseExtractArgs(['--transport', 'carrier-pigeon'])).toThrow(OperatorCopyError);
    expect(() => parseExtractArgs(['--replies'])).toThrow(OperatorCopyError);
    expect(() => parseExtractArgs(['--once', '--watch'])).toThrow(OperatorCopyError);
    expect(() => serviceClientFromEnv({} as NodeJS.ProcessEnv)).toThrow(OperatorCopyError);
  });
});

describe('parseExtractArgs --tenant (worker/extract.ts)', () => {
  const FAKE = '11111111-2222-4333-8444-555555555555';
  it('accepts a lowercase uuid and defaults to the dev tenant', () => {
    expect(parseExtractArgs(['--once', '--tenant', FAKE]).tenant).toBe(FAKE);
    expect(parseExtractArgs(['--once']).tenant).toBe(DEV_TENANT_ID);
  });
  it('refuses anything else with copy that names the flag, not the value', () => {
    // The fake has no letters, so its upper-case form is itself: end it in A to make an upper-case offence.
    for (const bad of ['t', `${FAKE.slice(0, -1)}A`, `${FAKE}x`, 'tn_demo']) {
      expect(() => parseExtractArgs(['--tenant', bad])).toThrow('--tenant must be a lowercase uuid');
    }
  });
  it('parses what the extract task runs: the entrypoint prepends --serve to the fixed command', () => {
    expect(parseExtractArgs(['--serve', '--tenant', FAKE, '--transport', 'gateway'])).toMatchObject({ watch: true, tenant: FAKE, transport: 'gateway' });
    // With extract_gateway_enabled off the command is the bare `extract`: the dev tenant on the recorded transport.
    expect(parseExtractArgs(['--serve'])).toMatchObject({ watch: true, tenant: DEV_TENANT_ID, transport: 'recorded' });
  });
});

describe('extract --estimate (worker/extract.ts)', () => {
  const FAKE = '11111111-2222-4333-8444-555555555555';
  it('runs alone', () => {
    expect(parseExtractArgs(['--estimate', '--tenant', FAKE])).toMatchObject({ estimate: true, tenant: FAKE });
    expect(parseExtractArgs(['--once'])).toMatchObject({ estimate: false });
    for (const extra of [['--once'], ['--watch'], ['--serve'], ['--transport', 'gateway'], ['--replies', 'x.json']]) {
      expect(() => parseExtractArgs(['--estimate', ...extra])).toThrow(OperatorCopyError);
    }
  });
  it('never builds a transport, reads no batch and prints one line of numbers', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const lines: string[] = [];
    const transportFor = vi.fn(() => {
      throw new Error('the dry run built a transport');
    });
    let batches = 0;
    const real = m.store.batch;
    m.store.batch = async (...a) => (batches++, real(...a));
    await main(['--estimate', '--tenant', FAKE], { transportFor, store: () => m.store, print: (l) => lines.push(l) });
    expect(transportFor).not.toHaveBeenCalled();
    expect(batches).toBe(0);
    expect(m.calls).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ model: 'anthropic/claude-sonnet-5', stats: { items: expect.any(Number) } });
  });
  it('counts the items a recorded pass then selects', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const lines: string[] = [];
    await main(['--estimate'], { transportFor: vi.fn(), store: () => m.store, print: (l) => lines.push(l) });
    const selected = (await m.store.batch('t', 'v1', 'm', 50)).length;
    expect(selected).toBeGreaterThan(0);
    expect(JSON.parse(lines[0]).stats.items).toBe(selected);
  });
});

describe('extract --watch stops on SIGTERM (worker/extract.ts)', () => {
  it('ends the wait at once, prints no further pass and returns normally', async () => {
    const m = memoryExtractStore(DEMO_GRAPH_DIR);
    const lines: string[] = [];
    let stop: () => void = () => undefined;
    const started = Date.now();
    await main(['--watch'], {
      transportFor: () => modelReplyDouble(DEMO_REPLY_TABLE),
      store: () => m.store,
      print: (l) => {
        lines.push(l);
        setTimeout(() => stop(), 10); // the signal lands while the loop waits between passes
      },
      onStop: (s) => (stop = s),
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ path: 'recorded', capped: null });
    expect(Date.now() - started).toBeLessThan(2000); // not the 3 s interval
  });
});
