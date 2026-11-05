import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OperatorCopyError } from '@/lib/errors/upstream';
import { ZDR_REFUSED_MESSAGE, __resetWarnOnceForTests } from '@/lib/modelGateway/gatewayClient';
import { gatewayTransport } from '@/lib/modelGateway/transports';

import { main } from '../../worker/extract';
import { memoryExtractStore } from '../helpers/memoryExtractStore';
import { DEMO_GRAPH_DIR } from './demoCorpus';

/*
 * A ZDR refusal stops the extract worker, not just its batch (#462). A failed
 * item becomes eligible again, so a watch loop that only ended the batch would
 * keep sending mail to a gateway that refuses zero data retention.
 */

const refusing = () =>
  vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({ type: 'error', error: { type: 'permission_denied', message: 'Zero Data Retention (ZDR) is only available for Pro and Enterprise plans' } }),
        { status: 403 },
      ),
  );

beforeEach(() => {
  __resetWarnOnceForTests();
  // The synthetic gateway path (the processor gate reads the environment).
  vi.stubEnv('DISCOVERY_EXTRACT_TRANSPORT', 'gateway');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:55521');
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'local');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function run(argv: string[]) {
  const m = memoryExtractStore(DEMO_GRAPH_DIR);
  const fetchImpl = refusing();
  const lines: string[] = [];
  const result = main(argv, {
    transportFor: () => gatewayTransport({ apiKey: 'k', fetchImpl }),
    store: () => m.store,
    print: (l) => lines.push(l),
    sleep: async () => {},
  });
  return { result, fetchImpl, lines, m };
}

describe('worker/extract.ts on a ZDR refusal', () => {
  it.each([
    ['--watch', ['--watch', '--transport', 'gateway']],
    ['--serve', ['--serve', '--transport', 'gateway']],
    ['--once', ['--once', '--transport', 'gateway']],
  ])('%s stops with operator copy (the entrypoint exits 1) after one model call: a 403 is never retried (D90)', async (_mode, argv) => {
    const { result, fetchImpl, lines, m } = await run(argv);
    await expect(result).rejects.toThrow(
      new OperatorCopyError('extract stopped: the AI Gateway refused zero data retention, so AI is off; nothing more is sent'),
    );
    // The run itself logged the shared refusal message once.
    expect(console.warn).toHaveBeenCalledWith(`[discovery_extract] ${ZDR_REFUSED_MESSAGE}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry, no second item, no second pass
    // The budget's estimate line (#261), then the one pass summary.
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toHaveProperty('estimate');
    expect(JSON.parse(lines[1])).toMatchObject({ sent: 1, failed: 1, stoppedBy: 'zdr_unavailable', capped: null });
    expect(m.calls).toHaveLength(1);
    expect(m.budget!.inflight.size).toBe(0); // settled before the stop
  });
});
